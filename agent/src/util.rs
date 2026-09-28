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

/// Replace `path` with `bytes` so a reader — or a crash, or a power cut —
/// sees the old file or the new one, never a torn one: written to a
/// temporary file beside it, flushed to disk, renamed over it, and on unix
/// the directory flushed too. `mode` is the new file's on unix (the
/// default umask's when None); Windows takes the directory's ACL.
pub fn write_atomic(path: &Path, bytes: &[u8], mode: Option<u32>) -> std::io::Result<()> {
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
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        if let Some(m) = mode {
            opts.mode(m);
        }
    }
    #[cfg(not(unix))]
    let _ = mode;
    let written = (|| {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        #[cfg(unix)]
        if let Some(m) = mode {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(m))?;
        }
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
        write_atomic(&p, b"one", None).unwrap();
        write_atomic(&p, b"two", Some(0o600)).unwrap();
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
}
