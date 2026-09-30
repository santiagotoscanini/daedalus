//! `fs.*`, and the confinement to the projects root.
//!
//! Confinement is a guardrail, not a boundary: a node that can `exec.run`
//! anything as the operator could write anywhere the operator can. What it
//! catches is a client bug — a terminal opened in `$HOME` because its worktree
//! was deleted (santree-pty would fall back silently), or an `fs.write` about
//! to land on `~/.ssh`. So it covers exactly: the `cwd` of `pty.open` and
//! `exec.run` (must exist, and resolve under the root) and the parent of an
//! `fs.write`. Reads and stats are not confined (`fs.read` has its own
//! `within`).

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use santree_remote_proto::{
    ErrorCode, FsKind, FsReadParams, FsReadResult, FsStat, FsWriteParams, WireError, FS_READ_MAX,
};

fn err(code: ErrorCode, msg: impl Into<String>) -> WireError {
    WireError::new(code, msg)
}

pub fn io_err(e: std::io::Error, what: &str) -> WireError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        _ => ErrorCode::Io,
    };
    err(code, format!("{what}: {e}"))
}

pub fn absolute(path: &str, what: &str) -> Result<PathBuf, WireError> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(err(
            ErrorCode::BadRequest,
            format!("{what} must be absolute"),
        ))
    }
}

/// The projects root. Its real path is resolved at each check, so a root made
/// (or remounted) after the host started is followed.
#[derive(Debug, Clone)]
pub struct Root {
    path: PathBuf,
}

impl Root {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn real(&self) -> Result<PathBuf, WireError> {
        self.path
            .canonicalize()
            .map_err(|e| io_err(e, &format!("the projects root {}", self.path.display())))
    }

    fn outside(&self, what: &str, shown: &str) -> WireError {
        err(
            ErrorCode::Outside,
            format!("{what} {shown} is outside {}", self.path.display()),
        )
    }

    /// A working directory: required, an existing directory, under the root.
    /// The real path is what the process gets.
    pub fn cwd(&self, cwd: Option<&str>) -> Result<PathBuf, WireError> {
        let Some(cwd) = cwd.filter(|c| !c.is_empty()) else {
            return Err(err(ErrorCode::BadRequest, "cwd is required"));
        };
        let real = absolute(cwd, "cwd")?
            .canonicalize()
            .map_err(|e| io_err(e, cwd))?;
        if !real.starts_with(self.real()?) {
            return Err(self.outside("cwd", cwd));
        }
        if !real.is_dir() {
            return Err(err(ErrorCode::Io, format!("{cwd} is not a directory")));
        }
        Ok(real)
    }

    /// Where an `fs.write` to `path` lands: its parent, made when missing,
    /// under the root; the real parent joined with the file name. The nearest
    /// existing ancestor is checked before anything is made, and the parent
    /// again after.
    pub fn write_target(&self, path: &str) -> Result<PathBuf, WireError> {
        let full = absolute(path, "path")?;
        let (Some(parent), Some(name)) = (full.parent(), full.file_name()) else {
            return Err(err(ErrorCode::BadRequest, "path has no file name"));
        };
        let existing = parent
            .ancestors()
            .find(|a| a.exists())
            .unwrap_or(Path::new("/"));
        let root = self.real()?;
        let real = existing
            .canonicalize()
            .map_err(|e| io_err(e, &existing.to_string_lossy()))?;
        if !real.starts_with(&root) {
            return Err(self.outside("path", path));
        }
        std::fs::create_dir_all(parent).map_err(|e| io_err(e, &parent.to_string_lossy()))?;
        let real = parent
            .canonicalize()
            .map_err(|e| io_err(e, &parent.to_string_lossy()))?;
        if !real.starts_with(&root) {
            return Err(self.outside("path", path));
        }
        Ok(real.join(name))
    }
}

pub fn read(p: &FsReadParams) -> Result<FsReadResult, WireError> {
    let path = absolute(&p.path, "path")?;
    let path = match &p.within {
        Some(within) => {
            let root = absolute(within, "within")?
                .canonicalize()
                .map_err(|e| io_err(e, within))?;
            let real = path.canonicalize().map_err(|e| io_err(e, &p.path))?;
            if !real.starts_with(&root) {
                return Err(err(
                    ErrorCode::Outside,
                    format!("{} resolves outside {within}", p.path),
                ));
            }
            // Read the resolved path, so a swap after the check can't escape.
            real
        }
        None => path,
    };
    let mut file = std::fs::File::open(&path).map_err(|e| io_err(e, &p.path))?;
    let meta = file.metadata().map_err(|e| io_err(e, &p.path))?;
    if meta.is_dir() {
        return Err(err(ErrorCode::Io, format!("{} is a directory", p.path)));
    }
    let size = meta.len();
    let start = match p.offset.unwrap_or(0) {
        offset if offset < 0 => size.saturating_sub(offset.unsigned_abs()),
        offset => (offset as u64).min(size),
    };
    let len = p.len.unwrap_or(FS_READ_MAX).min(FS_READ_MAX);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| io_err(e, &p.path))?;
    let mut data = Vec::new();
    file.take(len)
        .read_to_end(&mut data)
        .map_err(|e| io_err(e, &p.path))?;
    let eof = start + data.len() as u64 >= size;
    Ok(FsReadResult { data, size, eof })
}

/// Write `p.data` to `target` (from [`Root::write_target`]) atomically: a
/// temp file beside it, then a rename.
pub fn write(p: &FsWriteParams, target: &Path) -> Result<(), WireError> {
    use std::os::unix::fs::PermissionsExt;
    static TEMP: AtomicU64 = AtomicU64::new(0);
    let (Some(parent), Some(name)) = (target.parent(), target.file_name()) else {
        return Err(err(ErrorCode::BadRequest, "path has no file name"));
    };
    let temp = parent.join(format!(
        ".{}.santree-{}-{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&p.data)?;
        file.sync_all()?;
        let mode = match p.mode {
            Some(mode) => Some(mode),
            None => std::fs::metadata(target)
                .ok()
                .map(|m| m.permissions().mode()),
        };
        if let Some(mode) = mode {
            std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(mode & 0o7777))?;
        }
        std::fs::rename(&temp, target)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(io_err(e, &p.path));
    }
    Ok(())
}

pub fn stat(path: &str) -> Result<FsStat, WireError> {
    let full = absolute(path, "path")?;
    let meta = match std::fs::symlink_metadata(&full) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(FsStat::default()),
        Err(e) => return Err(io_err(e, path)),
    };
    let kind = if meta.file_type().is_symlink() {
        FsKind::Symlink
    } else if meta.is_dir() {
        FsKind::Dir
    } else if meta.is_file() {
        FsKind::File
    } else {
        FsKind::Other
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(FsStat {
        exists: true,
        kind: Some(kind),
        size: meta.len(),
        mtime_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_and_write_parent_stay_under_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("projects");
        std::fs::create_dir_all(root_path.join("web/src")).unwrap();
        std::fs::create_dir_all(dir.path().join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("elsewhere"), root_path.join("escape")).unwrap();
        let root = Root::new(root_path.clone());
        let s = |p: &Path| p.to_string_lossy().into_owned();

        assert_eq!(
            root.cwd(Some(&s(&root_path.join("web")))).unwrap(),
            root_path.canonicalize().unwrap().join("web")
        );
        let code = |r: Result<PathBuf, WireError>| r.unwrap_err().code;
        assert_eq!(code(root.cwd(None)), ErrorCode::BadRequest);
        assert_eq!(code(root.cwd(Some("web"))), ErrorCode::BadRequest);
        assert_eq!(
            code(root.cwd(Some(&s(&root_path.join("web/../..")))),),
            ErrorCode::Outside
        );
        assert_eq!(
            code(root.cwd(Some(&s(&root_path.join("escape"))))),
            ErrorCode::Outside
        );
        assert_eq!(
            code(root.cwd(Some(&s(&root_path.join("missing"))))),
            ErrorCode::NotFound
        );
        std::fs::write(root_path.join("web/file"), b"x").unwrap();
        assert_eq!(
            code(root.cwd(Some(&s(&root_path.join("web/file"))))),
            ErrorCode::Io
        );

        // A new directory under the root is made; one through the symlink is
        // refused before anything is created.
        let target = root
            .write_target(&s(&root_path.join("web/new/deep/f.txt")))
            .unwrap();
        assert!(target.parent().unwrap().is_dir());
        assert_eq!(
            code(root.write_target(&s(&root_path.join("escape/sub/f.txt")))),
            ErrorCode::Outside
        );
        assert!(!dir.path().join("elsewhere/sub").exists());
        assert_eq!(
            code(root.write_target(&s(&dir.path().join("elsewhere/f.txt")))),
            ErrorCode::Outside
        );
        // The file itself may be a symlink out: the rename replaces the link.
        std::os::unix::fs::symlink(
            dir.path().join("elsewhere/target"),
            root_path.join("web/link"),
        )
        .unwrap();
        let t = root.write_target(&s(&root_path.join("web/link"))).unwrap();
        let p = FsWriteParams {
            path: s(&root_path.join("web/link")),
            data: b"hi".to_vec(),
            mode: None,
        };
        write(&p, &t).unwrap();
        assert!(!dir.path().join("elsewhere/target").exists());
        assert_eq!(std::fs::read(root_path.join("web/link")).unwrap(), b"hi");
    }
}
