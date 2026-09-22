//! Where the agent keeps things, and the few knobs it has.
//!
//! `install` writes config.toml once with the defaults below; after that the
//! file is the operator's. Every field has a default so a missing file or a
//! missing key never stops the service — a machine that lost its config
//! still stays awake, which is the one job.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tracing_appender::non_blocking::WorkerGuard;

/// The GitHub repository whose `agent-v*` releases this agent follows.
pub const DEFAULT_REPO: &str = "santiagotoscanini/daedalus";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// The LAN port the status page answers on.
    pub port: u16,
    /// `owner/name` on GitHub. Releases tagged `agent-v<semver>` are the feed.
    pub release_repo: String,
    /// How often the feed is asked, in seconds. GitHub allows 60 unauthenticated
    /// requests an hour from one address; the default spends six.
    pub update_check_secs: u64,
    /// Whether a newer release is installed automatically. Off means the
    /// status page says one is available and nothing else happens.
    pub auto_update: bool,
    /// `info` by default; `debug` for a bug report.
    pub log_level: String,
    /// The box's base URL, when it cannot be found through DNS (a machine
    /// whose resolver is not the box's). Empty means: find it.
    pub control_plane_url: Option<String>,
    /// Search domains to ask for the `_daedalus._tcp` record besides the
    /// ones DHCP handed the adapters.
    pub search_domains: Vec<String>,
    /// How often the agent announces itself to the box, in seconds.
    pub hello_secs: u64,
    /// Hold the machine awake. The local default; once the box has approved
    /// this machine, its Settings › Machines policy replaces it.
    pub awake_hold: bool,
    /// Run `claude remote-control` in the user's desktop session (the tray
    /// supervises it). Same rule: the box's policy replaces it once approved.
    pub claude_remote_control: bool,
    /// The directory the server runs in — where a session opened from
    /// claude.ai lands. Empty means the user's profile directory.
    pub claude_workdir: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 7787,
            release_repo: DEFAULT_REPO.into(),
            update_check_secs: 600,
            auto_update: true,
            log_level: "info".into(),
            control_plane_url: None,
            search_domains: Vec::new(),
            hello_secs: 60,
            awake_hold: true,
            claude_remote_control: true,
            claude_workdir: None,
        }
    }
}

impl Config {
    pub fn update_interval(&self) -> Duration {
        Duration::from_secs(self.update_check_secs.max(60))
    }
}

/// `C:\ProgramData\daedalus-agent` on Windows, `/Library/Application
/// Support/daedalus-agent` on macOS — config, state and logs. Falls back to
/// a directory beside the binary elsewhere, which is only ever a developer's
/// machine.
pub fn data_dir() -> PathBuf {
    if let Ok(pd) = std::env::var("ProgramData") {
        return PathBuf::from(pd).join(crate::SERVICE_NAME);
    }
    if cfg!(target_os = "macos") {
        return PathBuf::from("/Library/Application Support").join(crate::SERVICE_NAME);
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("data")))
        .unwrap_or_else(|| PathBuf::from("data"))
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.toml")
}

pub fn state_path() -> PathBuf {
    data_dir().join("state.json")
}

pub fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

/// Where the TRAY writes: the same folder on Windows (ProgramData lets a
/// user create files there); on macOS the data directory is root's, so the
/// user's own `~/Library/Logs/daedalus-agent`.
pub fn user_log_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        if let Some(h) = std::env::var_os("HOME") {
            return PathBuf::from(h)
                .join("Library")
                .join("Logs")
                .join(crate::SERVICE_NAME);
        }
    }
    log_dir()
}

pub fn load_or_default() -> Result<Config> {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text).with_context(|| format!("parsing {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// Writes the config file if there is none, so `install` never overwrites
/// an operator's edits on a reinstall. Only `install` calls it, and `install`
/// exists on Windows and macOS.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub fn write_if_absent(cfg: &Config) -> Result<PathBuf> {
    let path = config_path();
    std::fs::create_dir_all(data_dir()).context("creating the data directory")?;
    if !path.exists() {
        let text = format!(
            "# daedalus-agent — written by `install`; edit and restart the service.\n\n{}",
            toml::to_string_pretty(cfg)?
        );
        std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
    }
    Ok(path)
}

/// Daily-rotated file log, plus the terminal when running in the foreground.
/// The guard flushes the file writer when dropped, so the caller keeps it
/// for the life of the process.
pub fn init_logging(cfg: &Config, foreground: bool) -> Result<WorkerGuard> {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{fmt, EnvFilter};
    std::fs::create_dir_all(log_dir()).context("creating the log directory")?;
    let file = tracing_appender::rolling::daily(log_dir(), "agent.log");
    let (writer, guard) = tracing_appender::non_blocking(file);
    let filter = EnvFilter::try_new(&cfg.log_level).unwrap_or_else(|_| EnvFilter::new("info"));
    let to_file = fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(false);
    let to_terminal =
        foreground.then(|| fmt::layer().with_writer(std::io::stderr).with_target(false));
    tracing_subscriber::registry()
        .with(filter)
        .with(to_file)
        .with(to_terminal)
        .init();
    Ok(guard)
}
