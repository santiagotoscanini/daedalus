//! `host.key`: this host's ed25519 identity, as a 32-byte seed in a 0600 file
//! of its state directory, made on the first start. Every node pins its public
//! half; a restore of the state directory brings the same key back.

use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use santree_remote_tls::Identity;

/// Load the key at `path`, or make it when there is none. A key file that is
/// not this process's, not a regular file, readable by anyone else, or not
/// exactly 32 bytes is refused, never replaced.
pub fn load_or_create(path: &Path) -> Result<Identity, String> {
    let shown = path.display();
    let mut file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return create(path),
        Err(e) => return Err(format!("{shown}: {e}")),
    };
    let meta = file.metadata().map_err(|e| format!("{shown}: {e}"))?;
    // SAFETY: geteuid(2) cannot fail.
    let me = unsafe { libc::geteuid() };
    if !meta.file_type().is_file() || meta.uid() != me || meta.mode() & 0o077 != 0 {
        return Err(format!(
            "{shown}: must be a regular file of uid {me} with mode 0600 (is uid {}, mode {:o})",
            meta.uid(),
            meta.mode() & 0o7777
        ));
    }
    let mut seed = [0u8; 32];
    let mut rest = Vec::new();
    file.read_exact(&mut seed)
        .and_then(|()| file.read_to_end(&mut rest))
        .map_err(|e| format!("{shown}: {e}"))?;
    if !rest.is_empty() {
        return Err(format!("{shown}: longer than a 32-byte seed"));
    }
    Ok(Identity::from_seed(&seed))
}

fn create(path: &Path) -> Result<Identity, String> {
    let shown = path.display();
    let mut seed = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut seed))
        .map_err(|e| format!("reading /dev/urandom: {e}"))?;
    // Written whole to a temp file (O_EXCL, 0600) and fsynced, then linked
    // into place: a crash never leaves a short key behind (which every later
    // start would refuse), and link(2) fails rather than replace a key
    // another start made meanwhile — that one is then loaded.
    let temp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        std::process::id()
    ));
    let _ = std::fs::remove_file(&temp);
    let made = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        file.write_all(&seed)?;
        file.sync_all()?;
        std::fs::hard_link(&temp, path)
    })();
    let _ = std::fs::remove_file(&temp);
    match made {
        Ok(()) => {
            if let Some(dir) = path.parent() {
                let _ = std::fs::File::open(dir).and_then(|d| d.sync_all());
            }
            log::info!("made a new host key at {shown:?}");
            Ok(Identity::from_seed(&seed))
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => load_or_create(path),
        Err(e) => Err(format!("creating {shown}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn made_once_then_loaded_and_bad_files_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.key");
        let made = load_or_create(&path).unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        assert_eq!(meta.len(), 32);
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(
            load_or_create(&path).unwrap().public_key(),
            made.public_key()
        );

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(load_or_create(&path).unwrap_err().contains("mode 0600"));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&path, [0u8; 33]).unwrap();
        assert!(load_or_create(&path).unwrap_err().contains("32-byte"));

        let link = dir.path().join("link.key");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(load_or_create(&link).is_err());
    }
}
