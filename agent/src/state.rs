//! What the agent last did, on disk, so a restart — and every update is a
//! restart — does not forget it.

use serde::{Deserialize, Serialize};

use crate::paths::state_path;

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
        if let Err(e) = self.try_save() {
            tracing::warn!(error = %e, "state not saved");
        }
    }

    /// `save`, saying whether it held: what an update needs before it
    /// replaces anything (the probation must be on disk first).
    pub fn try_save(&self) -> std::io::Result<()> {
        let path = state_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        crate::util::write_atomic(&path, text.as_bytes(), crate::util::Access::Mode(0o644))
    }
}

/// Now, as RFC 3339 in UTC, without a chrono dependency.
pub fn now_rfc3339() -> String {
    rfc3339_ago(0)
}

/// `ago` seconds before now, as RFC 3339 in UTC.
pub fn rfc3339_ago(ago: u64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    rfc3339_of(now.saturating_sub(ago))
}

/// A unix time, as RFC 3339 in UTC.
pub fn rfc3339_of(secs: u64) -> String {
    // Civil-from-days (Howard Hinnant's algorithm), enough for a timestamp.
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::now_rfc3339;

    #[test]
    fn timestamp_shape() {
        let t = now_rfc3339();
        assert_eq!(t.len(), 20, "{t}");
        assert!(t.ends_with('Z'));
        assert_eq!(&t[4..5], "-");
        assert_eq!(&t[10..11], "T");
    }
}
