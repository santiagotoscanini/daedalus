//! What the agent last did, on disk, so a restart — and every update is a
//! restart — does not forget it.

use serde::{Deserialize, Serialize};

use crate::config::state_path;

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
}

impl State {
    pub fn load() -> Self {
        std::fs::read_to_string(state_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        let path = state_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match serde_json::to_string_pretty(self) {
            Ok(text) => {
                if let Err(e) = std::fs::write(&path, text) {
                    tracing::warn!(error = %e, "state not saved");
                }
            }
            Err(e) => tracing::warn!(error = %e, "state not serialised"),
        }
    }
}

/// Now, as RFC 3339 in UTC, without a chrono dependency.
pub fn now_rfc3339() -> String {
    rfc3339_ago(0)
}

/// `ago` seconds before now, as RFC 3339 in UTC.
pub fn rfc3339_ago(ago: u64) -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .saturating_sub(ago);
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
