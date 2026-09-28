//! Rotating a log while something still writes to it.
//!
//! systemd opens a unit's `StandardOutput=append:` file once, at the start,
//! and writes through that descriptor for as long as the unit runs — so the
//! usual rename-and-reopen rotation would leave the server writing into the
//! renamed file forever. Instead the file is COPIED to `<name>.1` (the one
//! old file kept, replaced each time) and then TRUNCATED in place: an
//! `O_APPEND` writer's next write lands at the new end, which is 0, so the
//! descriptor keeps working and nothing reopens anything. The same holds for
//! a child's log the session opened for appending itself.
//!
//! The price, stated: a line written between the copy and the truncation is
//! in neither file. The window is one copy of `ROTATE_BYTES`; the readers
//! (`LogTail`) take a file shorter than their offset as truncated and read
//! it again from the start.

use std::fs::OpenOptions;
use std::io;
use std::path::{Path, PathBuf};

/// A log past this is rotated.
pub const ROTATE_BYTES: u64 = 20 * 1024 * 1024;

/// Where the one old file goes: `claude-rc.log` → `claude-rc.log.1`.
pub fn old_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".1");
    path.with_file_name(name)
}

/// Copy-then-truncate `path` when it is larger than `threshold` (module
/// doc). Ok(true) when it rotated; a missing file is Ok(false).
pub fn rotate_if_larger(path: &Path, threshold: u64) -> io::Result<bool> {
    let len = match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_file() => m.len(),
        // A link or a directory is not a log this agent writes.
        Ok(_) => return Ok(false),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    if len <= threshold {
        return Ok(false);
    }
    let old = old_path(path);
    // Into a temporary name first, so a reader of `.1` never sees half.
    let mut tmp = old.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::copy(path, &tmp)?;
    std::fs::rename(&tmp, &old)?;
    OpenOptions::new().write(true).open(path)?.set_len(0)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn an_appending_writer_keeps_writing_after_the_rotation() {
        let dir = std::env::temp_dir().join(format!("daedalus-logs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("claude-rc.log");
        // What systemd holds: one descriptor opened for appending.
        let mut w = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log)
            .unwrap();
        w.write_all(&[b'a'; 64]).unwrap();
        assert!(!rotate_if_larger(&log, 100).unwrap(), "under the threshold");
        w.write_all(&[b'b'; 64]).unwrap();
        assert!(rotate_if_larger(&log, 100).unwrap());
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 0);
        let old = std::fs::read(old_path(&log)).unwrap();
        assert_eq!(old.len(), 128);
        // The same descriptor, after: at the new end, not at byte 128 with a
        // hole of zeroes before it.
        w.write_all(b"after\n").unwrap();
        assert_eq!(std::fs::read(&log).unwrap(), b"after\n");
        // Once more: the one old file is replaced, not kept beside.
        w.write_all(&[b'c'; 200]).unwrap();
        assert!(rotate_if_larger(&log, 100).unwrap());
        assert_eq!(std::fs::read(old_path(&log)).unwrap().len(), 206);
        assert!(!dir.join("claude-rc.log.1.tmp").exists());
        assert!(!dir.join("claude-rc.log.2").exists());
        assert!(!rotate_if_larger(&dir.join("absent.log"), 1).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
