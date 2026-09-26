//! The user's Claude profile (`~/.claude`, or CLAUDE_CONFIG_DIR): the
//! session files and whether each process lives, the credential clock
//! (never a token), and the model settings.

use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Stdio;

use super::{Credentials, Session, Settings};

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// `~/.claude`, or what CLAUDE_CONFIG_DIR says — the CLI's own rule.
pub fn claude_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(d));
    }
    home_dir().map(|h| h.join(".claude"))
}

/// Sessions reported, at most; a profile with hundreds of stale files
/// would otherwise make every hello a long one.
const MAX_SESSIONS: usize = 40;

fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        // SAFETY: a query handle, read once and closed.
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code).is_ok();
            let _ = CloseHandle(h);
            ok && code == STILL_ACTIVE
        }
    }
    #[cfg(unix)]
    {
        // Signal 0 delivers nothing and says whether the pid exists (EPERM
        // means it does, owned by someone else).
        // SAFETY: kill with signal 0 has no effect on the target.
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

/// The session files, alive ones first, newest first within each.
pub fn read_sessions(dir: &Path) -> Vec<Session> {
    let Ok(entries) = std::fs::read_dir(dir.join("sessions")) else {
        return Vec::new();
    };
    let mut out: Vec<Session> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter_map(|v| session_of(&v))
        .collect();
    out.sort_by(|a, b| b.alive.cmp(&a.alive).then(b.started_at.cmp(&a.started_at)));
    out.truncate(MAX_SESSIONS);
    out
}

fn session_of(v: &serde_json::Value) -> Option<Session> {
    let pid = v.get("pid")?.as_u64()? as u32;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let n = |k: &str| v.get(k).and_then(|x| x.as_u64());
    let last = [n("statusUpdatedAt"), n("updatedAt")]
        .into_iter()
        .flatten()
        .max();
    Some(Session {
        pid,
        transcript_id: s("sessionId"),
        remote_id: s("bridgeSessionId"),
        cwd: s("cwd"),
        name: s("name"),
        kind: s("kind"),
        entrypoint: s("entrypoint"),
        version: s("version"),
        started_at: n("startedAt"),
        status: s("status"),
        last_activity_at: last,
        alive: pid_alive(pid),
    })
}

/// The credential clock from `.credentials.json`: four fields by name, and
/// nothing else leaves the file.
pub fn read_credentials(dir: &Path) -> Credentials {
    let path = dir.join(".credentials.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return keychain_credentials();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Credentials {
            present: true,
            store: Some("file".into()),
            ..Default::default()
        };
    };
    let o = v.get("claudeAiOauth");
    let s = |k: &str| {
        o.and_then(|o| o.get(k))
            .and_then(|x| x.as_str())
            .map(str::to_string)
    };
    let n = |k: &str| o.and_then(|o| o.get(k)).and_then(|x| x.as_u64());
    Credentials {
        present: true,
        store: Some("file".into()),
        subscription_type: s("subscriptionType"),
        rate_limit_tier: s("rateLimitTier"),
        expires_at: n("expiresAt"),
        refresh_expires_at: n("refreshTokenExpiresAt"),
    }
}

/// macOS keeps the login in the login keychain under the service name the
/// CLI uses. Listing the item's attributes needs no access to the secret
/// and so triggers no prompt; the dates inside it would, so they stay
/// unread. Absent everywhere else.
fn keychain_credentials() -> Credentials {
    #[cfg(target_os = "macos")]
    {
        let found = std::process::Command::new("security")
            .args(["find-generic-password", "-s", "Claude Code-credentials"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if found {
            return Credentials {
                present: true,
                store: Some("keychain".into()),
                ..Default::default()
            };
        }
    }
    Credentials::default()
}

pub fn read_settings(dir: &Path) -> Settings {
    let Ok(text) = std::fs::read_to_string(dir.join("settings.json")) else {
        return Settings::default();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Settings::default();
    };
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Settings {
        model: s("model"),
        effort_level: s("effortLevel"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_readers_tolerate_absence_and_copy_by_name() {
        let dir = std::env::temp_dir().join(format!("daedalus-claude-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        assert!(!read_credentials(&dir).present);
        assert!(read_sessions(&dir).is_empty());

        std::fs::write(
            dir.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"secret","refreshToken":"secret","subscriptionType":"max","rateLimitTier":"t","expiresAt":1,"refreshTokenExpiresAt":2}}"#,
        )
        .unwrap();
        let c = read_credentials(&dir);
        assert!(c.present);
        assert_eq!(c.subscription_type.as_deref(), Some("max"));
        assert_eq!(c.refresh_expires_at, Some(2));
        let json = serde_json::to_string(&c).unwrap();
        assert!(!json.contains("secret"));

        std::fs::write(
            dir.join("settings.json"),
            r#"{"model":"opus","effortLevel":"high"}"#,
        )
        .unwrap();
        assert_eq!(read_settings(&dir).model.as_deref(), Some("opus"));

        let me = std::process::id();
        std::fs::write(
            dir.join("sessions").join("a.json"),
            format!(
                r#"{{"pid":{me},"sessionId":"u","cwd":"/x","name":"n","kind":"interactive","startedAt":5,"updatedAt":6,"status":"idle","statusUpdatedAt":7,"bridgeSessionId":"session_1"}}"#
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("sessions").join("b.json"),
            r#"{"pid":4000000000,"sessionId":"v","startedAt":9}"#,
        )
        .unwrap();
        let s = read_sessions(&dir);
        assert_eq!(s.len(), 2);
        assert!(s[0].alive, "own pid is alive and sorts first");
        assert_eq!(s[0].remote_id.as_deref(), Some("session_1"));
        assert_eq!(s[0].last_activity_at, Some(7));
        assert!(!s[1].alive);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
