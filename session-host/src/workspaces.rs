//! `workspaces.list`: the control plane's snapshot of the checkouts under the
//! projects root (`workspaces.json`, published by the workspace sync every
//! half hour and after each clone), as protocol v1's `WorkspacesResult`.
//!
//! The snapshot is the control plane's envelope,
//! `{generatedAt, data: {root, workspaces: [{name, remote, branch, head,
//! headAt, dirty, ahead, behind, sync}]}}`. Each workspace's `path` is made
//! here, `<projectsRoot>/<name>`, and a name that is not one plain path
//! component is skipped: santree `cd`s into that path. A snapshot of another
//! root than this host's describes other checkouts and is served as none.
//!
//! `workspaces.icon` ([`icon`]): one workspace's app icon, which the control
//! plane exports into a directory of its own (the config's `workspaceIcons`).

use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use santree_remote_proto::{
    sniff_icon, ErrorCode, WireError, Workspace, WorkspaceIcon, WorkspaceSync, WorkspacesResult,
    WORKSPACE_ICON_MAX,
};
use serde::Deserialize;

/// The largest snapshot read; a real one is well under a kilobyte a clone.
const MAX_FILE: u64 = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    generated_at: Option<String>,
    data: Data,
}

#[derive(Deserialize)]
struct Data {
    root: String,
    workspaces: Vec<Row>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    name: String,
    remote: Option<String>,
    branch: Option<String>,
    head: Option<String>,
    head_at: Option<String>,
    #[serde(default)]
    dirty: bool,
    ahead: Option<u32>,
    behind: Option<u32>,
    sync: Option<WorkspaceSync>,
}

/// One plain component: not empty, `.`, `..`, an option, or anything with a
/// separator or a NUL in it.
fn plain_name(name: &str) -> bool {
    !(name.is_empty()
        || name == "."
        || name == ".."
        || name.starts_with('-')
        || name.contains('/')
        || name.contains('\0'))
}

/// The snapshot at `file`, for `root`. Missing: no snapshot yet (an empty
/// list, `generatedAt: null`). Unreadable or malformed: an error.
pub fn list(file: &Path, root: &Path) -> Result<WorkspacesResult, String> {
    let root_text = root.to_string_lossy().into_owned();
    let none = WorkspacesResult {
        root: root_text.clone(),
        generated_at: None,
        workspaces: Vec::new(),
    };
    let text = match std::fs::File::open(file) {
        Ok(f) => {
            let mut text = String::new();
            std::io::Read::read_to_string(&mut std::io::Read::take(f, MAX_FILE + 1), &mut text)
                .map_err(|e| format!("reading the workspaces snapshot: {e}"))?;
            if text.len() as u64 > MAX_FILE {
                return Err(format!("the workspaces snapshot is over {MAX_FILE} bytes"));
            }
            text
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(none),
        Err(e) => return Err(format!("reading the workspaces snapshot: {e}")),
    };
    let envelope: Envelope = serde_json::from_str(&text)
        .map_err(|e| format!("the workspaces snapshot is malformed: {e}"))?;
    if Path::new(&envelope.data.root) != root {
        log::warn!(
            "the workspaces snapshot is of {}, not {}; serving none",
            envelope.data.root,
            root.display()
        );
        return Ok(none);
    }
    let workspaces = envelope
        .data
        .workspaces
        .into_iter()
        .filter(|w| plain_name(&w.name))
        .map(|w| Workspace {
            path: root.join(&w.name).to_string_lossy().into_owned(),
            name: w.name,
            remote: w.remote,
            branch: w.branch,
            head: w.head,
            head_at: w.head_at,
            dirty: w.dirty,
            ahead: w.ahead,
            behind: w.behind,
            sync: w.sync,
        })
        .collect();
    Ok(WorkspacesResult {
        root: root_text,
        generated_at: envelope.generated_at,
        workspaces,
    })
}

// ── workspaces.icon ───────────────────────────────────────────────────────

/// The largest icon served ([`WORKSPACE_ICON_MAX`]); the app writes nothing
/// bigger either.
const MAX_ICON: u64 = WORKSPACE_ICON_MAX as u64;

/// The icon the control plane exported for workspace `name`: `dir/<name>.icon`
/// (app/src/host/workspace-icons.ts writes it). Missing, or not a file this
/// host will serve (a symlink, not a regular file, empty, over [`MAX_ICON`],
/// not a type [`sniff_icon`] knows): `not_found` — santree draws its own mark.
/// A name that is not one plain component: `bad_request`.
pub fn icon(dir: &Path, name: &str) -> Result<WorkspaceIcon, WireError> {
    if !plain_name(name) {
        return Err(WireError::new(
            ErrorCode::BadRequest,
            format!("{name:?} is not a workspace name"),
        ));
    }
    let none = || WireError::new(ErrorCode::NotFound, format!("no icon for {name}"));
    let path = dir.join(format!("{name}.icon"));
    // O_NOFOLLOW: the directory is another process's, so a link planted in
    // it is never followed; O_NONBLOCK: a FIFO there never pins this thread.
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(&path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(none()),
        Err(e) => {
            log::warn!("workspace icon {}: {e}", path.display());
            return Err(none());
        }
    };
    let meta = file
        .metadata()
        .map_err(|e| WireError::new(ErrorCode::Io, format!("{}: {e}", path.display())))?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_ICON {
        log::warn!(
            "workspace icon {}: not a regular file of 1..={MAX_ICON} bytes",
            path.display()
        );
        return Err(none());
    }
    let mut data = Vec::new();
    file.take(MAX_ICON + 1)
        .read_to_end(&mut data)
        .map_err(|e| WireError::new(ErrorCode::Io, format!("{}: {e}", path.display())))?;
    if data.len() as u64 > MAX_ICON {
        return Err(none());
    }
    let Some(content_type) = sniff_icon(&data) else {
        log::warn!(
            "workspace icon {}: not an image santree renders",
            path.display()
        );
        return Err(none());
    };
    Ok(WorkspaceIcon {
        content_type: content_type.to_string(),
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_that_are_not_one_component_are_refused() {
        for bad in ["", ".", "..", "-x", "a/b", "a\0"] {
            assert!(!plain_name(bad), "{bad:?}");
        }
        for good in ["web", ".dotted", "a..b", "x-1"] {
            assert!(plain_name(good), "{good:?}");
        }
    }

    #[test]
    fn icon_serves_the_exported_file_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
        std::fs::write(d.join("web.icon"), svg).unwrap();
        let got = icon(d, "web").unwrap();
        assert_eq!(
            (got.content_type.as_str(), got.data.as_slice()),
            ("image/svg+xml", &svg[..])
        );
        assert_eq!(
            serde_json::to_value(&got).unwrap(),
            serde_json::json!({"contentType": "image/svg+xml",
                "data": "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4="})
        );

        let code = |name: &str| icon(d, name).unwrap_err().code;
        assert_eq!(code("missing"), ErrorCode::NotFound);
        assert_eq!(code(".."), ErrorCode::BadRequest);
        assert_eq!(code("a/b"), ErrorCode::BadRequest);
        // A link is never followed, whatever it points at.
        std::os::unix::fs::symlink(d.join("web.icon"), d.join("link.icon")).unwrap();
        assert_eq!(code("link"), ErrorCode::NotFound);
        std::fs::create_dir(d.join("dir.icon")).unwrap();
        assert_eq!(code("dir"), ErrorCode::NotFound);
        std::fs::write(d.join("empty.icon"), b"").unwrap();
        assert_eq!(code("empty"), ErrorCode::NotFound);
        std::fs::write(d.join("html.icon"), b"<html>login</html>").unwrap();
        assert_eq!(code("html"), ErrorCode::NotFound);
        let mut big = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        big.resize(MAX_ICON as usize + 1, 0);
        std::fs::write(d.join("big.icon"), &big).unwrap();
        assert_eq!(code("big"), ErrorCode::NotFound);
        big.truncate(MAX_ICON as usize);
        std::fs::write(d.join("big.icon"), &big).unwrap();
        assert_eq!(icon(d, "big").unwrap().content_type, "image/png");
    }
}
