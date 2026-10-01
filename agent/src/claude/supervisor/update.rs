//! `claude update`, on a thread of its own, and what it did.
//!
//! Nothing is stopped; the server keeps the binary it has until a restart
//! moves it (the module doc, claude/mod.rs, says why the two are separate).
//!
//! `claude update` for every install: it is the supported verb for a native
//! or npm one, and for a package-manager one it is a documented no-op that
//! reports "Claude is up to date!" rather than doing something surprising.
//! Those upgrade themselves through CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE,
//! which every job gets (jobs/ `job_env`): a Homebrew or WinGet install does
//! neither of the others, and this is upstream's own mechanism for it — the
//! server runs `brew upgrade` / `winget upgrade` in the background when a
//! release lands (on WinGet that can fail while Claude Code runs, because
//! Windows locks the executable; it then shows the manual command and
//! nothing breaks). Run as the session's user, which is right for a
//! per-user install and is all the privilege there is here — a machine-wide
//! install under an administrator's path is the case this cannot serve, and
//! the report's install_method is what says so.
//!
//! Ten minutes, because this downloads ~80 MB over whatever line the
//! machine has. Slow is not stuck; a hung process is killed at the end of it
//! and reported as one.
//!
//! ON ITS OWN THREAD, and that is not an optimisation: the session's loop is
//! the only thing that reports to the service, restarts the server and
//! answers the menu's clicks. Running the download inline would freeze all
//! of it for up to ten minutes — the service would see the session stop
//! reporting and the box would say "nobody logged on", the opposite of what
//! just happened. The supervisor's `tick` collects the result when the
//! thread ends.

use std::path::PathBuf;
use std::process::Command;
use std::thread::JoinHandle;
use std::time::Duration;

use super::super::cli::{cli_version, last_meaningful};
use super::super::UpdateResult;
use crate::core::state::now_rfc3339;

/// The deadline of one `claude update`.
const UPDATE_FOR: Duration = Duration::from_secs(600);

/// The update running now, if one is.
#[derive(Default)]
pub(super) struct Updater {
    running: Option<JoinHandle<UpdateResult>>,
}

impl Updater {
    pub(super) fn running(&self) -> bool {
        self.running.is_some()
    }

    /// `cli update` on its thread; `before` is the version it starts from.
    pub(super) fn start(&mut self, cli: PathBuf, before: Option<String>) {
        let spawned = std::thread::Builder::new()
            .name("claude-update".into())
            .spawn(move || run(&cli, before));
        match spawned {
            Ok(h) => self.running = Some(h),
            Err(e) => tracing::warn!(error = %e, "no thread for claude update"),
        }
    }

    /// The finished update, if its thread ended since the last look: its
    /// result, or — a thread that panicked — that it failed, so a later
    /// update is never refused as already running. `version` is the one
    /// known now, for that failure's account.
    pub(super) fn collect(&mut self, version: &Option<String>) -> Option<UpdateResult> {
        if !self.running.as_ref().is_some_and(JoinHandle::is_finished) {
            return None;
        }
        let h = self.running.take()?;
        Some(h.join().unwrap_or_else(|_| UpdateResult {
            at: now_rfc3339(),
            ok: false,
            from: version.clone(),
            to: version.clone(),
            detail: "the update's thread failed before it could say what happened".into(),
        }))
    }
}

fn run(cli: &std::path::Path, before: Option<String>) -> UpdateResult {
    let mut cmd = Command::new(cli);
    cmd.arg("update");
    let ran = crate::exec::both(cmd, UPDATE_FOR);
    // Re-probed either way: an update that reported failure may still have
    // moved the binary, and the version on disk is the fact — not the
    // command's account of itself.
    let after = cli_version(cli);
    let result = match ran {
        Some(r) => UpdateResult {
            at: now_rfc3339(),
            ok: r.ok,
            from: before,
            to: after,
            detail: last_meaningful(&r.output),
        },
        None => UpdateResult {
            at: now_rfc3339(),
            ok: false,
            from: before,
            to: after,
            detail: "`claude update` did not finish within ten minutes and was killed".into(),
        },
    };
    tracing::info!(detail = %result.detail, ok = result.ok, "claude update finished");
    result
}
