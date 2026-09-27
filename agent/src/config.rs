//! Where the agent keeps things, and the few knobs it has.
//!
//! `install` writes config.toml once with the defaults below; after that the
//! file is the operator's. Every field has a default so a missing file or a
//! missing key never stops the service — a machine that lost its config
//! still stays awake, which is the one job. Keys the agent no longer knows
//! are ignored.
//!
//! The knobs, with their defaults:
//!
//! ```toml
//! port = 7787                 # the status page's LAN port
//! update_check_secs = 600     # how often the release feed is asked
//! auto_update = true          # the older spelling of `updates` (below)
//! log_level = "info"
//! control_plane_url = "…"     # the box, when DNS cannot find it; absent = find it
//! search_domains = []         # more domains to ask for `_daedalus._tcp`
//! hello_secs = 60             # how often the hello goes out
//! mode = "node"               # node | hub
//! telemetry = "full"          # full | minimal | off
//! updates = "self"            # self | staged | external
//! data_dir = "…"              # where state, identity and logs live; absent = the OS default
//! ```
//!
//! `mode` and `telemetry` are read and carried but change nothing yet: every
//! agent is a node that reports everything. `updates` decides whether a
//! newer release is installed: `self` installs it (today's behaviour);
//! `staged` and `external` only report it, as `auto_update = false` always
//! has. When `updates` is absent, `auto_update` decides (true = `self`,
//! false = report only); when both are present, `updates` wins.
//! `install` writes none of the four newer keys, so the file it leaves is
//! the one it has always written.
//!
//! The data directory is `C:\ProgramData\daedalus-agent` on Windows,
//! `/Library/Application Support/daedalus-agent` on macOS and
//! `/var/lib/daedalus-agent` on Linux (`os::default_data_dir`), with the
//! logs in its `logs/`. Two ways to move it, strongest first:
//!
//! - `DAEDALUS_AGENT_DATA_DIR` in the environment moves everything,
//!   config.toml included — for `serve` and development only (a Linux user
//!   run, a test machine). It moves only the process that has it: the SCM,
//!   launchd, the tray's Run key and `sudo` do not carry a shell's
//!   environment, so `install` and `uninstall` refuse to run while it is
//!   set rather than configure a service that would read elsewhere.
//! - `data_dir` in config.toml moves state, identity and logs — config.toml
//!   itself is always read from the default directory, since it cannot name
//!   where it is. This is the knob for an installed agent.
//!
//! Both must be absolute paths: a relative one would resolve against
//! whatever directory the process started in (System32 for a service, /
//! under launchd), and `load_or_default` refuses it with a message saying
//! so.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tracing_appender::non_blocking::WorkerGuard;

/// The GitHub repository whose `agent-v<semver>` releases this agent
/// follows. Not a knob: every release is verified against the key compiled
/// into this binary (update.rs), so another feed would need another build.
pub const DEFAULT_REPO: &str = "santiagotoscanini/daedalus";

/// The environment variable that moves the whole data directory.
pub const DATA_DIR_ENV: &str = "DAEDALUS_AGENT_DATA_DIR";

/// What the box decides — holding the machine awake, Claude remote control
/// and its directory, provider ports — is not here: it is the box's policy
/// (hello.rs), with `Policy::default()` standing until the box has approved
/// this machine. Keys an older install wrote for those are ignored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// The LAN port the status page answers on.
    pub port: u16,
    /// How often the feed is asked, in seconds. GitHub allows 60 unauthenticated
    /// requests an hour from one address; the default spends six.
    pub update_check_secs: u64,
    /// Whether a newer release is installed automatically. Off means the
    /// status page says one is available and nothing else happens. The
    /// older spelling of `updates`, which wins when present.
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
    /// What this agent is to the rest: an ordinary machine, or the hub on
    /// the box. Carried, not yet acted on.
    #[serde(skip_serializing_if = "is_default")]
    pub mode: Mode,
    /// How much of the machine the agent reports. Carried, not yet acted on.
    #[serde(skip_serializing_if = "is_default")]
    pub telemetry: TelemetryLevel,
    /// How a newer release reaches this machine; absent means `auto_update`
    /// decides (`Config::self_update_off`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updates: Option<UpdateMode>,
    /// Where state, identity and logs live, instead of the OS default. The
    /// environment's `DAEDALUS_AGENT_DATA_DIR` wins over it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Node,
    Hub,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryLevel {
    #[default]
    Full,
    Minimal,
    Off,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateMode {
    /// The agent installs a newer release itself.
    #[serde(rename = "self")]
    SelfInstall,
    /// Fetched and staged, applied on request. Today: reported only.
    Staged,
    /// Something else installs releases (nix, a package manager). Today:
    /// reported only.
    External,
}

fn is_default<T: Default + PartialEq>(v: &T) -> bool {
    *v == T::default()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 7787,
            update_check_secs: 600,
            auto_update: true,
            log_level: "info".into(),
            control_plane_url: None,
            search_domains: Vec::new(),
            hello_secs: 60,
            mode: Mode::default(),
            telemetry: TelemetryLevel::default(),
            updates: None,
            data_dir: None,
        }
    }
}

impl Config {
    pub fn update_interval(&self) -> Duration {
        Duration::from_secs(self.update_check_secs.max(60))
    }

    /// Why a newer release is only reported and not installed, as the
    /// status page words it; None when the agent installs it itself.
    /// `updates` decides when present, `auto_update` otherwise.
    pub fn self_update_off(&self) -> Option<&'static str> {
        match self.updates {
            Some(UpdateMode::SelfInstall) => None,
            Some(UpdateMode::Staged) => Some("updates = staged"),
            Some(UpdateMode::External) => Some("updates = external"),
            None if self.auto_update => None,
            None => Some("auto_update is off"),
        }
    }

    /// What parsing cannot say: `data_dir`, when set, must be absolute — a
    /// relative one would resolve against the directory the process
    /// started in (System32 for a service, / under launchd).
    pub fn validate(&self) -> Result<()> {
        if let Some(p) = non_empty(self.data_dir.clone()) {
            if !p.is_absolute() {
                bail!("data_dir must be an absolute path, not {}", p.display());
            }
        }
        Ok(())
    }
}

/// A path from the environment or the file, when it names one.
fn non_empty(p: Option<PathBuf>) -> Option<PathBuf> {
    p.filter(|p| !p.as_os_str().is_empty())
}

/// The pure half of reading `DAEDALUS_AGENT_DATA_DIR`: unset or empty is
/// None; a relative path is an error (it would resolve against whatever
/// directory the process started in — System32 for a service, / under
/// launchd).
fn env_dir(value: Option<OsString>) -> Result<Option<PathBuf>> {
    match non_empty(value.map(PathBuf::from)) {
        Some(p) if !p.is_absolute() => bail!(
            "{DATA_DIR_ENV} must be an absolute path, not {}",
            p.display()
        ),
        other => Ok(other),
    }
}

/// The environment's data directory, when it names a valid one.
fn env_data_dir() -> Result<Option<PathBuf>> {
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

pub fn state_path() -> PathBuf {
    data_dir().join("state.json")
}

pub fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

/// Where the TRAY writes: the same folder on Windows (ProgramData lets a
/// user create files there); on macOS the data directory is root's, so the
/// user's own `~/Library/Logs/daedalus-agent` (`os::user_log_dir`).
pub fn user_log_dir() -> PathBuf {
    crate::os::user_log_dir().unwrap_or_else(log_dir)
}

/// The config, or the defaults when there is no file. Refuses a relative
/// `DAEDALUS_AGENT_DATA_DIR` or `data_dir` — every entry point (the
/// service, `serve`, the tray, the verbs that read the port) calls this
/// first, so a bad value stops the process with that message.
pub fn load_or_default() -> Result<Config> {
    env_data_dir()?;
    let path = config_path();
    let cfg: Config = match std::fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config::default(),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    cfg.validate()
        .with_context(|| format!("checking {}", path.display()))?;
    Ok(cfg)
}

/// The pure half of `refuse_env_override`.
fn refuse_env_for(verb: &str, env: Option<OsString>) -> Result<()> {
    if non_empty(env.map(PathBuf::from)).is_some() {
        bail!(
            "{DATA_DIR_ENV} is set; `{verb}` refuses to run with it. The service, the tray and \
             sudo do not carry this shell's environment, so what `{verb}` wrote there would not \
             be what they read. It is for `serve` and development only; unset it and run again, \
             or move the data with `data_dir` in config.toml."
        );
    }
    Ok(())
}

/// `install` and `uninstall` refuse to run under `DAEDALUS_AGENT_DATA_DIR`:
/// it moves only the process that has it, so an install made with it would
/// split the config from the service it configures.
pub fn refuse_env_override(verb: &str) -> Result<()> {
    refuse_env_for(verb, std::env::var_os(DATA_DIR_ENV))
}

/// Writes the config file if there is none, so `install` never overwrites
/// an operator's edits on a reinstall. Only `install` calls it.
pub fn write_if_absent(cfg: &Config) -> Result<PathBuf> {
    let path = config_path();
    std::fs::create_dir_all(config_dir()).context("creating the data directory")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_config_written_by_an_earlier_install_still_loads() {
        // `install` wrote every field; the policy knobs and `release_repo`
        // left, and a file that still names them must parse as before.
        let text = "port = 7788\nrelease_repo = \"x/y\"\nawake_hold = false\n\
                    claude_remote_control = false\nclaude_workdir = \"C:/p\"\n";
        let cfg: Config = toml::from_str(text).unwrap();
        assert_eq!(cfg.port, 7788);
        assert_eq!(cfg.hello_secs, 60);
    }

    /// What `install` wrote before the newer keys existed, byte for byte
    /// (`toml::to_string_pretty(&Config::default())` from 0.13.0).
    const WRITTEN_BY_0_13: &str = "port = 7787\nupdate_check_secs = 600\nauto_update = true\n\
                                   log_level = \"info\"\nsearch_domains = []\nhello_secs = 60\n";

    #[test]
    fn install_writes_the_file_it_always_wrote() {
        assert_eq!(
            toml::to_string_pretty(&Config::default()).unwrap(),
            WRITTEN_BY_0_13
        );
    }

    #[test]
    fn an_old_file_parses_to_todays_defaults() {
        let cfg: Config = toml::from_str(WRITTEN_BY_0_13).unwrap();
        assert_eq!(cfg, Config::default());
        assert_eq!(cfg.mode, Mode::Node);
        assert_eq!(cfg.telemetry, TelemetryLevel::Full);
        assert_eq!(cfg.updates, None);
        assert_eq!(cfg.data_dir, None);
        assert_eq!(cfg.self_update_off(), None);
        // Every knob an operator could have set, and a key no longer known.
        let edited = "port = 7790\nupdate_check_secs = 1200\nauto_update = false\n\
                      log_level = \"debug\"\ncontrol_plane_url = \"https://box.lan\"\n\
                      search_domains = [\"lan\"]\nhello_secs = 30\nrelease_repo = \"x/y\"\n";
        let cfg: Config = toml::from_str(edited).unwrap();
        assert_eq!(
            cfg,
            Config {
                port: 7790,
                update_check_secs: 1200,
                auto_update: false,
                log_level: "debug".into(),
                control_plane_url: Some("https://box.lan".into()),
                search_domains: vec!["lan".into()],
                hello_secs: 30,
                ..Config::default()
            }
        );
        assert_eq!(cfg.self_update_off(), Some("auto_update is off"));
    }

    #[test]
    fn the_newer_keys_parse() {
        let cfg: Config = toml::from_str(
            "mode = \"hub\"\ntelemetry = \"minimal\"\nupdates = \"external\"\n\
             data_dir = \"/srv/agent\"\n",
        )
        .unwrap();
        assert_eq!(cfg.mode, Mode::Hub);
        assert_eq!(cfg.telemetry, TelemetryLevel::Minimal);
        assert_eq!(cfg.updates, Some(UpdateMode::External));
        assert_eq!(cfg.data_dir.as_deref(), Some(Path::new("/srv/agent")));
        let off: Config = toml::from_str("telemetry = \"off\"\nupdates = \"staged\"").unwrap();
        assert_eq!(off.telemetry, TelemetryLevel::Off);
        assert_eq!(off.updates, Some(UpdateMode::Staged));
        let own: Config = toml::from_str("mode = \"node\"\nupdates = \"self\"").unwrap();
        assert_eq!(own.mode, Mode::Node);
        assert_eq!(own.updates, Some(UpdateMode::SelfInstall));
        assert!(toml::from_str::<Config>("mode = \"box\"").is_err());
        // Written back, a non-default value keeps its key.
        let text = toml::to_string_pretty(&cfg).unwrap();
        assert!(text.contains("mode = \"hub\""), "{text}");
        assert!(text.contains("updates = \"external\""), "{text}");
        assert!(text.contains("data_dir = \"/srv/agent\""), "{text}");
    }

    #[test]
    fn updates_wins_over_auto_update() {
        let off = |text: &str| toml::from_str::<Config>(text).unwrap().self_update_off();
        assert_eq!(off(""), None);
        assert_eq!(off("auto_update = true"), None);
        assert_eq!(off("auto_update = false"), Some("auto_update is off"));
        assert_eq!(off("auto_update = false\nupdates = \"self\""), None);
        assert_eq!(
            off("auto_update = true\nupdates = \"staged\""),
            Some("updates = staged")
        );
        assert_eq!(
            off("auto_update = true\nupdates = \"external\""),
            Some("updates = external")
        );
    }

    /// An absolute path on the OS the tests run on ("/x" is not absolute on
    /// Windows, which has no drive in it).
    fn abs(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
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

    #[test]
    fn relative_directories_are_refused() {
        assert_eq!(env_dir(None).unwrap(), None);
        assert_eq!(env_dir(Some(OsString::new())).unwrap(), None);
        assert_eq!(env_dir(Some(abs("env").into())).unwrap(), Some(abs("env")));
        let err = env_dir(Some("data".into())).unwrap_err().to_string();
        assert!(
            err.contains(DATA_DIR_ENV) && err.contains("absolute"),
            "{err}"
        );

        let cfg = |text: &str| toml::from_str::<Config>(text).unwrap().validate();
        assert!(cfg("").is_ok());
        assert!(cfg("data_dir = \"\"").is_ok());
        assert!(cfg("data_dir = \"data\"").is_err());
        assert!(cfg("data_dir = \"./data\"").is_err());
        let ok = Config {
            data_dir: Some(abs("cfg")),
            ..Config::default()
        };
        assert!(ok.validate().is_ok());
    }

    #[test]
    fn install_and_uninstall_refuse_the_environment_override() {
        assert!(refuse_env_for("install", None).is_ok());
        assert!(refuse_env_for("install", Some(OsString::new())).is_ok());
        let err = refuse_env_for("uninstall", Some(abs("env").into()))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains(DATA_DIR_ENV) && err.contains("`uninstall`"),
            "{err}"
        );
    }
}
