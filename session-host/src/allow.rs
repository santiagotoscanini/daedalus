//! The allow-list: the keys of the nodes (daedalus agents) this host admits.
//!
//! The controller writes it — every approved node whose policy turns santree
//! on — atomically (temp file + rename) into its own directory; this host only
//! reads it. The file (README.md, "The allow-list"):
//!
//! ```json
//! {"schemaVersion": 1,
//!  "nodes": [{"id": "0123456789abcdef", "publicKey": "<64 hex>"}]}
//! ```
//!
//! `id` is the node id (the first sixteen hex characters of the key's SHA-256,
//! as the agent derives it) and must match the key. Unknown keys are ignored.
//!
//! **Reading it** ([`AllowList::watch`], a thread): the file's
//! `(inode, mtime_ns, len)` is looked at every [`POLL`]; a change is re-read.
//! The atomic rename always changes the inode, so no rewrite is missed.
//!
//! - missing: the empty set (fail closed);
//! - not a regular file, not this process's owner, group/other-writable, or
//!   over [`MAX_FILE`]: the empty set (fail closed) — something other than
//!   the controller could have written it;
//! - malformed: the last good set stays, and the reason is logged — the
//!   controller writes whole files, so this is a bug, not a revocation.
//!
//! Each change is published on a `watch` channel. The TLS handshake checks the
//! current set ([`AllowList::allows`]); every connection subscribes and closes
//! when its key leaves the set, and the daemon closes that node's PTYs.

use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::watch;

/// How often the file is looked at.
pub const POLL: Duration = Duration::from_secs(1);
/// The largest allow-list read; a real one is a few hundred bytes a node.
pub const MAX_FILE: u64 = 1024 * 1024;

/// A node id: sixteen lowercase hex characters of its key's SHA-256.
pub fn node_id_of(key: &[u8; 32]) -> String {
    ring::digest::digest(&ring::digest::SHA256, key).as_ref()[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// One version of the set: node id by key.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AllowSet {
    nodes: HashMap<[u8; 32], String>,
}

impl AllowSet {
    /// The node id of `key`, when it is admitted.
    pub fn node_of(&self, key: &[u8; 32]) -> Option<&str> {
        self.nodes.get(key).map(String::as_str)
    }

    pub fn contains_node(&self, id: &str) -> bool {
        self.nodes.values().any(|n| n == id)
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// Parse and check the file's text.
    pub fn parse(text: &str) -> Result<Self, String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct File {
            schema_version: u32,
            nodes: Vec<Entry>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Entry {
            id: String,
            public_key: String,
        }
        let file: File = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if file.schema_version != 1 {
            return Err(format!(
                "schemaVersion {} is not supported (1 is)",
                file.schema_version
            ));
        }
        let mut nodes = HashMap::new();
        let mut ids = HashSet::new();
        for entry in file.nodes {
            let key = santree_remote_tls::parse_key_hex(&entry.public_key)
                .ok_or_else(|| format!("node {:?}: publicKey is not 64 hex", entry.id))?;
            let id = node_id_of(&key);
            if entry.id != id {
                return Err(format!("node {:?}: the id of that key is {id}", entry.id));
            }
            if !ids.insert(id.clone()) {
                return Err(format!("node {id} is listed twice"));
            }
            nodes.insert(key, id);
        }
        Ok(Self { nodes })
    }
}

/// What one look at the file found.
#[derive(Debug)]
enum Read {
    Missing,
    /// Fail closed: the file is there but not one to trust.
    Refused(String),
    Malformed(String),
    Good(AllowSet),
}

/// The file's identity: a rename, a rewrite or a truncation changes it.
type Stamp = (u64, i64, u64);

fn stamp(meta: &std::fs::Metadata) -> Stamp {
    (
        meta.ino(),
        meta.mtime() * 1_000_000_000 + meta.mtime_nsec(),
        meta.len(),
    )
}

fn look(path: &Path) -> (Option<Stamp>, Read) {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (None, Read::Missing),
        Err(e) => return (None, Read::Refused(e.to_string())),
    };
    let at = Some(stamp(&meta));
    // SAFETY: geteuid(2) cannot fail.
    let me = unsafe { libc::geteuid() };
    if !meta.file_type().is_file() {
        return (at, Read::Refused("not a regular file".into()));
    }
    if meta.uid() != me {
        return (
            at,
            Read::Refused(format!("owned by uid {}, not {me}", meta.uid())),
        );
    }
    if meta.mode() & 0o022 != 0 {
        return (
            at,
            Read::Refused(format!(
                "mode {:o} is group/other-writable",
                meta.mode() & 0o777
            )),
        );
    }
    if meta.len() > MAX_FILE {
        return (at, Read::Refused(format!("over {MAX_FILE} bytes")));
    }
    match std::fs::read_to_string(path) {
        Ok(text) => match AllowSet::parse(&text) {
            Ok(set) => (at, Read::Good(set)),
            Err(e) => (at, Read::Malformed(e)),
        },
        Err(e) => (at, Read::Malformed(e.to_string())),
    }
}

/// The live set, and the file it comes from.
pub struct AllowList {
    path: PathBuf,
    tx: watch::Sender<Arc<AllowSet>>,
}

impl AllowList {
    /// Read the file once, now; [`watch`](Self::watch) keeps it current.
    pub fn open(path: PathBuf) -> Arc<Self> {
        let (tx, _) = watch::channel(Arc::new(AllowSet::default()));
        let list = Arc::new(Self { path, tx });
        let mut last = None;
        list.apply(&mut last, true);
        list
    }

    /// The node id `key` belongs to, if the current set admits it.
    pub fn node_of(&self, key: &[u8; 32]) -> Option<String> {
        self.tx.borrow().node_of(key).map(str::to_string)
    }

    pub fn current(&self) -> Arc<AllowSet> {
        self.tx.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<Arc<AllowSet>> {
        self.tx.subscribe()
    }

    /// Read the file now, without waiting for the poll.
    #[cfg(test)]
    pub(crate) fn reload(&self) {
        self.apply(&mut None, true);
    }

    /// Poll the file every [`POLL`] on a thread of its own, for the life of
    /// the process.
    pub fn watch(self: &Arc<Self>) -> std::io::Result<()> {
        let list = self.clone();
        std::thread::Builder::new()
            .name("allow-list".into())
            .spawn(move || {
                let mut last = std::fs::symlink_metadata(&list.path)
                    .ok()
                    .map(|m| stamp(&m));
                loop {
                    std::thread::sleep(POLL);
                    list.apply(&mut last, false);
                }
            })
            .map(|_| ())
    }

    /// Look at the file; act on it when it changed since `last` (or always,
    /// the first time).
    fn apply(&self, last: &mut Option<Stamp>, first: bool) {
        let (at, read) = look(&self.path);
        if !first && at == *last {
            return;
        }
        *last = at;
        let path = self.path.display();
        let next = match read {
            Read::Good(set) => {
                log::info!("allow-list {path}: {} node(s)", set.len());
                set
            }
            Read::Missing => {
                log::info!("allow-list {path}: missing; no node is admitted");
                AllowSet::default()
            }
            Read::Refused(why) => {
                log::error!("allow-list {path}: refused ({why}); no node is admitted");
                AllowSet::default()
            }
            Read::Malformed(why) => {
                log::error!("allow-list {path}: malformed ({why}); keeping the last good set");
                return;
            }
        };
        self.tx.send_if_modified(|current| {
            if **current == next {
                false
            } else {
                *current = Arc::new(next);
                true
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// RFC 8032 §7.1 TEST 1's public key, and its node id (the agent's
    /// `node_id_of`: the first sixteen hex of its SHA-256).
    const KEY: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const ID: &str = "21fe31dfa154a261";

    fn doc(entries: &[(&str, &str)]) -> String {
        let nodes: Vec<String> = entries
            .iter()
            .map(|(id, key)| format!(r#"{{"id":"{id}","publicKey":"{key}"}}"#))
            .collect();
        format!(r#"{{"schemaVersion":1,"nodes":[{}]}}"#, nodes.join(","))
    }

    #[test]
    fn node_ids_are_the_agents() {
        let key = santree_remote_tls::parse_key_hex(KEY).unwrap();
        assert_eq!(node_id_of(&key), ID);
    }

    #[test]
    fn parses_and_checks_entries() {
        let key = santree_remote_tls::parse_key_hex(KEY).unwrap();
        let set = AllowSet::parse(&doc(&[(ID, KEY)])).unwrap();
        assert_eq!(set.node_of(&key), Some(ID));
        assert!(set.contains_node(ID));
        // Upper-case hex is the same key; unknown fields are ignored.
        let upper = AllowSet::parse(&doc(&[(ID, &KEY.to_uppercase())])).unwrap();
        assert_eq!(upper, set);
        assert!(AllowSet::parse(r#"{"schemaVersion":1,"nodes":[],"x":1}"#)
            .unwrap()
            .is_empty());

        for (bad, why) in [
            (doc(&[("0000000000000000", KEY)]), "the id of that key"),
            (doc(&[(ID, "00")]), "not 64 hex"),
            (doc(&[(ID, KEY), (ID, KEY)]), "listed twice"),
            (
                r#"{"schemaVersion":2,"nodes":[]}"#.into(),
                "schemaVersion 2",
            ),
            ("{".into(), "EOF"),
        ] {
            let e = AllowSet::parse(&bad).unwrap_err();
            assert!(e.contains(why), "{bad}: {e}");
        }
    }

    #[test]
    fn missing_fails_closed_malformed_keeps_the_last_good_and_bad_modes_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("allow.json");
        let key = santree_remote_tls::parse_key_hex(KEY).unwrap();

        let list = AllowList::open(path.clone());
        assert!(list.current().is_empty());

        // As the controller writes it: a temp file renamed over the old one.
        let write_mode = |text: &str, mode: u32| {
            let temp = dir.path().join("t");
            std::fs::write(&temp, text).unwrap();
            std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(mode)).unwrap();
            std::fs::rename(&temp, &path).unwrap();
        };
        let write = |text: &str| write_mode(text, 0o600);
        let mut last = None;
        write(&doc(&[(ID, KEY)]));
        list.apply(&mut last, false);
        assert_eq!(list.node_of(&key).as_deref(), Some(ID));

        write("{ not json");
        list.apply(&mut last, false);
        assert_eq!(list.node_of(&key).as_deref(), Some(ID), "kept");

        write_mode(&doc(&[(ID, KEY)]), 0o622);
        list.apply(&mut last, false);
        assert!(list.current().is_empty(), "group-writable fails closed");

        write(&doc(&[(ID, KEY)]));
        list.apply(&mut last, false);
        assert!(!list.current().is_empty());
        std::fs::remove_file(&path).unwrap();
        list.apply(&mut last, false);
        assert!(list.current().is_empty(), "missing fails closed");

        std::os::unix::fs::symlink(dir.path().join("elsewhere"), &path).unwrap();
        list.apply(&mut last, false);
        assert!(list.current().is_empty(), "a symlink is refused");
    }
}
