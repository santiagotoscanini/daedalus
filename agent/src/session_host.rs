//! The controller's side of the session host (session-host/ in the engine,
//! nix's `session-host.nix`): the box's server for santree's remote
//! projects, which admits the approved machines whose policy turns santree
//! on. The controller keeps it in step with the app's decisions through two
//! files, both named by `[controller.session_host]` (config.rs), and the
//! host is never asked anything else.
//!
//! **The allow-list** (`AllowList`), written here and read by the host every
//! second: `{"schemaVersion": 1, "nodes": [{"id", "publicKey"}]}`, every
//! entry of the app's set that is approved with santree on, sorted by id.
//! Written from `Registry::set_desired` — the one path every approval,
//! revocation, forgetting and policy change takes — atomically (a temp file
//! renamed over it), 0600, as the controller's user (the host runs as the
//! same one and refuses a file that is not its uid's), and only when the
//! bytes differ. Never before the first `set_desired` after a start: the
//! registry's set is empty until the app pushes, and writing that would
//! cut every live terminal across a controller restart; the file on disk
//! stays valid until then. So a revocation made while the controller is
//! down, or while it refuses the app's set, reaches the host with the next
//! set it takes. The write comes before the policy events the same set
//! sends, so a machine told santree is on finds itself in the file (give
//! or take the host's one-second look). The registry takes the set
//! regardless of the write — the control link's standing never waits on
//! this file — so a write that fails must not leave the host admitting a
//! machine the set revoked: when the file on disk admits anyone the new set
//! does not (or cannot be read), it is removed, and the host reads a
//! missing file as nobody (fail closed; an unlink needs no free space).
//! A failed write that only adds machines leaves the file as it is: it
//! revokes nothing, and removing it would cut every live terminal. Either
//! way the set is kept as pending and written again every `POLL` (from the
//! status thread) until a write succeeds, and `santree.status` says
//! revocations are not reaching the host meanwhile. The file is left alone
//! only when it already holds these bytes as a regular 0600 file of this
//! user, which the host accepts.
//!
//! **The status file** (`SessionHost`), written by the host at least every
//! 10 s and read here every `POLL`: its state, version, running build
//! (`exe`), key, connections by node and live PTYs. Read only when it is a
//! regular file of at most `MAX_FILE` bytes, owned by root or this user and
//! writable by nobody else; its fields are read leniently, so a newer host's
//! additions pass. The key it names (`hostKey`, in the `stopped` file too)
//! is handed to every santree machine with its policy
//! (`Registry::set_session_host`): a new key re-sends it at once.
//! `santree.status` answers from the last read.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::api::wire::{DesiredState, SantreeConnections, SantreeStatus, SessionHostState};
use crate::config::SessionHostConfig;
use crate::link::controller::{DesiredEntry, Registry};
use crate::link::wire::SessionHost as Pin;
use crate::util::{LockExt, Shutdown};

/// How often the status file is read.
pub const POLL: Duration = Duration::from_secs(2);
/// A running host's file older than this is `stale`: the host writes at
/// least every 10 s.
pub const STALE_AFTER: Duration = Duration::from_secs(30);
/// The largest status file read.
pub const MAX_FILE: u64 = 1024 * 1024;

// ── the allow-list ────────────────────────────────────────────────────────

/// The allow-list file (module doc). Its writes — a new set's and the
/// retries — are serialised by `state`; the registry calls `write` in the
/// order the sets came.
pub struct AllowList {
    path: PathBuf,
    state: Mutex<AllowState>,
}

#[derive(Default)]
struct AllowState {
    /// The bytes the file must hold, while no write of them has succeeded.
    pending: Option<Vec<u8>>,
    /// Why the last write failed; None once one succeeds.
    error: Option<String>,
}

/// The file's entries, as a set, to tell a revoking set from an adding one.
fn entries(bytes: &[u8]) -> Option<std::collections::BTreeSet<(String, String)>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct File {
        nodes: Vec<Node>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Node {
        id: String,
        public_key: String,
    }
    let file: File = serde_json::from_slice(bytes).ok()?;
    Some(
        file.nodes
            .into_iter()
            .map(|n| (n.id, n.public_key.to_ascii_lowercase()))
            .collect(),
    )
}

impl AllowList {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Mutex::new(AllowState::default()),
        }
    }

    /// The file's bytes for the app's set: every approved entry with santree
    /// on, sorted by id.
    pub fn render(set: &[DesiredEntry]) -> Vec<u8> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct File<'a> {
            schema_version: u32,
            nodes: Vec<Node<'a>>,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Node<'a> {
            id: &'a str,
            public_key: String,
        }
        let mut nodes: Vec<Node> = set
            .iter()
            .filter(|d| d.state == DesiredState::Approved && d.policy.santree)
            .map(|d| Node {
                id: &d.id,
                public_key: hex::encode(d.public_key),
            })
            .collect();
        nodes.sort_by(|a, b| a.id.cmp(b.id));
        let mut bytes = serde_json::to_vec_pretty(&File {
            schema_version: 1,
            nodes,
        })
        .expect("the allow-list serialises");
        bytes.push(b'\n');
        bytes
    }

    /// Make the file say `set`, when it does not already (module doc).
    pub fn write(&self, set: &[DesiredEntry]) {
        let mut st = self.state.lock_ok();
        st.pending = Some(Self::render(set));
        self.flush(&mut st);
    }

    /// Write the pending set again, if the last write of it failed (module
    /// doc); every `POLL`, from the status thread.
    pub fn retry(&self) {
        let mut st = self.state.lock_ok();
        if st.pending.is_some() {
            self.flush(&mut st);
        }
    }

    fn flush(&self, st: &mut AllowState) {
        let Some(bytes) = st.pending.clone() else {
            return;
        };
        if self.holds(&bytes) {
            st.pending = None;
            st.error = None;
            return;
        }
        let path = self.path.display();
        match crate::util::write_atomic(&self.path, &bytes, crate::util::Access::Private) {
            Ok(()) => {
                let machines = entries(&bytes).map_or(0, |e| e.len());
                if st.error.is_some() {
                    tracing::info!(path = %path, machines, "session host: allow-list written after failing; revocations reach the host again");
                } else {
                    tracing::info!(path = %path, machines, "session host: allow-list written");
                }
                st.pending = None;
                st.error = None;
            }
            Err(e) => {
                let then = self.fail_closed(&bytes);
                let why = format!(
                    "revocations are not reaching the session host: the allow-list {path} \
                     could not be written ({e}); {then}; retrying every {}s",
                    POLL.as_secs()
                );
                if st.error.as_deref() != Some(why.as_str()) {
                    tracing::error!(path = %path, error = %e, "session host: {then}; retrying every {}s", POLL.as_secs());
                }
                st.error = Some(why);
            }
        }
    }

    /// After a failed write of `bytes`: remove the file when it admits
    /// anyone `bytes` does not (or cannot be read), so the host admits
    /// nobody rather than a revoked machine. What was done, for the status.
    fn fail_closed(&self, bytes: &[u8]) -> String {
        let want = entries(bytes).unwrap_or_default();
        let only_adds = std::fs::symlink_metadata(&self.path)
            .is_ok_and(|m| m.file_type().is_file() && m.len() <= MAX_FILE)
            && std::fs::read(&self.path)
                .ok()
                .and_then(|have| entries(&have))
                .is_some_and(|have| have.is_subset(&want));
        if only_adds {
            return "the file there revokes nothing, so it stays until then".into();
        }
        match std::fs::remove_file(&self.path) {
            Ok(()) => "it was removed, so the host admits no machine until a write succeeds".into(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                "there is none, so the host admits no machine until a write succeeds".into()
            }
            Err(e) => format!(
                "it could not be removed either ({e}): the host may still admit a revoked machine"
            ),
        }
    }

    /// Whether the file already is `bytes` in a form the host accepts: a
    /// regular file (never read otherwise: a FIFO would block), this user's,
    /// 0600.
    fn holds(&self, bytes: &[u8]) -> bool {
        let Ok(meta) = std::fs::symlink_metadata(&self.path) else {
            return false;
        };
        if !meta.file_type().is_file() || meta.len() != bytes.len() as u64 {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if Some(meta.uid()) != crate::os::own_uid() || meta.mode() & 0o777 != 0o600 {
                return false;
            }
        }
        std::fs::read(&self.path).is_ok_and(|have| have == bytes)
    }

    pub fn error(&self) -> Option<String> {
        self.state.lock_ok().error.clone()
    }
}

// ── the status file ───────────────────────────────────────────────────────

/// The host's status file, as far as the controller reads it; every field
/// optional, anything else ignored.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StatusFile {
    state: String,
    version: Option<String>,
    exe: Option<String>,
    config: Option<String>,
    host_key: Option<String>,
    allow_list: StatusAllowList,
    connections: Vec<StatusConnection>,
    sessions: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default)]
struct StatusAllowList {
    /// Why the host is not using the file as written (session-host
    /// allow.rs): malformed, or refused.
    error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default)]
struct StatusConnection {
    node: String,
}

/// One look at the status file.
#[derive(Clone, Debug, PartialEq)]
enum Look {
    Missing,
    /// There, but not one to believe, or not one to parse: why.
    Unread(String),
    /// Read, and when it was last written.
    Read(StatusFile, SystemTime),
}

fn look(path: &Path) -> Look {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Look::Missing,
        Err(e) => return Look::Unread(format!("{}: {e}", path.display())),
    };
    let unread = |why: String| Look::Unread(format!("the status file {}: {why}", path.display()));
    if !meta.file_type().is_file() {
        return unread("not a regular file".into());
    }
    if meta.len() > MAX_FILE {
        return unread(format!("over {MAX_FILE} bytes"));
    }
    if let Err(e) = crate::private::check_owner(path) {
        return unread(format!("{e:#}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.mode() & 0o022 != 0 {
            return unread(format!(
                "mode {:o} is group/other-writable",
                meta.mode() & 0o777
            ));
        }
    }
    let written = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<StatusFile>(&bytes) {
            Ok(file) => Look::Read(file, written),
            Err(e) => unread(format!("does not parse: {e}")),
        },
        Err(e) => unread(e.to_string()),
    }
}

/// The session host as the controller follows it (module doc).
pub struct SessionHost {
    cfg: SessionHostConfig,
    registry: Arc<Registry>,
    last: Mutex<Look>,
}

impl SessionHost {
    pub fn new(cfg: SessionHostConfig, registry: Arc<Registry>) -> Self {
        Self {
            cfg,
            registry,
            last: Mutex::new(Look::Missing),
        }
    }

    /// Read the status file now, and every `POLL` on a thread until `stop`.
    /// The first read is done before this returns, so the key reaches the
    /// first machines to connect.
    pub fn start(self: &Arc<Self>, stop: &Shutdown) -> std::io::Result<()> {
        self.poll();
        let (me, stop) = (Arc::clone(self), stop.clone());
        std::thread::Builder::new()
            .name("session-host".into())
            .spawn(move || {
                while !stop.wait(POLL) {
                    me.poll();
                }
            })
            .map(|_| ())
    }

    /// One read: kept for `status`, a changed reason logged once, and the
    /// host's key handed to the registry. And a failed allow-list write
    /// tried again (`AllowList::retry`).
    pub fn poll(&self) {
        self.registry.retry_allow_list();
        let now = look(&self.cfg.status_file);
        {
            let mut last = self.last.lock_ok();
            match (&*last, &now) {
                (Look::Unread(a), Look::Unread(b)) if a == b => {}
                (_, Look::Unread(why)) => {
                    tracing::warn!(why = %why, "session host: status not read")
                }
                _ => {}
            }
            *last = now.clone();
        }
        let Look::Read(file, _) = now else { return };
        let Some(key) = file.host_key.as_deref() else {
            return;
        };
        match crate::identity::parse_public_key(key) {
            Ok(key) => self.registry.set_session_host(Pin {
                address: self.cfg.address.clone(),
                public_key: hex::encode(key),
            }),
            Err(e) => {
                tracing::warn!(error = %e, "session host: its status names a key that is not one")
            }
        }
    }

    /// `santree.status`'s answer, from the last read.
    pub fn status(&self) -> SantreeStatus {
        let last = self.last.lock_ok().clone();
        let mut errors: Vec<String> = self.registry.allow_list_error().into_iter().collect();
        let mut out = SantreeStatus {
            state: SessionHostState::Missing,
            version: None,
            restart_pending: false,
            live_ptys: 0,
            connections: Vec::new(),
            error: None,
        };
        match last {
            Look::Missing => {}
            Look::Unread(why) => errors.push(why),
            Look::Read(file, written) => {
                let age = SystemTime::now()
                    .duration_since(written)
                    .unwrap_or_default();
                out.state = if file.state == "stopped" {
                    SessionHostState::Stopped
                } else if age > STALE_AFTER {
                    SessionHostState::Stale
                } else {
                    SessionHostState::Running
                };
                out.version = file.version.clone();
                if out.state != SessionHostState::Stopped {
                    // Another build, or another config (nix writes each to
                    // a new store path: a new port, root or file), installed
                    // since it started.
                    out.restart_pending = file.exe.as_deref().map(Path::new)
                        != Some(self.cfg.bin.as_path())
                        || file.config.as_deref().map(Path::new) != Some(self.cfg.config.as_path());
                    out.live_ptys = file.sessions;
                    out.connections = self.grouped(&file.connections);
                    if let Some(e) = &file.allow_list.error {
                        errors.push(format!("the session host's allow-list: {e}"));
                    }
                }
            }
        }
        out.error = (!errors.is_empty()).then(|| errors.join("; "));
        out
    }

    /// The connections by machine, named as the pages name it, most first.
    fn grouped(&self, connections: &[StatusConnection]) -> Vec<SantreeConnections> {
        let mut by: std::collections::BTreeMap<&str, u32> = Default::default();
        for c in connections {
            *by.entry(c.node.as_str()).or_default() += 1;
        }
        let mut out: Vec<SantreeConnections> = by
            .into_iter()
            .map(|(node, count)| SantreeConnections {
                node: node.to_string(),
                name: self.registry.node_name(node),
                count,
            })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.node.cmp(&b.node)));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::Identity;
    use crate::link::wire::Policy;
    #[cfg(unix)]
    use crate::rpc::Events;

    #[cfg(unix)]
    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "daedalus-session-host-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn entry(n: u8, state: DesiredState, santree: bool) -> DesiredEntry {
        let id = Identity::from_seed([n; 32]);
        DesiredEntry {
            id: id.node_id(),
            public_key: *id.public_key().as_bytes(),
            state,
            policy: Policy {
                santree,
                ..Policy::default()
            },
            name: Some(format!("machine {n}")),
            offered: Vec::new(),
        }
    }

    /// RFC 8032's test key and its node id, as the session host's own
    /// allow-list tests have them: the two ends agree on the file.
    #[test]
    fn the_allow_list_is_the_approved_santree_machines_in_the_hosts_shape() {
        let key = hex::decode("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
            .unwrap();
        let rfc = DesiredEntry {
            id: "21fe31dfa154a261".into(),
            public_key: key.try_into().unwrap(),
            ..entry(1, DesiredState::Approved, true)
        };
        assert_eq!(
            rfc.id,
            crate::identity::node_id_of(&rfc.public_key),
            "the host's node id is the agent's"
        );
        let set = vec![
            entry(3, DesiredState::Approved, true),
            rfc.clone(),
            entry(4, DesiredState::Approved, false),
            entry(5, DesiredState::Revoked, true),
        ];
        let text = String::from_utf8(AllowList::render(&set)).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
        let three = entry(3, DesiredState::Approved, true);
        let mut want = vec![
            serde_json::json!({"id": rfc.id, "publicKey": hex::encode(rfc.public_key)}),
            serde_json::json!({"id": three.id, "publicKey": hex::encode(three.public_key)}),
        ];
        want.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        assert_eq!(
            doc,
            serde_json::json!({"schemaVersion": 1, "nodes": want}),
            "{text}"
        );
        assert!(text.ends_with("}\n"));
        assert_eq!(
            AllowList::render(&[]),
            b"{\n  \"schemaVersion\": 1,\n  \"nodes\": []\n}\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_allow_list_is_written_private_and_only_when_it_moves() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("allow");
        let path = dir.join("session-host-allow.json");
        let allow = AllowList::new(path.clone());
        let set = vec![entry(3, DesiredState::Approved, true)];
        allow.write(&set);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(std::fs::read(&path).unwrap(), AllowList::render(&set));
        let ino = |p: &Path| std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(p).unwrap());
        let first = ino(&path);
        // The same set, or one that differs only outside the list: untouched.
        allow.write(&[
            entry(3, DesiredState::Approved, true),
            entry(4, DesiredState::Approved, false),
        ]);
        assert_eq!(ino(&path), first, "an unchanged list is not rewritten");
        allow.write(&[]);
        assert_ne!(ino(&path), first);
        assert_eq!(std::fs::read(&path).unwrap(), AllowList::render(&[]));
        assert_eq!(allow.error(), None);
        // A write that fails is kept for the status, and cleared by the next.
        let blocked = AllowList::new(dir.join("missing-dir").join("allow.json"));
        blocked.write(&set);
        assert!(blocked.error().unwrap().contains("could not be written"));
        std::fs::create_dir_all(dir.join("missing-dir")).unwrap();
        blocked.write(&set);
        assert_eq!(blocked.error(), None);
        // N6: a file with the right bytes but a mode the host refuses is
        // rewritten, not left failed closed.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let before = ino(&path);
        allow.write(&[]);
        assert_ne!(ino(&path), before, "rewritten");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            2,
            "no temporary left behind"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Review S1: a write that fails never leaves the host admitting a
    /// revoked machine — the file is removed (the host reads missing as
    /// nobody) — while one that only adds leaves it be; either way the set
    /// is written again by `retry` once it can be, and `santree.status`
    /// says so meanwhile.
    #[cfg(unix)]
    #[test]
    fn a_failed_revocation_fails_closed_and_is_retried() {
        let dir = scratch("allow-fail");
        let path = dir.join("allow.json");
        let allow = AllowList::new(path.clone());
        let (three, four) = (
            entry(3, DesiredState::Approved, true),
            entry(4, DesiredState::Approved, true),
        );
        allow.write(std::slice::from_ref(&three));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            AllowList::render(std::slice::from_ref(&three))
        );
        allow.retry();
        assert_eq!(allow.error(), None, "nothing pending");

        // Writes fail from here: `write_atomic`'s temp name is taken by a
        // directory it cannot remove (as ENOSPC would, but not for root).
        let temp = dir.join(format!(".allow.json.{}.tmp", std::process::id()));
        let block = || {
            std::fs::create_dir_all(temp.join("x")).unwrap();
        };
        let unblock = || std::fs::remove_dir_all(&temp).unwrap();
        block();

        // Adding a machine: the file there revokes nothing and stays.
        allow.write(&[three.clone(), four.clone()]);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            AllowList::render(std::slice::from_ref(&three))
        );
        let e = allow.error().unwrap();
        assert!(
            e.contains("revocations are not reaching the session host"),
            "{e}"
        );
        assert!(e.contains("revokes nothing"), "{e}");

        // Revoking one: the file admits it, so it goes.
        allow.write(std::slice::from_ref(&four));
        assert!(!path.exists(), "removed: the host admits nobody");
        assert!(allow.error().unwrap().contains("removed"));
        allow.retry();
        assert!(!path.exists() && allow.error().is_some(), "still failing");

        // Writable again: the retry writes the newest set and clears it.
        unblock();
        allow.retry();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            AllowList::render(std::slice::from_ref(&four))
        );
        assert_eq!(allow.error(), None);

        // Through the registry and the status thread's poll, as it runs.
        let reg = Arc::new(
            Registry::new(
                Arc::new(Events::default()),
                crate::link::controller::Limits::default(),
            )
            .with_allow_list(path.clone()),
        );
        let host = SessionHost::new(
            SessionHostConfig {
                address: "b:1".into(),
                allow_list: path.clone(),
                status_file: dir.join("status.json"),
                bin: "/b".into(),
                config: "/c".into(),
            },
            Arc::clone(&reg),
        );
        block();
        reg.set_desired(Vec::new());
        assert!(!path.exists());
        assert!(host
            .status()
            .error
            .unwrap()
            .contains("revocations are not reaching the session host"));
        unblock();
        host.poll();
        assert_eq!(std::fs::read(&path).unwrap(), AllowList::render(&[]));
        assert_eq!(host.status().error, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The session host's own status file, as session-host/src/status.rs
    /// writes it (its README's example), read here.
    #[cfg(unix)]
    const RUNNING: &str = r#"{
  "schemaVersion": 1,
  "generatedAt": "2026-09-29T10:00:00Z",
  "state": "running",
  "version": "0.1.0",
  "protocol": 1,
  "bootId": "673f40a95858c4ef",
  "pid": 1234,
  "startedAt": "2026-09-29T09:00:00Z",
  "exe": "/nix/store/aaaa-daedalus-session-host-0.1.0/bin/daedalus-session-host",
  "config": "/nix/store/cccc-daedalus-session-host.json",
  "hostKey": "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  "listen": ["0.0.0.0:7789"],
  "allowList": { "nodes": 1, "error": null },
  "connections": [
    { "node": "21fe31dfa154a261", "peer": "192.0.2.10:51544",
      "connectedAt": "2026-09-29T09:30:00Z", "client": "santree/0.1.17" },
    { "node": "0123456789abcdef", "peer": "192.0.2.11:1",
      "connectedAt": "2026-09-29T09:30:00Z", "client": null },
    { "node": "21fe31dfa154a261", "peer": "192.0.2.10:51545",
      "connectedAt": "2026-09-29T09:31:00Z", "client": "santree/0.1.17" }
  ],
  "sessions": 3
}
"#;

    #[cfg(unix)]
    fn host_at(dir: &Path, registry: Arc<Registry>) -> SessionHost {
        SessionHost::new(
            SessionHostConfig {
                address: "box.example.org:7789".into(),
                allow_list: dir.join("allow.json"),
                status_file: dir.join("status.json"),
                bin: "/nix/store/aaaa-daedalus-session-host-0.1.0/bin/daedalus-session-host".into(),
                config: "/nix/store/cccc-daedalus-session-host.json".into(),
            },
            registry,
        )
    }

    #[cfg(unix)]
    fn registry() -> Arc<Registry> {
        Arc::new(Registry::new(
            Arc::new(Events::default()),
            crate::link::controller::Limits::default(),
        ))
    }

    #[cfg(unix)]
    fn write_status(dir: &Path, text: &str) {
        crate::util::write_atomic(
            &dir.join("status.json"),
            text.as_bytes(),
            crate::util::Access::Private,
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_status_is_read_from_the_hosts_own_file() {
        let dir = scratch("status");
        let reg = registry();
        let host = host_at(&dir, Arc::clone(&reg));

        // No file: missing, and no key to hand out.
        host.poll();
        let s = host.status();
        assert_eq!(s.state, SessionHostState::Missing);
        assert_eq!((s.version, s.live_ptys, s.error), (None, 0, None));
        assert_eq!(reg.session_host(), None);

        // Running: the counts, the machines by connections, the key.
        reg.set_desired(vec![DesiredEntry {
            id: "21fe31dfa154a261".into(),
            public_key: hex::decode(
                "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
            )
            .unwrap()
            .try_into()
            .unwrap(),
            name: Some("MacBook".into()),
            ..entry(1, DesiredState::Approved, true)
        }]);
        write_status(&dir, RUNNING);
        host.poll();
        let s = host.status();
        assert_eq!(s.state, SessionHostState::Running);
        assert_eq!(s.version.as_deref(), Some("0.1.0"));
        assert!(!s.restart_pending);
        assert_eq!(s.live_ptys, 3);
        assert_eq!(
            s.connections,
            vec![
                SantreeConnections {
                    node: "21fe31dfa154a261".into(),
                    name: Some("MacBook".into()),
                    count: 2
                },
                SantreeConnections {
                    node: "0123456789abcdef".into(),
                    name: None,
                    count: 1
                },
            ]
        );
        assert_eq!(
            reg.session_host(),
            Some(Pin {
                address: "box.example.org:7789".into(),
                public_key: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
                    .into()
            })
        );

        // Another build installed: a restart is pending.
        write_status(
            &dir,
            &RUNNING.replace("aaaa-daedalus-session-host", "bbbb-daedalus-session-host"),
        );
        host.poll();
        assert!(host.status().restart_pending);

        // Review S3: the same build on another config (a new port, say):
        // a restart is pending too.
        write_status(
            &dir,
            &RUNNING.replace("cccc-daedalus-session-host", "dddd-daedalus-session-host"),
        );
        host.poll();
        assert!(host.status().restart_pending, "another config");
        write_status(&dir, RUNNING);
        host.poll();
        assert!(!host.status().restart_pending);

        // The host not using its allow-list as written is said.
        write_status(
            &dir,
            &RUNNING.replace("\"error\": null", "\"error\": \"malformed (EOF)\""),
        );
        host.poll();
        let e = host.status().error.unwrap();
        assert!(e.contains("allow-list: malformed"), "{e}");

        // Stale: running by its word, but not written for a while.
        write_status(
            &dir,
            &RUNNING.replace("aaaa-daedalus-session-host", "bbbb-daedalus-session-host"),
        );
        let old = SystemTime::now() - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(dir.join("status.json"))
            .unwrap()
            .set_modified(old)
            .unwrap();
        host.poll();
        let s = host.status();
        assert_eq!(s.state, SessionHostState::Stale);
        assert!(s.restart_pending);

        // Stopped: its last word; the key stays handed out.
        write_status(
            &dir,
            &RUNNING
                .replace("\"running\"", "\"stopped\"")
                .replace("\"sessions\": 3", "\"sessions\": 0"),
        );
        host.poll();
        let s = host.status();
        assert_eq!(s.state, SessionHostState::Stopped);
        assert!(!s.restart_pending && s.connections.is_empty() && s.live_ptys == 0);
        assert!(reg.session_host().is_some());

        // A key that is not one is ignored; the one held stays.
        write_status(&dir, &RUNNING.replace("\"d75a98", "\"zz5a98"));
        host.poll();
        assert!(reg.session_host().unwrap().public_key.starts_with("d75a98"));

        // A newer host's fields pass; a file that does not parse is said.
        write_status(
            &dir,
            &RUNNING.replace("\"sessions\"", "\"future\": [1], \"sessions\""),
        );
        host.poll();
        assert_eq!(host.status().state, SessionHostState::Running);
        write_status(&dir, "{ not json");
        host.poll();
        let s = host.status();
        assert_eq!(s.state, SessionHostState::Missing);
        assert!(s.error.unwrap().contains("does not parse"));

        // Writable by others: not believed.
        write_status(&dir, RUNNING);
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            dir.join("status.json"),
            std::fs::Permissions::from_mode(0o666),
        )
        .unwrap();
        host.poll();
        let s = host.status();
        assert_eq!(s.state, SessionHostState::Missing);
        assert!(s.error.unwrap().contains("group/other-writable"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
