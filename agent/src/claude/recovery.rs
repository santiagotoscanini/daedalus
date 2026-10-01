//! Automatic session recovery: the sessions open when the Remote Control
//! server went down come back by themselves once it is up again.
//!
//! A server restart ends every session it spawned — the restart verb, a
//! policy that moves its directory, the server dying and the supervisor
//! starting it again, or a machine coming back from a reboot. They cannot
//! be picked up from claude.ai, only resumed here; so the session keeps the
//! set of sessions that are OPEN, and after any start of the server it
//! performs (never a re-attach, which ended nothing) and once the server
//! is registered again, it resumes each one that is not running by id,
//! through the ordinary resume verb (sessions/) with every check it
//! makes: the transcript exists, the directory is trusted, nothing already
//! runs it. At most `MAX_RECOVER`, the most recently opened first. Each
//! attempt is a row in the roster's `actions` and in the report's
//! `recovered`.
//!
//! Open means: a live session file whose process descends from the
//! server's (the sessions the server spawned — session.rs `open_sessions`),
//! or a session this agent resumed that runs as a job of its own (the
//! roster's `managed`). The set is kept on every look (`observe`) and
//! written to `claude-recovery.json` in the session's state directory, so
//! a set from before an agent restart or a reboot is recovered too.
//!
//! A session leaves the set when it has not been open for `GRACE` while the
//! same server kept running — ended from claude.ai, or it left on its own —
//! or at once when the operator stops it (`forget`, the stop verb). Nothing
//! leaves it while the server is down, restarting, or while a recovery is
//! due or running (`freeze`): the sessions are gone then because the server
//! went, which is what the set is for. A session whose resume fails stays
//! out of the set once the grace has passed: one attempt per restart.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::roster::is_uuid;

/// How long a session must be gone, with the same server running, before
/// it leaves the set.
pub const GRACE: Duration = Duration::from_secs(30);
/// Sessions resumed after one restart, at most.
pub const MAX_RECOVER: usize = 16;
/// Sessions kept in the set, at most.
const MAX_KEPT: usize = 64;

/// The file, as written.
#[derive(Default, Serialize, Deserialize)]
struct Stored {
    /// Newest first.
    sessions: Vec<String>,
}

#[derive(Clone, Debug)]
struct Entry {
    /// When it was first seen open, in this process's order.
    order: u64,
    gone_since: Option<Instant>,
}

pub struct Recovery {
    path: PathBuf,
    entries: BTreeMap<String, Entry>,
    /// The server's pid as last observed; a change restarts every grace.
    server: Option<u32>,
    frozen: bool,
    next: u64,
}

impl Recovery {
    /// The set in `path`, or an empty one.
    pub fn load(path: PathBuf) -> Self {
        let stored: Stored = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let mut r = Self {
            path,
            entries: BTreeMap::new(),
            server: None,
            frozen: false,
            next: 0,
        };
        // The file is newest first; the newest gets the highest order.
        for id in stored.sessions.iter().rev().filter(|i| is_uuid(i)) {
            r.add(id);
        }
        r
    }

    /// The sessions in the set, newest first.
    pub fn ids(&self) -> Vec<String> {
        let mut v: Vec<(&String, &Entry)> = self.entries.iter().collect();
        v.sort_by_key(|a| std::cmp::Reverse(a.1.order));
        v.into_iter().map(|(id, _)| id.clone()).collect()
    }

    fn add(&mut self, id: &str) -> bool {
        if self.entries.contains_key(id) {
            return false;
        }
        self.entries.insert(
            id.to_string(),
            Entry {
                order: self.next,
                gone_since: None,
            },
        );
        self.next += 1;
        // The oldest go past the bound.
        while self.entries.len() > MAX_KEPT {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.order)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => self.entries.remove(&k),
                None => break,
            };
        }
        true
    }

    /// While frozen, nothing leaves the set (a recovery is due or running).
    pub fn freeze(&mut self, frozen: bool) {
        self.frozen = frozen;
    }

    /// One look: `server` is the server's pid while it runs (None when it
    /// does not), `open` the sessions open now.
    pub fn observe(&mut self, server: Option<u32>, open: &[String], now: Instant) {
        if server != self.server {
            self.server = server;
            for e in self.entries.values_mut() {
                e.gone_since = None;
            }
        }
        let mut changed = false;
        for id in open.iter().filter(|i| is_uuid(i)) {
            match self.entries.get_mut(id) {
                Some(e) => e.gone_since = None,
                None => changed |= self.add(id),
            }
        }
        if server.is_some() && !self.frozen {
            let mut leaving = Vec::new();
            for (id, e) in self.entries.iter_mut() {
                if open.contains(id) {
                    continue;
                }
                let since = *e.gone_since.get_or_insert(now);
                if now.saturating_duration_since(since) >= GRACE {
                    leaving.push(id.clone());
                }
            }
            for id in leaving {
                self.entries.remove(&id);
                changed = true;
            }
        }
        if changed {
            self.persist();
        }
    }

    /// The operator stopped it: it is not to come back.
    pub fn forget(&mut self, id: &str) {
        if self.entries.remove(id).is_some() {
            self.persist();
        }
    }

    /// What to resume now: the set's sessions not open, newest first, at
    /// most `MAX_RECOVER`.
    pub fn due(&self, open: &[String]) -> Vec<String> {
        self.ids()
            .into_iter()
            .filter(|id| !open.contains(id))
            .take(MAX_RECOVER)
            .collect()
    }

    fn persist(&self) {
        let text = match serde_json::to_string(&Stored {
            sessions: self.ids(),
        }) {
            Ok(t) => t,
            Err(_) => return,
        };
        if let Err(e) = write_atomically(&self.path, &text) {
            tracing::warn!(path = %self.path.display(), error = %e, "the sessions to recover were not written");
        }
    }
}

fn write_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::util::write_atomic(path, text.as_bytes(), crate::util::Access::Inherit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> String {
        format!("aaaaaaaa-0000-4000-8000-0000000000{n:02x}")
    }

    fn file(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("daedalus-recovery-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("claude-recovery.json")
    }

    #[test]
    fn the_set_follows_what_is_open_and_survives_a_restart() {
        let path = file("follow");
        let t0 = Instant::now();
        let mut r = Recovery::load(path.clone());
        assert!(r.ids().is_empty());
        r.observe(Some(100), &[id(1), id(2)], t0);
        r.observe(Some(100), &[id(1), id(2), id(3)], t0);
        assert_eq!(r.ids(), [id(3), id(2), id(1)]);
        // 2 ends from claude.ai while the server runs: out after the grace.
        r.observe(Some(100), &[id(1), id(3)], t0 + Duration::from_secs(1));
        r.observe(Some(100), &[id(1), id(3)], t0 + Duration::from_secs(20));
        assert_eq!(r.ids().len(), 3);
        r.observe(Some(100), &[id(1), id(3)], t0 + Duration::from_secs(32));
        assert_eq!(r.ids(), [id(3), id(1)]);
        // The server dies: everything under it goes, and nothing leaves.
        r.observe(None, &[], t0 + Duration::from_secs(40));
        r.observe(None, &[], t0 + Duration::from_secs(400));
        assert_eq!(r.ids(), [id(3), id(1)]);
        // The next process reads the same set.
        let mut again = Recovery::load(path.clone());
        assert_eq!(again.ids(), [id(3), id(1)]);
        // A new server: every grace starts over, and while a recovery is due
        // the set is frozen.
        again.freeze(true);
        again.observe(Some(200), &[], t0 + Duration::from_secs(500));
        again.observe(Some(200), &[], t0 + Duration::from_secs(600));
        assert_eq!(again.due(&[]), [id(3), id(1)]);
        assert_eq!(again.due(&[id(3)]), [id(1)]);
        // The stop verb: gone at once, and from the file.
        again.forget(&id(3));
        assert_eq!(Recovery::load(path.clone()).ids(), [id(1)]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_recovery_is_capped_and_the_set_bounded() {
        let path = file("cap");
        let mut r = Recovery::load(path.clone());
        let all: Vec<String> = (0..80).map(id).collect();
        r.observe(Some(1), &all, Instant::now());
        assert_eq!(r.ids().len(), MAX_KEPT);
        let due = r.due(&[]);
        assert_eq!(due.len(), MAX_RECOVER);
        assert_eq!(due[0], id(79), "newest first");
        // What is not a uuid never enters.
        r.observe(Some(1), &["../x".to_string()], Instant::now());
        assert!(!r.ids().contains(&"../x".to_string()));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
