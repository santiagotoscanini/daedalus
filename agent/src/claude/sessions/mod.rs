//! The three verbs on one Claude Code session — resume, stop, remove — the
//! automatic recovery that resumes what a server restart ended, and the
//! thread that runs them and keeps the roster (roster/) fresh: the verbs
//! in verbs.rs, the thread in worker.rs.
//!
//! The caller supplies a SELECTOR and nothing else: never a path, a flag or
//! a directory. Three layers, in the order they run:
//!
//! 1. SYNTAX (`check_selector`): a canonical lowercase uuid, or eight
//!    lowercase hex digits (a background agent's short id), before the value
//!    is used anywhere — checked where a request is accepted and again here.
//! 2. EXISTENCE: `resume` needs `<uuid>.jsonl` as a regular file (never a
//!    link) in a real directory under `~/.claude/projects`, found by walking
//!    the tree; `stop` and `remove` of a short id need the CLI's own
//!    `claude agents --json` to list a background agent by it.
//! 3. A TRUSTED CWD: a resumed session runs only in a project directory
//!    whose workspace trust was accepted (`~/.claude.json`), and only the one
//!    the transcript's project slug names. Anywhere else an interactive
//!    `claude` stops on "Is this a project you created or one you trust?"
//!    and a job would sit there started and useless.
//!
//! **Resume** starts `claude --resume <uuid> --remote-control <hostname>` as
//! a job of its own, `claude-session-<uuid>` (a development run with
//! `DAEDALUS_AGENT_DATA_DIR` names its own, config.rs), in that directory,
//! with the environment the server's job gets plus TERM (and on NixOS
//! `/run/wrappers/bin`, for sudo) — under a terminal, which is not optional:
//! with pipes the CLI falls back to --print mode and exits in a second. What
//! the terminal is, is the OS's (jobs/): `script` on Linux and macOS, with
//! the output filtered on the way to the job's log; a pseudo-console the
//! agent's own binary holds on Windows. The job outlives the agent: a
//! restart or an update of the agent ends nothing, and the next start finds
//! it (`managed`). It is refused when anything already runs that session —
//! its job, the CLI's agents, a live session file — because `--resume` of a
//! running session starts a copy and two processes would append to one
//! transcript. Five seconds after the start the job must still run, or the
//! resume failed. The `claude` it runs is pinned from the nix garbage
//! collector while it runs, where it is a store path (gcroot.rs).
//!
//! **Stop** of a uuid ends a session this agent resumed: its job, with the
//! OS ending the whole tree — no pid to match. A session the Remote Control
//! server spawned has no stop of its own; it ends with its server. Stop of a
//! short id is `claude stop <id>`, the CLI's own verb for a background
//! agent, which keeps the conversation (`claude attach` reopens it); what
//! settles it is no process left behind the id, not the CLI's exit status.
//!
//! **Remove** is `claude rm <short id>`: a background agent's record and its
//! worktree, and settled by the record being gone. Never
//! `--discard-unpushed` — that throws away commits.
//!
//! **Recovery** (recovery.rs says when) is `resume` of each session id the
//! session hands over, one after the other, with every check above; each is
//! a row in `actions` like an operator's request, and the whole run is the
//! report's `recovered`.
//!
//! What a verb did is reported in the roster's `actions` (`ActionResult`) in
//! a sentence of the agent's own; what the CLI printed goes to the agent's
//! log and nowhere else — it is session content.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::roster::{is_short_id, is_uuid, Roster, Scanner};
use super::{Recovered, SessionAction, SessionRequest};
use crate::jobs::Jobs;
use crate::util::LockExt;

/// How often the roster is read when nothing asks.
pub const REFRESH: Duration = Duration::from_secs(60);
/// How long a resumed session must stay up to count as started.
const SETTLE: Duration = Duration::from_secs(5);
/// `claude agents --json`.
const AGENTS_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest an unchanged profile keeps the last `claude agents` answer.
const AGENTS_MAX_AGE: Duration = Duration::from_secs(10 * 60);
/// `claude stop` and `claude rm`.
const VERB_TIMEOUT: Duration = Duration::from_secs(30);
/// Results kept in the roster: room for a whole recovery and the requests
/// around it.
const ACTIONS_KEPT: usize = 24;
/// A resumed session's log, gone this long with its job, is removed.
const LOG_KEEP: Duration = Duration::from_secs(14 * 24 * 3600);

/// The selector each verb takes (module doc, layer 1).
pub fn check_selector(action: SessionAction, id: &str) -> Result<(), String> {
    let ok = match action {
        SessionAction::Resume => is_uuid(id),
        SessionAction::Stop => is_uuid(id) || is_short_id(id),
        SessionAction::Remove => is_short_id(id),
    };
    if ok {
        return Ok(());
    }
    Err(match action {
        SessionAction::Resume => "resume takes a session id: a canonical lowercase uuid".into(),
        SessionAction::Stop => {
            "stop takes a session id (a lowercase uuid) or a background agent's eight-digit id"
                .into()
        }
        SessionAction::Remove => "remove takes a background agent's eight-digit id".into(),
    })
}

/// A request id: sixteen hex characters from the OS's randomness.
pub fn mint_request() -> String {
    let mut b = [0u8; 8];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut b);
    hex::encode(b)
}

/// What the verbs and the roster need to know about this session.
#[derive(Clone, Debug)]
pub struct Context {
    /// The Remote Control server's job, for its accounting and its pin.
    pub server: String,
    /// The resumed sessions' job names start with this; the uuid follows.
    pub prefix: String,
    /// Where each resumed session's log goes (beside claude-rc.log).
    pub log_dir: PathBuf,
    /// `--remote-control <label>`: this machine's name, as a token.
    pub label: String,
    /// Where the running `claude`s are pinned (gcroot.rs).
    pub roots: PathBuf,
}

/// The hostname as a `--remote-control` label: letters, digits, `.`, `_`
/// and `-`, anything else a dash, at most 63.
pub fn label_of(hostname: &str) -> String {
    let l: String = hostname
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .take(63)
        .collect();
    if l.is_empty() {
        "daedalus".into()
    } else {
        l
    }
}

// ── the thread ────────────────────────────────────────────────────────────

enum Msg {
    Request(SessionRequest, bool),
    /// The sessions to resume after a server restart, and whether Claude
    /// may run here at all.
    Recover(Vec<String>, bool),
}

#[derive(Default)]
struct Latest {
    generation: u64,
    roster: Option<Arc<Roster>>,
    /// The ids of the sessions it lists as managed, for the recovery set
    /// (session.rs), read every poll without the roster.
    managed: Vec<String>,
    /// The last recovery's rows.
    recovered: Vec<Recovered>,
    /// A recovery is queued or running.
    recovering: bool,
}

/// The roster and the verbs, on a thread of their own: a scan or a resume
/// takes seconds, and the session's loop — which reports to the service
/// every five seconds — must not wait on either. Dropping this ends the thread after what it is doing.
pub struct Sessions {
    tx: Sender<Msg>,
    latest: Arc<Mutex<Latest>>,
}

impl Sessions {
    /// The thread, over this OS's jobs (`os::jobs::Os`) or a test's.
    pub fn start(ctx: Context, jobs: Box<dyn Jobs>) -> Self {
        let (tx, rx) = mpsc::channel();
        let latest = Arc::new(Mutex::new(Latest::default()));
        let worker = Worker {
            ctx,
            jobs,
            scanner: Scanner::default(),
            actions: VecDeque::new(),
            latest: Arc::clone(&latest),
            last: None,
            agents_read: None,
        };
        if let Err(e) = std::thread::Builder::new()
            .name("claude-sessions".into())
            .spawn(move || worker.run(rx))
        {
            tracing::error!(error = %e, "no thread for the Claude sessions; no roster will be read");
        }
        Self { tx, latest }
    }

    /// Hand one request to the thread; `wanted` is whether Claude may run
    /// here at all (the policy), which refuses every verb when off.
    pub fn submit(&self, req: SessionRequest, wanted: bool) {
        let _ = self.tx.send(Msg::Request(req, wanted));
    }

    /// Resume each of `ids`, after a server restart (recovery.rs).
    pub fn recover(&self, ids: Vec<String>, wanted: bool) {
        self.lock().recovering = true;
        if self.tx.send(Msg::Recover(ids, wanted)).is_err() {
            self.lock().recovering = false;
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Latest> {
        self.latest.lock_ok()
    }

    /// The newest roster and its generation, which moves with each one.
    pub fn latest(&self) -> Option<(u64, Arc<Roster>)> {
        let l = self.lock();
        l.roster.clone().map(|r| (l.generation, r))
    }

    /// The newest roster's generation alone.
    pub fn generation(&self) -> u64 {
        self.lock().generation
    }

    /// The sessions the newest roster lists as managed (resumed by this
    /// agent, running as their own jobs).
    pub fn managed_ids(&self) -> Vec<String> {
        self.lock().managed.clone()
    }

    /// The last recovery's rows, for the report.
    pub fn recovered(&self) -> Vec<Recovered> {
        self.lock().recovered.clone()
    }

    /// A recovery is queued or running.
    pub fn recovering(&self) -> bool {
        self.lock().recovering
    }
}

mod verbs;
mod worker;

use worker::Worker;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::ActionState;

    const ID: &str = "abdda3a9-0cb2-43f1-b13e-37f25a755fce";

    #[test]
    fn each_verb_takes_its_own_selector() {
        use SessionAction::*;
        assert!(check_selector(Resume, ID).is_ok());
        assert!(check_selector(Resume, "0a1b2c3d").is_err());
        assert!(check_selector(Stop, ID).is_ok());
        assert!(check_selector(Stop, "0a1b2c3d").is_ok());
        assert!(check_selector(Remove, "0a1b2c3d").is_ok());
        assert!(check_selector(Remove, ID).is_err());
        for bad in [
            "",
            "../x",
            "0a1b2c3d;rm",
            "--discard-unpushed",
            &ID.to_uppercase(),
        ] {
            for a in [Resume, Stop, Remove] {
                assert!(check_selector(a, bad).is_err(), "{a:?} {bad}");
            }
        }
        let r = mint_request();
        assert_eq!(r.len(), 16);
        assert!(r.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(r, mint_request());
        assert_eq!(label_of("s2-server"), "s2-server");
        assert_eq!(label_of("Santiago’s MacBook Pro"), "Santiago-s-MacBook-Pro");
        assert_eq!(label_of(""), "daedalus");
    }

    /// The thread, end to end, with no `claude` and a HOME of its own: a
    /// roster comes, a verb with the policy off is refused, a malformed
    /// selector is refused, a resume with no transcript is refused, and a
    /// recovery reports each session it tried.
    #[test]
    fn the_thread_reads_a_roster_and_refuses_what_it_must() {
        let tag = std::process::id();
        let s = Sessions::start(
            Context {
                server: format!("daedalus-agent-test-rc-{tag}"),
                prefix: format!("daedalus-agent-test-session-{tag}-"),
                log_dir: std::env::temp_dir(),
                label: "test".into(),
                roots: std::env::temp_dir().join(format!("daedalus-test-roots-{tag}")),
            },
            Box::new(crate::os::jobs::Os),
        );
        let wait_for = |pred: &dyn Fn(&Roster) -> bool| {
            let until = std::time::Instant::now() + Duration::from_secs(20);
            loop {
                if let Some((_, r)) = s.latest() {
                    if pred(&r) {
                        return r;
                    }
                }
                assert!(std::time::Instant::now() < until, "no such roster");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        wait_for(&|_| true);
        let req = |request: &str, action, id: &str| SessionRequest {
            request: request.into(),
            action,
            id: id.into(),
        };
        s.submit(req("0000000000000001", SessionAction::Resume, ID), false);
        s.submit(
            req("0000000000000002", SessionAction::Remove, "../etc"),
            true,
        );
        s.submit(req("0000000000000003", SessionAction::Resume, ID), true);
        let r = wait_for(&|r| {
            r.actions.len() == 3 && r.actions.iter().all(|a| a.finished_at.is_some())
        });
        let by = |q: &str| r.actions.iter().find(|a| a.request == q).unwrap();
        assert_eq!(by("0000000000000001").state, ActionState::Refused);
        assert!(by("0000000000000001").detail.contains("policy"));
        assert_eq!(by("0000000000000002").state, ActionState::Refused);
        assert!(by("0000000000000002").detail.contains("eight-digit"));
        // No transcript (or no profile at all) for this uuid on a test
        // machine: refused or failed before anything starts, never done.
        assert_ne!(by("0000000000000003").state, ActionState::Done);
        assert_eq!(r.actions[0].request, "0000000000000003", "newest first");
        // A recovery: one row per session, in the actions and the report.
        s.recover(vec![ID.to_string()], false);
        let until = std::time::Instant::now() + Duration::from_secs(20);
        while s.recovering() {
            assert!(
                std::time::Instant::now() < until,
                "the recovery never ended"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let rows = s.recovered();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (rows[0].id.as_str(), rows[0].result),
            (ID, ActionState::Refused)
        );
        let r = wait_for(&|r| {
            r.actions.len() == 4 && r.actions[0].detail.starts_with("recovery after")
        });
        assert!(r.actions[0].detail.contains("policy"));
        assert_eq!(r.actions[0].action, SessionAction::Resume);
    }
}
