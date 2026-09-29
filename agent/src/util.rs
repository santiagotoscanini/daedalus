//! Small helpers the agent's threads share.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Sleep in short steps so a stop request is honoured within half a second.
/// Returns true when stopped. For threads with nothing else to wake for
/// (the hello and the telemetry sampler; the updater has its own, which a
/// "check now" also cuts short).
pub fn sleep_until(stop: &AtomicBool, total: Duration) -> bool {
    let step = Duration::from_millis(500);
    let mut left = total;
    while !left.is_zero() {
        if stop.load(Ordering::Relaxed) {
            return true;
        }
        let d = left.min(step);
        std::thread::sleep(d);
        left -= d;
    }
    stop.load(Ordering::Relaxed)
}

/// Who may read a file `write_atomic` writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// Whatever the directory and the umask give.
    Inherit,
    /// This unix mode, whatever the umask took off; Windows inherits the
    /// directory's ACL.
    Mode(u32),
    /// The owner alone: 0600 on unix; on Windows an explicit, protected
    /// ACL — SYSTEM and Administrators, nothing inherited — set as the
    /// file is created, never after (`os::create_private`).
    Private,
}

/// Replace `path` with `bytes` so a reader — or a crash, or a power cut —
/// sees the old file or the new one, never a torn one: written to a
/// temporary file beside it that did not exist before (so a planted
/// symlink or a file someone else opened is never written through),
/// flushed to disk, renamed over it, and on unix the directory flushed
/// too. Every file the agent writes goes through here.
pub fn write_atomic(path: &Path, bytes: &[u8], access: Access) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    // One of ours from a run that died mid-write; `create_new` below
    // refuses whatever is there, ours or not.
    let _ = std::fs::remove_file(&tmp);
    let written = (|| {
        let mut f = match access {
            Access::Private => crate::os::create_private(&tmp)?,
            Access::Inherit | Access::Mode(_) => {
                let mut opts = std::fs::OpenOptions::new();
                opts.write(true).create_new(true);
                #[cfg(unix)]
                if let Access::Mode(m) = access {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.mode(m);
                }
                opts.open(&tmp)?
            }
        };
        f.write_all(bytes)?;
        #[cfg(unix)]
        if let Access::Mode(m) = access {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(std::fs::Permissions::from_mode(m))?;
        }
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written?;
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_raised_stop_ends_the_wait_at_once() {
        let stop = AtomicBool::new(true);
        let t = std::time::Instant::now();
        assert!(sleep_until(&stop, Duration::from_secs(30)));
        assert!(t.elapsed() < Duration::from_secs(1));
        assert!(!sleep_until(&AtomicBool::new(false), Duration::ZERO));
    }

    #[test]
    fn an_atomic_write_replaces_the_file_whole_and_leaves_no_temporary() {
        let dir = std::env::temp_dir().join(format!("daedalus-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("state.json");
        write_atomic(&p, b"one", Access::Inherit).unwrap();
        write_atomic(&p, b"two", Access::Private).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let m = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(m, 0o600);
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A symlink planted where a private file goes is replaced, never
    /// written through, and the file is 0600 whatever the umask.
    #[cfg(unix)]
    #[test]
    fn a_private_write_never_follows_a_planted_link() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("daedalus-plant-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let victim = dir.join("victim");
        std::fs::write(&victim, b"untouched").unwrap();
        let key = dir.join("identity.key");
        std::os::unix::fs::symlink(&victim, &key).unwrap();
        write_atomic(&key, b"secret", Access::Private).unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"untouched");
        let m = std::fs::symlink_metadata(&key).unwrap();
        assert!(m.file_type().is_file());
        assert_eq!(m.permissions().mode() & 0o777, 0o600);
        // A key others could read is refused.
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(crate::os::ensure_private(&key).is_err());
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(crate::os::ensure_private(&key).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
