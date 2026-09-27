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
//! mode = "node"               # node | controller
//! telemetry = "full"          # full | minimal | off
//! updates = "self"            # self | staged | external
//! data_dir = "…"              # where state, identity and logs live; absent = the OS default
//! claude_rc = "child"         # child | unit; absent = the OS's (`os::CLAUDE_RC`)
//!
//! [controller]                # read only when mode = "controller"; nix writes it
//! claude_remote_control = false   # run Claude remote control on the box
//! claude_workdir = "…"        # where; absent = the most recent trusted project
//! claude_unit = "…"           # its transient user unit; absent = daedalus-claude-rc
//! api_socket = "…"            # the local API socket; absent = see below
//! api_allowed_uids = []       # host uids served besides the agent's own
//! ```
//!
//! `mode` decides which parts of the agent run at all — an ordinary machine
//! (`node`) or the box's own agent (`controller`); role.rs has the table.
//! `telemetry` decides how much of the machine is read and reported:
//! `full` is everything telemetry.rs lists; `minimal` is the machine and
//! how it is doing — make, model, firmware, OS, processor, memory, volumes,
//! GPUs, temperatures, network, battery, providers and what could not be
//! read — and never reads the drives (their serials and SMART), the
//! services, the browsers, the installed applications or the OS's pending
//! updates; processes are sampled for the count, but the list is not
//! reported, and a provider shows only while it answers on its port
//! (`Telemetry::minimal`); `off` reads nothing, so the page's
//! `telemetry` is null and `/metrics` is empty. `updates` decides whether a
//! newer release is installed: `self` installs it (today's behaviour);
//! `staged` and `external` only report it, as `auto_update = false` always
//! has. When `updates` is absent, `auto_update` decides (true = `self`,
//! false = report only); when both are present, `updates` wins.
//! `claude_rc` is how the session runs `claude remote-control`: as its own
//! child (Windows, macOS), or as a transient systemd user unit it starts and
//! watches (Linux), which outlives the session (claude/unit.rs).
//! `install` writes none of the newer keys, so the file it leaves is the one
//! it has always written.
//!
//! `[controller]` is the box's own policy. A node takes its policy from the
//! box's answer to its hello; the controller has no hello, so what nix
//! writes here stands in for it: whether Claude remote control runs (off
//! unless this says so — the box must never start a second Claude by
//! surprise) and where (`claude_workdir`, an absolute path). A controller
//! never holds the machine awake
//! (role.rs). `claude_unit` names Claude's transient user unit, so nix can
//! pick one that cannot collide with a unit the box already runs; without
//! it the controller uses the node's name (`claude_unit_name`).
//! `api_socket` is where the local API listens (api/); absent, it is
//! `$XDG_RUNTIME_DIR/daedalus-agent/api.sock`, or `<data_dir>/run/api.sock`
//! where no runtime directory is set. The directory it sits in is made
//! 0700 when the agent creates it (0711 with uids listed, below; one that
//! exists is never changed, and is refused if it is a symlink, not the
//! agent's user's, or writable by group or others), and is meant to hold
//! the socket alone, so it can be mounted into the app's container as it
//! is.
//! `api_allowed_uids` names the HOST uids the socket serves besides the
//! agent's own, which is always served: the published app image runs as
//! `node` (container uid 1000, host uid 100999 under rootless podman), so
//! nix either lists that uid here or runs the container with
//! `--userns=keep-id` so it arrives as the operator (api/mod.rs). With uids
//! listed the socket is 0666 — the peer check, not the file mode, is then
//! the gate. Root (uid 0) cannot be listed.
//!
//! On a node the table is ignored, except that it must parse: a key it
//! does not know is an error in every mode, so a typo in what nix writes
//! fails loudly instead of leaving a default in place.
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
    /// What this agent is to the rest: an ordinary machine, or the
    /// controller on the box. Decides which parts run (role.rs).
    #[serde(skip_serializing_if = "is_default")]
    pub mode: Mode,
    /// How much of the machine the agent reads and reports (module doc).
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
    /// How the session runs Claude remote control; absent means the OS's
    /// way (`Config::claude_rc`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_rc: Option<ClaudeRc>,
    /// The controller's own policy and its local API; ignored on a node.
    #[serde(skip_serializing_if = "is_default")]
    pub controller: ControllerConfig,
}

/// `[controller]`: what nix decides for the box's agent, which has no hello
/// to bring it a policy (module doc).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ControllerConfig {
    /// Run Claude remote control. Off unless nix says so.
    pub claude_remote_control: bool,
    /// The directory it runs in; absent = the most recent trusted project.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_workdir: Option<String>,
    /// Its transient systemd user unit, without `.service`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_unit: Option<String>,
    /// Where the local API socket is made.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_socket: Option<PathBuf>,
    /// Host uids the socket serves besides the agent's own (module doc).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub api_allowed_uids: Vec<u32>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// An ordinary machine on the network.
    #[default]
    Node,
    /// The box's own agent, which nix builds, configures and updates.
    Controller,
}

/// How `claude remote-control` is run by the session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeRc {
    /// A child of the session process, ended with it.
    Child,
    /// A transient systemd user unit the session starts, stops and
    /// re-attaches to, which outlives the session.
    Unit,
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
            claude_rc: None,
            controller: ControllerConfig::default(),
        }
    }
}

impl Config {
    /// How the session runs Claude remote control: the config's word, else
    /// the OS's (`os::CLAUDE_RC`: a child on Windows and macOS, a unit on
    /// Linux).
    pub fn claude_rc(&self) -> ClaudeRc {
        resolve_claude_rc(self.claude_rc, crate::os::CLAUDE_RC)
    }

    /// Which parts of the agent run on this machine (role.rs).
    pub fn role(&self) -> crate::role::Role {
        crate::role::Role::of(self.mode)
    }

    /// The policy that stands at start. A node's is `Policy::default()`
    /// until the box answers a hello; the controller's is `[controller]`'s
    /// for good — no awake hold, and Claude only when nix asked for it.
    pub fn initial_policy(&self) -> crate::hello::Policy {
        match self.mode {
            Mode::Node => crate::hello::Policy::default(),
            Mode::Controller => crate::hello::Policy {
                awake_hold: false,
                claude_remote_control: self.controller.claude_remote_control,
                claude_workdir: self.controller.claude_workdir.clone(),
                providers: Default::default(),
            },
        }
    }

    /// The transient user unit Claude remote control runs in: the
    /// controller's `claude_unit` when nix names one, else
    /// `claude_unit_name` — a node's is never configurable.
    pub fn claude_unit(&self) -> String {
        match (
            self.mode,
            non_empty_str(self.controller.claude_unit.as_deref()),
        ) {
            (Mode::Controller, Some(name)) => name.to_string(),
            _ => claude_unit_name(),
        }
    }

    /// Where the local API socket is made (module doc).
    pub fn api_socket(&self) -> PathBuf {
        resolve_api_socket(
            non_empty(self.controller.api_socket.clone()),
            std::env::var_os("XDG_RUNTIME_DIR"),
            data_dir,
        )
    }

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
        // `[controller]` is read only in controller mode, so only there can
        // it stop the agent.
        if self.mode == Mode::Controller {
            if let Some(p) = non_empty(self.controller.api_socket.clone()) {
                if !p.is_absolute() {
                    bail!(
                        "controller.api_socket must be an absolute path, not {}",
                        p.display()
                    );
                }
            }
            if let Some(w) = non_empty_str(self.controller.claude_workdir.as_deref()) {
                if !Path::new(w).is_absolute() {
                    bail!("controller.claude_workdir must be an absolute path, not {w}");
                }
            }
            let uids = &self.controller.api_allowed_uids;
            if uids.contains(&0) {
                bail!("controller.api_allowed_uids may not name root (uid 0)");
            }
            if uids.contains(&u32::MAX) {
                bail!("controller.api_allowed_uids may not name uid 4294967295 (no user)");
            }
            if let Some(u) = non_empty_str(self.controller.claude_unit.as_deref()) {
                if !valid_unit_name(u) {
                    bail!(
                        "controller.claude_unit must be a plain unit name (letters, digits, \
                         `-`, `_`, `.`, `:`; not starting with `-`; without `.service`), not {u:?}"
                    );
                }
            }
        }
        Ok(())
    }
}

/// A name `systemd-run --unit=` takes as it is and nothing else: no
/// template, no suffix, no option-looking first character.
fn valid_unit_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('-')
        && !name.ends_with(".service")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// A string from the file, when it says something.
fn non_empty_str(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// The pure half of `Config::api_socket`: the configured path; else
/// `$XDG_RUNTIME_DIR/daedalus-agent/api.sock` when the runtime directory is
/// an absolute path; else `<data_dir>/run/api.sock`.
fn resolve_api_socket(
    configured: Option<PathBuf>,
    runtime_dir: Option<OsString>,
    data_dir: impl FnOnce() -> PathBuf,
) -> PathBuf {
    if let Some(p) = configured {
        return p;
    }
    match non_empty(runtime_dir.map(PathBuf::from)).filter(|p| p.is_absolute()) {
        Some(run) => run.join(crate::SERVICE_NAME).join("api.sock"),
        None => data_dir().join("run").join("api.sock"),
    }
}

/// The pure half of `Config::claude_rc`. A unit needs systemd, so where the
/// OS runs Claude as a child (Windows, macOS) `claude_rc = "unit"` is
/// ignored with a warning rather than tried and retried; on Linux either
/// strategy stands.
fn resolve_claude_rc(configured: Option<ClaudeRc>, os_default: ClaudeRc) -> ClaudeRc {
    match (configured, os_default) {
        (Some(ClaudeRc::Unit), ClaudeRc::Child) => {
            tracing::warn!(
                "claude_rc = \"unit\" is ignored here: this OS runs Claude remote control as a child"
            );
            ClaudeRc::Child
        }
        (Some(c), _) => c,
        (None, d) => d,
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

/// Where the TRAY and the session write: the same folder on Windows
/// (ProgramData lets a user create files there); on macOS and Linux the
/// data directory is root's, so the user's own — `~/Library/Logs/daedalus-agent`,
/// `$XDG_STATE_HOME/daedalus-agent` (`os::user_log_dir`).
pub fn user_log_dir() -> PathBuf {
    crate::os::user_log_dir().unwrap_or_else(log_dir)
}

/// The transient systemd user unit the session runs Claude remote control
/// in, when `claude_rc = "unit"` (claude/unit.rs). A process started with
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
    init_logging_to(cfg, &log_dir(), "agent.log", foreground)
}

/// The same, into `dir/<name>.<date>`: the headless session logs as its
/// user, into `user_log_dir`, as `session.log`.
pub fn init_logging_to(
    cfg: &Config,
    dir: &Path,
    name: &str,
    foreground: bool,
) -> Result<WorkerGuard> {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{fmt, EnvFilter};
    std::fs::create_dir_all(dir).context("creating the log directory")?;
    let file = tracing_appender::rolling::daily(dir, name);
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
            "mode = \"controller\"\ntelemetry = \"minimal\"\nupdates = \"external\"\n\
             data_dir = \"/srv/agent\"\n",
        )
        .unwrap();
        assert_eq!(cfg.mode, Mode::Controller);
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
        assert!(text.contains("mode = \"controller\""), "{text}");
        assert!(text.contains("updates = \"external\""), "{text}");
        assert!(text.contains("data_dir = \"/srv/agent\""), "{text}");
    }

    #[test]
    fn claude_rc_parses_and_defaults_to_the_os() {
        let cfg: Config = toml::from_str("claude_rc = \"unit\"").unwrap();
        assert_eq!(cfg.claude_rc, Some(ClaudeRc::Unit));
        let cfg: Config = toml::from_str("claude_rc = \"child\"").unwrap();
        assert_eq!(cfg.claude_rc(), ClaudeRc::Child);
        assert_eq!(Config::default().claude_rc(), crate::os::CLAUDE_RC);
        // Linux (unit by default) takes either; a child-only OS ignores "unit".
        use ClaudeRc::{Child, Unit};
        assert_eq!(resolve_claude_rc(Some(Child), Unit), Child);
        assert_eq!(resolve_claude_rc(Some(Unit), Unit), Unit);
        assert_eq!(resolve_claude_rc(None, Unit), Unit);
        assert_eq!(resolve_claude_rc(Some(Unit), Child), Child);
        assert_eq!(resolve_claude_rc(None, Child), Child);
        assert!(toml::from_str::<Config>("claude_rc = \"thread\"").is_err());
        let cfg: Config = toml::from_str("mode = \"controller\"").unwrap();
        assert_eq!(cfg.mode, Mode::Controller);
    }

    #[test]
    fn the_controller_table_is_the_boxs_policy_and_a_node_ignores_it() {
        let text = "mode = \"controller\"\n[controller]\nclaude_remote_control = true\n\
                    claude_workdir = \"/srv/work\"\nclaude_unit = \"daedalus-claude\"\n\
                    api_socket = \"/run/daedalus-api/api.sock\"\n";
        let cfg: Config = toml::from_str(text).unwrap();
        assert!(cfg.validate().is_ok());
        let p = cfg.initial_policy();
        assert!(!p.awake_hold, "a controller never holds the machine awake");
        assert!(p.claude_remote_control);
        assert_eq!(p.claude_workdir.as_deref(), Some("/srv/work"));
        assert_eq!(cfg.claude_unit(), "daedalus-claude");
        assert_eq!(
            cfg.api_socket(),
            PathBuf::from("/run/daedalus-api/api.sock")
        );
        // Written back, the table keeps its keys.
        let back = toml::to_string_pretty(&cfg).unwrap();
        assert!(
            back.contains("[controller]") && back.contains("claude_unit"),
            "{back}"
        );

        // Absent: Claude stays off on the box — never a second Claude.
        let bare: Config = toml::from_str("mode = \"controller\"").unwrap();
        let p = bare.initial_policy();
        assert!(!p.awake_hold && !p.claude_remote_control && p.claude_workdir.is_none());
        assert_eq!(bare.claude_unit(), claude_unit_name());

        // The same table on a node changes nothing, and never stops it.
        let node: Config = toml::from_str(
            "[controller]\nclaude_remote_control = false\nclaude_unit = \"-x\"\napi_socket = \"rel\"\n",
        )
        .unwrap();
        assert!(node.validate().is_ok());
        assert_eq!(node.initial_policy(), crate::hello::Policy::default());
        assert_eq!(node.claude_unit(), claude_unit_name());
    }

    #[test]
    fn the_controller_table_is_checked_in_controller_mode() {
        let check = |table: &str| {
            toml::from_str::<Config>(&format!("mode = \"controller\"\n[controller]\n{table}"))
                .unwrap()
                .validate()
        };
        assert!(check("api_socket = \"rel/api.sock\"").is_err());
        assert!(check("claude_unit = \"-rf\"").is_err());
        assert!(check("claude_unit = \"x.service\"").is_err());
        assert!(check("claude_unit = \"a b\"").is_err());
        assert!(check("claude_unit = \"daedalus-claude-rc@1\"").is_err());
        assert!(check("claude_unit = \"daedalus-claude_rc.box:1\"").is_ok());
        assert!(check("claude_unit = \"\"").is_ok());
        assert!(check("claude_workdir = \"projects/x\"").is_err());
        assert!(check("claude_workdir = \"/home/op/projects/x\"").is_ok());
        assert!(check("api_allowed_uids = [100999]").is_ok());
        assert!(check("api_allowed_uids = [0]").is_err());
        assert!(check("api_allowed_uids = [4294967295]").is_err());
        assert!(toml::from_str::<Config>("[controller]\napi_allowed_uids = [-1]").is_err());
        // A typo fails loudly, in either mode, at parse.
        for mode in ["controller", "node"] {
            let typo = format!("mode = \"{mode}\"\n[controller]\nclaude_remote_contrl = true\n");
            assert!(toml::from_str::<Config>(&typo).is_err(), "{mode}");
        }
    }

    #[test]
    fn the_api_socket_prefers_the_runtime_directory() {
        let data = || abs("data");
        assert_eq!(
            resolve_api_socket(Some(abs("s.sock")), Some(abs("run").into()), data),
            abs("s.sock")
        );
        assert_eq!(
            resolve_api_socket(None, Some(abs("run").into()), data),
            abs("run").join("daedalus-agent").join("api.sock")
        );
        assert_eq!(
            resolve_api_socket(None, Some("relative".into()), data),
            abs("data").join("run").join("api.sock")
        );
        assert_eq!(
            resolve_api_socket(None, None, data),
            abs("data").join("run").join("api.sock")
        );
    }

    #[test]
    fn a_development_session_names_its_own_claude_unit() {
        assert_eq!(claude_unit_for(None), "daedalus-claude-rc");
        let a = claude_unit_for(Some(&abs("a")));
        let b = claude_unit_for(Some(&abs("b")));
        assert!(a.starts_with("daedalus-claude-rc-") && a.len() == 29, "{a}");
        assert_ne!(a, b);
        assert_eq!(a, claude_unit_for(Some(&abs("a"))));
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
