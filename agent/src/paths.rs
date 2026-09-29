//! Where the agent keeps things: the config, data, state, log and socket
//! paths, and the names a development run derives from its own data
//! directory (config.rs's module doc says where each lands and how it
//! moves).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{bail, Result};

use crate::config::Config;

/// The environment variable that moves the whole data directory.
pub const DATA_DIR_ENV: &str = "DAEDALUS_AGENT_DATA_DIR";
/// A path from the environment or the file, when it names one.
pub(crate) fn non_empty(p: Option<PathBuf>) -> Option<PathBuf> {
    p.filter(|p| !p.as_os_str().is_empty())
}

/// The pure half of reading `DAEDALUS_AGENT_DATA_DIR`: unset or empty is
/// None; a relative path is an error (it would resolve against whatever
/// directory the process started in — System32 for a service, / under
/// launchd).
pub(crate) fn env_dir(value: Option<OsString>) -> Result<Option<PathBuf>> {
    match non_empty(value.map(PathBuf::from)) {
        Some(p) if !p.is_absolute() => bail!(
            "{DATA_DIR_ENV} must be an absolute path, not {}",
            p.display()
        ),
        other => Ok(other),
    }
}

/// The environment's data directory, when it names a valid one.
pub(crate) fn env_data_dir() -> Result<Option<PathBuf>> {
    env_dir(std::env::var_os(DATA_DIR_ENV))
}

/// The pure half of `config_dir`: the environment's directory, else the
/// OS default. An invalid environment value falls back here; it is
/// `load_or_default`, which every entry point calls first, that refuses it.
fn config_dir_from(env: Option<OsString>, default: PathBuf) -> PathBuf {
    env_dir(env).ok().flatten().unwrap_or(default)
}

/// The directory config.toml is read from: the environment's data
/// directory, else the OS default.
pub fn config_dir() -> PathBuf {
    config_dir_from(
        std::env::var_os(DATA_DIR_ENV),
        crate::os::default_data_dir(),
    )
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

/// The pure half of `data_dir`: the environment's directory wins; else the
/// `data_dir` config.toml names (read from `default`), when it is absolute;
/// else `default`.
fn resolve_data_dir(
    env: Option<OsString>,
    default: PathBuf,
    configured: impl FnOnce(&Path) -> Option<PathBuf>,
) -> PathBuf {
    if let Ok(Some(dir)) = env_dir(env) {
        return dir;
    }
    non_empty(configured(&default.join("config.toml")))
        .filter(|p| p.is_absolute())
        .unwrap_or(default)
}

/// Config, state, identity and logs; see the module doc for where that is
/// and how it moves. Resolved once per process.
pub fn data_dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        resolve_data_dir(
            std::env::var_os(DATA_DIR_ENV),
            crate::os::default_data_dir(),
            |path| {
                let text = std::fs::read_to_string(path).ok()?;
                toml::from_str::<Config>(&text).ok()?.data_dir
            },
        )
    })
    .clone()
}

/// Where the last policy from the controller is kept (`save_policy`).
pub fn policy_path() -> PathBuf {
    data_dir().join("policy.json")
}

/// The last policy the controller sent this machine, as the service kept
/// it; None before the first, or when the file is unreadable. The service
/// starts from it, and so does the session (session.rs), so Claude comes up
/// where and as the box last said, not once with the defaults and again
/// when the link answers.
pub fn last_policy() -> Option<crate::link::wire::Policy> {
    let path = policy_path();
    let text = std::fs::read_to_string(&path).ok()?;
    // It says where Claude runs and in which directory: only one the OS or
    // the agent wrote counts.
    if let Err(e) = crate::private::check_owner(&path) {
        tracing::warn!(error = %e, "the kept policy is not trusted; starting from the defaults");
        return None;
    }
    serde_json::from_str(&text).ok()
}

/// Keep the policy the controller sent (not a secret: readable by the
/// session, which runs as the user).
pub fn save_policy(p: &crate::link::wire::Policy) {
    // Tests run links against a real data directory's path: never write it.
    if cfg!(test) {
        return;
    }
    let path = policy_path();
    let wrote = serde_json::to_string_pretty(p)
        .map_err(std::io::Error::other)
        .and_then(|t| {
            crate::util::write_atomic(&path, t.as_bytes(), crate::util::Access::Mode(0o644))
        });
    if let Err(e) = wrote {
        tracing::warn!(path = %path.display(), error = %e, "the policy was not kept");
    }
}

pub fn state_path() -> PathBuf {
    data_dir().join("state.json")
}

pub fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

/// Where the TRAY and the session write: the same folder on Windows
/// (ProgramData lets a user create files there); on macOS and Linux the
/// data directory is root's, so the user's own — `~/Library/Logs/daedalus-agent`,
/// `$XDG_STATE_HOME/daedalus-agent` (`os::user_log_dir`).
pub fn user_log_dir() -> PathBuf {
    crate::os::user_log_dir().unwrap_or_else(log_dir)
}

/// The session's own state, the user's rather than the machine's: its
/// Claude jobs' records (Windows) and plists (macOS), their gcroots, and the
/// sessions to recover after a Remote Control restart —
/// `%LOCALAPPDATA%\daedalus-agent`, `~/Library/Application Support/daedalus-agent`,
/// `$XDG_STATE_HOME/daedalus-agent` (`os::user_state_dir`); the data
/// directory under `DAEDALUS_AGENT_DATA_DIR`. The controller's session uses
/// the data directory itself, which is its user's.
pub fn user_state_dir() -> PathBuf {
    crate::os::user_state_dir().unwrap_or_else(data_dir)
}

/// The name of the job the session runs Claude remote control as
/// (jobs/): the unit's on Linux, the launchd label's last part on
/// macOS, the record's on Windows. A process started with
/// `DAEDALUS_AGENT_DATA_DIR` gets a name of its own, derived from that
/// directory, so a development `session` never touches the server an
/// installed agent runs.
pub fn claude_unit_name() -> String {
    claude_unit_for(env_data_dir().ok().flatten().as_deref())
}

/// The pure half of `claude_unit_name`.
fn claude_unit_for(env_dir: Option<&Path>) -> String {
    match env_dir {
        None => "daedalus-claude-rc".into(),
        Some(d) => {
            use sha2::Digest;
            let digest = sha2::Sha256::digest(d.as_os_str().as_encoded_bytes());
            format!("daedalus-claude-rc-{}", &hex::encode(digest)[..10])
        }
    }
}

/// The start of every resumed session's unit name (claude/sessions.rs):
/// `claude-session-`, then the session uuid. A process started with
/// `DAEDALUS_AGENT_DATA_DIR` gets a prefix of its own, as its Claude unit
/// does, so a development run never lists or stops an installed agent's
/// sessions.
pub fn claude_session_prefix() -> String {
    claude_session_prefix_for(env_data_dir().ok().flatten().as_deref())
}

/// The pure half of `claude_session_prefix`.
fn claude_session_prefix_for(env_dir: Option<&Path>) -> String {
    match env_dir {
        None => "claude-session-".into(),
        Some(d) => {
            use sha2::Digest;
            let digest = sha2::Sha256::digest(d.as_os_str().as_encoded_bytes());
            format!("claude-session-{}-", &hex::encode(digest)[..10])
        }
    }
}

/// The agent's local socket (local.rs): `<data_dir>/run/agent.sock` on
/// macOS and Linux, the pipe `\\.\pipe\daedalus-agent` on Windows. A
/// process started with `DAEDALUS_AGENT_DATA_DIR` gets a pipe of its own
/// (its socket moves with the directory anyway), so a development run never
/// answers or asks for an installed agent.
pub fn local_socket() -> PathBuf {
    let dev = env_data_dir().ok().flatten().map(|d| {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(d.as_os_str().as_encoded_bytes()))[..10].to_string()
    });
    crate::os::local_socket_path(&data_dir(), dev.as_deref())
}

/// The config, or the defaults when there is no file. Refuses a relative
/// `DAEDALUS_AGENT_DATA_DIR` or `data_dir` — every entry point (the
/// service, `serve`, the tray, the verbs that read the port) calls this
/// first, so a bad value stops the process with that message.
#[cfg(test)]
mod tests {
    use super::*;

    /// An absolute path on the OS the tests run on ("/x" is not absolute on
    /// Windows, which has no drive in it).
    fn abs(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn a_development_session_names_its_own_claude_unit() {
        assert_eq!(claude_unit_for(None), "daedalus-claude-rc");
        let a = claude_unit_for(Some(&abs("a")));
        let b = claude_unit_for(Some(&abs("b")));
        assert!(a.starts_with("daedalus-claude-rc-") && a.len() == 29, "{a}");
        assert_ne!(a, b);
        assert_eq!(a, claude_unit_for(Some(&abs("a"))));
        assert_eq!(claude_session_prefix_for(None), "claude-session-");
        let p = claude_session_prefix_for(Some(&abs("a")));
        assert!(
            p.starts_with("claude-session-") && p.ends_with('-') && p.len() == 26,
            "{p}"
        );
        assert_ne!(p, claude_session_prefix_for(Some(&abs("b"))));
    }

    #[test]
    fn the_data_directory_moves_env_first_then_config() {
        let default = abs("default");
        let file = default.join("config.toml");
        let from_file = |want: Option<PathBuf>| {
            let file = file.clone();
            move |p: &Path| {
                assert_eq!(p, file);
                want
            }
        };
        assert_eq!(
            resolve_data_dir(None, default.clone(), from_file(None)),
            default
        );
        assert_eq!(
            resolve_data_dir(None, default.clone(), from_file(Some(abs("cfg")))),
            abs("cfg")
        );
        assert_eq!(
            resolve_data_dir(None, default.clone(), from_file(Some(PathBuf::new()))),
            default
        );
        // A relative `data_dir` is refused by `load_or_default`; here it is
        // never used.
        assert_eq!(
            resolve_data_dir(None, default.clone(), from_file(Some("rel".into()))),
            default
        );
        assert_eq!(
            resolve_data_dir(Some(abs("env").into()), default.clone(), |_| {
                panic!("the environment wins without reading the file")
            }),
            abs("env")
        );
        assert_eq!(
            resolve_data_dir(
                Some(OsString::new()),
                default.clone(),
                from_file(Some(abs("cfg")))
            ),
            abs("cfg")
        );
    }

    #[test]
    fn the_environment_moves_config_toml_too() {
        let default = abs("default");
        assert_eq!(
            config_dir_from(Some(abs("env").into()), default.clone()),
            abs("env")
        );
        assert_eq!(
            config_dir_from(Some(OsString::new()), default.clone()),
            default
        );
        assert_eq!(config_dir_from(None, default.clone()), default);
    }
}
