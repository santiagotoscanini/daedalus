//! The user's Claude profile (`~/.claude`, or CLAUDE_CONFIG_DIR): the
//! session files and whether each process lives, the credential clock
//! (never a token), and the model settings.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer};

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
/// would otherwise make every report the session sends a long one.
const MAX_SESSIONS: usize = 40;
/// Session files looked at, at most.
const MAX_SESSION_FILES: usize = 400;
/// A session file read, at most: the CLI's are a few hundred bytes.
const SESSION_FILE_BYTES: u64 = 64 * 1024;

/// One `~/.claude/sessions/*.json` as the CLI writes it: the fields any
/// reader here uses, by name, and nothing else.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionFile {
    #[serde(deserialize_with = "pid")]
    pub pid: u32,
    pub session_id: Option<String>,
    pub bridge_session_id: Option<String>,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub entrypoint: Option<String>,
    pub version: Option<String>,
    pub started_at: Option<u64>,
    pub status: Option<String>,
    pub status_updated_at: Option<u64>,
    pub updated_at: Option<u64>,
    /// When its process started, as the CLI records it (a string; a number
    /// is read too): compared with `ProcStats::start_ticks` to tell the
    /// process that wrote the file from a later one on a recycled pid.
    #[serde(deserialize_with = "proc_start")]
    pub proc_start: Option<u64>,
}

/// A pid that fits one; anything else (absent, negative, too large) is 0,
/// which no reader takes for a process.
fn pid<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(v.as_u64().and_then(|p| u32::try_from(p).ok()).unwrap_or(0))
}

fn proc_start<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => s.trim().parse().ok(),
        serde_json::Value::Number(n) => n.as_u64(),
        _ => None,
    })
}

impl SessionFile {
    /// Its process runs, and — where the OS says when a process started
    /// and the file says too — it is still the one that wrote the file.
    pub fn alive(&self) -> bool {
        match crate::os::process_stats(self.pid) {
            Some(st) => self
                .proc_start
                .zip(st.start_ticks)
                .is_none_or(|(r, s)| r == s),
            None => crate::os::pid_alive(self.pid),
        }
    }
}

/// The session files: regular `.json` files under `<dir>/sessions` (a link
/// is never followed), each with a pid, at most `MAX_SESSION_FILES`. One
/// read of the directory serves a whole look.
pub fn read_session_files(dir: &Path) -> Vec<SessionFile> {
    let Ok(entries) = std::fs::read_dir(dir.join("sessions")) else {
        return Vec::new();
    };
    entries
        .flatten()
        .take(MAX_SESSION_FILES)
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let mut text = String::new();
            std::fs::File::open(e.path())
                .ok()?
                .take(SESSION_FILE_BYTES)
                .read_to_string(&mut text)
                .ok()?;
            serde_json::from_str::<SessionFile>(&text).ok()
        })
        .filter(|f| f.pid > 0)
        .collect()
}

/// The report's sessions, alive ones first, newest first within each.
pub fn read_sessions(files: &[SessionFile]) -> Vec<Session> {
    let mut out: Vec<Session> = files.iter().map(session_of).collect();
    out.sort_by(|a, b| b.alive.cmp(&a.alive).then(b.started_at.cmp(&a.started_at)));
    out.truncate(MAX_SESSIONS);
    out
}

fn session_of(f: &SessionFile) -> Session {
    Session {
        pid: f.pid,
        transcript_id: f.session_id.clone(),
        remote_id: f.bridge_session_id.clone(),
        cwd: f.cwd.clone(),
        name: f.name.clone(),
        kind: f.kind.clone(),
        entrypoint: f.entrypoint.clone(),
        version: f.version.clone(),
        started_at: f.started_at,
        status: f.status.clone(),
        last_activity_at: f.status_updated_at.max(f.updated_at),
        alive: crate::os::pid_alive(f.pid),
    }
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
    let scopes = o
        .and_then(|o| o.get("scopes"))
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str())
                .take(32)
                .map(|s| s.chars().take(64).collect())
                .collect()
        })
        .unwrap_or_default();
    Credentials {
        present: true,
        store: Some("file".into()),
        subscription_type: s("subscriptionType"),
        rate_limit_tier: s("rateLimitTier"),
        expires_at: n("expiresAt"),
        refresh_expires_at: n("refreshTokenExpiresAt"),
        scopes,
    }
}

/// Where there is no credentials file: macOS keeps the login in the login
/// keychain, whose item's presence `os::claude_keychain_login` checks
/// without reading the secret (so no prompt); its dates stay unread.
/// Absent everywhere else.
fn keychain_credentials() -> Credentials {
    if crate::os::claude_keychain_login() {
        return Credentials {
            present: true,
            store: Some("keychain".into()),
            ..Default::default()
        };
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
        assert!(read_session_files(&dir).is_empty());

        std::fs::write(
            dir.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"secret","refreshToken":"secret","subscriptionType":"max","rateLimitTier":"t","expiresAt":1,"refreshTokenExpiresAt":2,"scopes":["user:inference","user:profile"]}}"#,
        )
        .unwrap();
        let c = read_credentials(&dir);
        assert!(c.present);
        assert_eq!(c.subscription_type.as_deref(), Some("max"));
        assert_eq!(c.refresh_expires_at, Some(2));
        assert_eq!(c.scopes, ["user:inference", "user:profile"]);
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
        let s = read_sessions(&read_session_files(&dir));
        assert_eq!(s.len(), 2);
        assert!(s[0].alive, "own pid is alive and sorts first");
        assert_eq!(s[0].remote_id.as_deref(), Some("session_1"));
        assert_eq!(s[0].last_activity_at, Some(7));
        assert!(!s[1].alive);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One reader, one set of rules for every use of the session files: a
    /// pid that does not fit is no pid (never truncated onto another
    /// process), `procStart` reads as a string or a number, and a link is
    /// not followed.
    #[test]
    fn the_session_files_are_read_one_way() {
        let dir = std::env::temp_dir().join(format!("daedalus-sfiles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sessions = dir.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let me = std::process::id();
        let write = |name: &str, text: String| std::fs::write(sessions.join(name), text).unwrap();
        write(
            "a.json",
            format!(r#"{{"pid":{me},"sessionId":"a","procStart":"42"}}"#),
        );
        write(
            "b.json",
            format!(r#"{{"pid":{me},"sessionId":"b","procStart":42}}"#),
        );
        // 2^32 + this pid: `as u32` would have made it this process.
        write(
            "c.json",
            format!(r#"{{"pid":{},"sessionId":"c"}}"#, (1u64 << 32) + u64::from(me)),
        );
        write("d.json", "not json".into());
        #[cfg(unix)]
        std::os::unix::fs::symlink(sessions.join("a.json"), sessions.join("e.json")).unwrap();
        let mut files = read_session_files(&dir);
        files.sort_by(|x, y| x.session_id.cmp(&y.session_id));
        let ids: Vec<_> = files.iter().map(|f| f.session_id.as_deref()).collect();
        assert_eq!(ids, [Some("a"), Some("b")]);
        assert!(files.iter().all(|f| f.pid == me && f.proc_start == Some(42)));
        // This process did not start at tick 42: on Linux the file is not
        // its; elsewhere the start is not compared and the pid runs.
        assert_eq!(files[0].alive(), cfg!(not(target_os = "linux")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
