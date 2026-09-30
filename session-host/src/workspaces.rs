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

use std::path::Path;

use santree_remote_proto::{Workspace, WorkspaceSync, WorkspacesResult};
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
}
