//! Probation.
//!
//! A new binary is not trusted for being signed alone: it has to run. The
//! update that installs it records it on PROBATION (`State::probation`),
//! its `.old` binaries kept; each start of that version under the service
//! manager (`run`, never a `serve`) counts itself, as the first thing
//! `agent_main` does (`on_start`), before the config is even read. It has
//! proved itself (`judge_proof`, `prove`) once its local socket has been served
//! for `PROBATION` and — when someone is logged on who runs a tray or a
//! session — that tray or session has reported to it: then the record is
//! cleared and the `.old` files retired. A run that cannot show that within
//! `REPORT_WINDOW` exits, which counts as a failed start. A version that
//! starts more than `MAX_STARTS` times without proving itself — the
//! service manager restarting it after each crash or exit — is ROLLED BACK
//! at its next start: the `.old` binaries go back in place, the failed ones
//! become `.bad`, `State::rolled_back` remembers the version, and the
//! process exits for the service manager to start the old one. That
//! version is never installed again (`check`'s `refused`); a newer release
//! is. The first start after an update also restarts the tray or the
//! session on the new binary (os `restart_desktop_side`), so the report it
//! waits for comes from the matching version. A binary that dies before
//! `main` — never one signed for this target — is past what it can count.

use std::time::Duration;

use super::*;
use crate::shared::Shared;

/// itself.
pub const PROBATION: Duration = Duration::from_secs(120);
/// Starts a version on probation gets; the next one rolls it back.
pub const MAX_STARTS: u32 = 3;

/// What this start of the agent is (`judge_start`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Start {
    /// No update on probation.
    Normal,
    /// The version on probation, starting for the `n`th time.
    Probation(u32),
    /// The version on probation started too often: put the old one back.
    RollBack(crate::state::RolledBack),
}

/// The pure half of `on_start`: count this start against the probation in
/// `state`, running `version`, at `now`.
pub fn judge_start(state: &mut crate::state::State, version: &str, now: &str) -> Start {
    let Some(mut p) = state.probation.take() else {
        return Start::Normal;
    };
    if p.version != version {
        // Not the version on probation: put back by hand, or never
        // started. Nothing to count.
        return Start::Normal;
    }
    p.starts += 1;
    if p.starts > MAX_STARTS {
        let r = crate::state::RolledBack {
            version: p.version,
            to: p.from,
            starts: p.starts - 1,
            at: now.to_string(),
        };
        state.rolled_back = Some(r.clone());
        return Start::RollBack(r);
    }
    let n = p.starts;
    state.probation = Some(p);
    Start::Probation(n)
}

/// Record the update just swapped in as on probation (and forget a
/// version rolled back from: this one is newer).
pub fn begin_probation(state: &mut crate::state::State, version: &str, now: &str) {
    state.probation = Some(crate::state::Probation {
        version: version.to_string(),
        from: crate::VERSION.to_string(),
        starts: 0,
        installed_at: now.to_string(),
    });
    state.rolled_back = None;
}

/// The first thing a start does (module section above): count it, and
/// roll back when the count is past `MAX_STARTS` — which exits the process
/// for the service manager to start the version put back. Logging is not
/// up yet: a rollback says so on stderr and in `last_update_result`, and
/// the caller logs what this returns.
pub fn on_start() -> Start {
    let mut state = crate::state::State::load();
    let had_probation = state.probation.is_some();
    let start = judge_start(&mut state, crate::VERSION, &now_rfc3339());
    match &start {
        // A record for another version was dropped: keep that.
        Start::Normal if had_probation => state.save(),
        Start::Normal => {}
        Start::Probation(_) => state.save(),
        Start::RollBack(r) => {
            let done = install_dir().and_then(|d| roll_back_in(&d));
            state.last_update_result = Some(match &done {
                Ok(()) => format!(
                    "{} rolled back to {}: it started {} times without proving itself",
                    r.version, r.to, r.starts,
                ),
                Err(e) => format!(
                    "{} did not last, and could not be rolled back: {e:#}",
                    r.version
                ),
            });
            state.save();
            eprintln!(
                "daedalus-agent: {}",
                state.last_update_result.as_deref().unwrap_or_default()
            );
            if done.is_ok() {
                std::process::exit(3);
            }
        }
    }
    start
}

/// Whether the version on probation has proved itself yet (`judge_proof`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proof {
    Wait,
    /// Proved, by the rule named.
    Proven(&'static str),
    /// This run failed: no status page, or no report from the tray or the
    /// session with someone logged on, within `REPORT_WINDOW`.
    Failed(&'static str),
}

/// How long a run on probation has to prove itself before it counts as a
/// failed start.
pub const REPORT_WINDOW: Duration = Duration::from_secs(300);

/// The pure half of the proof (module section above): the local socket served
/// for `PROBATION`, and — when someone is logged on who runs a tray or a
/// session (`user_present`, asked only then) — a report from it lately
/// (`reporting`). Past `REPORT_WINDOW` without that, the run failed.
pub fn judge_proof(
    page_up_for: Option<Duration>,
    running_for: Duration,
    user_present: impl FnOnce() -> bool,
    reporting: bool,
) -> Proof {
    if page_up_for.is_some_and(|u| u >= PROBATION) {
        if reporting {
            return Proof::Proven("the local socket served 120 s and the tray/session reported");
        }
        if !user_present() {
            return Proof::Proven(
                "the local socket served 120 s, and nobody is logged on to report",
            );
        }
    }
    if running_for < REPORT_WINDOW {
        return Proof::Wait;
    }
    Proof::Failed(match page_up_for {
        None => "the local socket was never served",
        Some(_) => "someone is logged on and no tray or session reported",
    })
}

/// The version on probation has proved itself (`rule` says how): clear it,
/// and retire the previous binaries.
pub fn prove(shared: &Shared, rule: &'static str) {
    let mut version = None;
    shared.with_state(|s| {
        version = s.probation.take().map(|p| p.version);
    });
    if let Some(v) = version {
        tracing::info!(
            version = v,
            rule,
            "the update proved itself; retiring the previous binaries"
        );
        retire_old_binaries();
    }
}
