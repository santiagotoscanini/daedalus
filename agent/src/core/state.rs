//! What the agent last did, on disk, so a restart — and every update is a
//! restart — does not forget it.

use serde::{Deserialize, Serialize};

use crate::core::paths::state_path;
use crate::util::LockExt;
// The clocks the state and its readers write (time.rs).
pub use crate::time::{now_rfc3339, rfc3339_ago, rfc3339_of};

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    /// RFC 3339, from the last time the release feed answered.
    pub last_update_check: Option<String>,
    /// What the last check found, as one line ("up to date", "0.2.0 available", an error).
    pub last_update_result: Option<String>,
    /// The version this binary replaced, set by the update that installed it.
    pub updated_from: Option<String>,
    /// When that update happened.
    pub updated_at: Option<String>,
    /// A version just installed that has not yet proved itself (update.rs
    /// `judge_start`): its `.old` binaries stay until it does.
    pub probation: Option<Probation>,
    /// The last version this machine rolled back from; never installed
    /// again — a newer release is.
    pub rolled_back: Option<RolledBack>,
}

/// An update on probation.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Probation {
    /// The version installed.
    pub version: String,
    /// The version it replaced, whose binaries wait as `.old`.
    pub from: String,
    /// How often the new version has started since it was installed.
    pub starts: u32,
    /// When it was installed, RFC 3339.
    pub installed_at: String,
}

/// An update that did not survive its probation.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RolledBack {
    /// The version that failed.
    pub version: String,
    /// The version put back.
    pub to: String,
    /// How often it started without lasting.
    pub starts: u32,
    /// When it was rolled back, RFC 3339.
    pub at: String,
}

impl State {
    pub fn load() -> Self {
        std::fs::read_to_string(state_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        if let Err(e) = self.try_save_at(&state_path()) {
            tracing::warn!(error = %e, "state not saved");
        }
    }

    /// `save` at `path`, saying whether it held: what an update needs before
    /// it replaces anything (the probation must be on disk first).
    fn try_save_at(&self, path: &std::path::Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        crate::util::write_atomic(path, text.as_bytes(), crate::util::Access::Mode(0o644))
    }
}

/// The persisted state behind its lock, and the file it is kept in: the
/// service's (`Shared::state`) and a verb's own (`update --apply`), so both
/// edit it the same way.
#[derive(Debug)]
pub struct StateStore {
    state: std::sync::Mutex<State>,
    path: std::path::PathBuf,
}

impl StateStore {
    /// `state`, kept at `path`.
    pub fn at(path: std::path::PathBuf, state: State) -> Self {
        Self {
            state: std::sync::Mutex::new(state),
            path,
        }
    }

    /// `state`, kept where the service keeps it.
    pub fn new(state: State) -> Self {
        Self::at(state_path(), state)
    }

    /// The state on disk, or the defaults.
    pub fn load() -> Self {
        Self::new(State::load())
    }

    /// The state as it stands.
    pub fn get(&self) -> State {
        self.state.lock_ok().clone()
    }

    /// Edit and persist it in one step; a failed save is logged.
    pub fn edit(&self, f: impl FnOnce(&mut State)) {
        if let Err(e) = self.edit_saved(f) {
            tracing::warn!(error = %e, "state not saved");
        }
    }

    /// `edit`, and whether the state reached the disk.
    pub fn edit_saved(&self, f: impl FnOnce(&mut State)) -> std::io::Result<()> {
        let mut s = self.state.lock_ok();
        f(&mut s);
        s.try_save_at(&self.path)
    }
}
