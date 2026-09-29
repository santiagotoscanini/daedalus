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
//! port = 7787                 # the status page's port (loopback on a node)
//! update_check_secs = 600     # how often the release feed is asked
//! auto_update = true          # the older spelling of `updates` (below)
//! log_level = "info"
//! search_domains = []         # more domains to ask for `_daedalus-controller._tcp`
//! mode = "node"               # node | controller
//! telemetry = "full"          # full | minimal | off
//! updates = "self"            # self | staged | external
//! data_dir = "…"              # where state, identity and logs live; absent = the OS default
//! controller_address = "…"    # the controller, host:port; absent = the first use's, or DNS
//! controller_pin = "…"        # its key's fingerprint; absent = trust on first use
//!
//! [controller]                # read only when mode = "controller"; nix writes it
//! claude_remote_control = false   # run Claude remote control on the box
//! claude_workdir = "…"        # where; absent = the most recent trusted project
//! claude_unit = "…"           # its transient user unit; absent = daedalus-claude-rc
//! api_socket = "…"            # the local API socket; absent = see below
//! api_allowed_uids = []       # host uids served besides the agent's own
//! listen = "0.0.0.0:7788"     # where machines' links are accepted; absent = none are
//! advertise = ["box.lan:7788"]  # what machines should dial (one or a list), for the app
//! ```
//!
//! `controller_address` and `controller_pin` are a machine's way to the
//! controller (link/node.rs), the only party it talks to: `install
//! --controller` and `--pin` write them, into a file that exists too.
//! Without an address the machine asks DNS for the controller's SRV record;
//! without a pin it trusts the first key the controller presents, never
//! re-pins, and warns until one is pinned. A pin that is not a fingerprint
//! does not stop the agent: the link says so on the status page and the
//! hold goes on.
//!
//! `mode` decides which parts of the agent run at all — an ordinary machine
//! (`node`) or the box's own agent (`controller`); role.rs has the table.
//! `telemetry` decides how much of the machine is read and reported:
//! `full` is everything telemetry.rs lists; `minimal` is the machine and
//! how it is doing — make, model, firmware, OS, processor, memory, volumes,
//! GPUs, temperatures, network, battery and what could not be
//! read — and never reads the drives (their serials and SMART), the
//! services, the browsers, the installed applications or the OS's pending
//! updates; processes are sampled for the count, but the list is not
//! reported (`Telemetry::minimal`); `off` reads nothing, so the page's
//! `telemetry` is null and the controller has no telemetry series for it. The
//! providers (providers.rs) are read whatever the level: the gateway needs
//! them. `updates` decides whether a
//! newer release is installed: `self` installs it (today's behaviour);
//! `staged` and `external` only report it, as `auto_update = false` always
//! has. When `updates` is absent, `auto_update` decides (true = `self`,
//! false = report only); when both are present, `updates` wins.
//! How Claude remote control runs is not a knob: always as a job of the OS
//! that outlives the agent (jobs/). `install` writes the first five keys, and the controller's two when it
//! is given them.
//!
//! `[controller]` is the box's own policy. A node takes its policy from the
//! controller over the link; the controller has no one above it, so what
//! nix writes here stands in for it: whether Claude remote control runs (off
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
use std::time::Duration;

use crate::paths::{
    claude_unit_name, config_dir, config_path, data_dir, env_data_dir, last_policy, non_empty,
    DATA_DIR_ENV,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// The GitHub repository whose `agent-v<semver>` releases this agent
/// follows. Not a knob: every release is verified against the key compiled
/// into this binary (update.rs), so another feed would need another build.
pub const DEFAULT_REPO: &str = "santiagotoscanini/daedalus";

/// What the box decides — holding the machine awake, Claude remote control
/// and its directory, provider ports — is not here: it is the box's policy
/// (link/wire.rs `Policy`), with `Policy::default()` standing until the
/// controller has approved this machine.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// The port the status page answers on.
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
    /// Search domains to ask for the `_daedalus-controller._tcp` record
    /// besides the ones DHCP handed the adapters.
    pub search_domains: Vec<String>,
    /// The controller's `host:port`, for the link (link/node.rs); absent
    /// means: the address a first use was trusted at, or the
    /// `_daedalus-controller._tcp` SRV record. `install --controller` writes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller_address: Option<String>,
    /// The controller key's fingerprint to pin (identity.rs
    /// `fingerprint`); absent means: the first key the controller presents.
    /// `install --pin` writes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller_pin: Option<String>,
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
    /// The controller's own policy and its local API; ignored on a node.
    #[serde(skip_serializing_if = "is_default")]
    pub controller: ControllerConfig,
}

/// `[controller]`: what nix decides for the box's agent, which has no
/// controller above it to bring it a policy (module doc).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ControllerConfig {
    /// Run Claude remote control. Off unless nix says so.
    pub claude_remote_control: bool,
    /// The directory it runs in; absent = the most recent trusted project.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_workdir: Option<String>,
    /// Its job's name: the transient systemd user unit, without `.service`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_unit: Option<String>,
    /// Where the local API socket is made.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_socket: Option<PathBuf>,
    /// Host uids the socket serves besides the agent's own (module doc).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub api_allowed_uids: Vec<u32>,
    /// The root helper's socket (root/): `root.run` is offered while this
    /// names one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_socket: Option<PathBuf>,
    /// Where the machines' link is accepted, `address:port`; absent means
    /// the controller listens for no machine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    /// The `host:port`s machines should dial, as `system.info` names them
    /// to the app; one, or a list.
    #[serde(
        default,
        deserialize_with = "one_or_many",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub advertise: Vec<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// An ordinary machine on the network.
    #[default]
    Node,
    /// The box's own agent, which nix builds, configures and updates.
    Controller,
}

#[cfg_attr(test, derive(ts_rs::TS))]
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
            search_domains: Vec::new(),
            controller_address: None,
            controller_pin: None,
            mode: Mode::default(),
            telemetry: TelemetryLevel::default(),
            updates: None,
            data_dir: None,
            controller: ControllerConfig::default(),
        }
    }
}

impl Config {
    /// Which parts of the agent run on this machine (role.rs).
    pub fn role(&self) -> crate::role::Role {
        crate::role::Role::of(self.mode)
    }

    /// The policy that stands at start. A node's is the last one the
    /// controller sent (`last_policy`, kept across restarts so a restart
    /// never briefly reverts Claude's directory or switch), else
    /// `Policy::default()` until the controller approves it; the controller's
    /// is `[controller]`'s
    /// for good — no awake hold, and Claude only when nix asked for it.
    pub fn initial_policy(&self) -> crate::link::wire::Policy {
        match self.mode {
            Mode::Node => last_policy().unwrap_or_default(),
            Mode::Controller => crate::link::wire::Policy {
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

    /// Where the controller accepts the machines' link; None when
    /// `[controller] listen` names nothing (or this is not the controller).
    pub fn controller_listen(&self) -> Option<std::net::SocketAddr> {
        if self.mode != Mode::Controller {
            return None;
        }
        non_empty_str(self.controller.listen.as_deref()).and_then(|l| l.parse().ok())
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
            // The kernel reports an unmapped user namespace's peer as the
            // overflow uid: listing it would admit every such peer.
            if uids.contains(&65534) {
                bail!("controller.api_allowed_uids may not name uid 65534 (the overflow uid unmapped peers get)");
            }
            if let Some(l) = non_empty_str(self.controller.listen.as_deref()) {
                if l.parse::<std::net::SocketAddr>().is_err() {
                    bail!("controller.listen must be an address and port such as 0.0.0.0:7788, not {l:?}");
                }
            }
            for a in &self.controller.advertise {
                if !valid_host_port(a) {
                    bail!("controller.advertise names host:port pairs, not {a:?}");
                }
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

/// `host:port`, `a.b.c.d:port` or `[v6]:port`, with a port that is not 0.
pub fn valid_host_port(s: &str) -> bool {
    let Some((host, port)) = s.rsplit_once(':') else {
        return false;
    };
    let host_ok = match host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        Some(v6) => v6.parse::<std::net::Ipv6Addr>().is_ok(),
        None => {
            !host.is_empty()
                && host.len() <= 253
                && host
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
        }
    };
    host_ok && port.parse::<u16>().is_ok_and(|p| p != 0)
}

/// `advertise` as one string or a list of them.
fn one_or_many<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }
    Ok(match OneOrMany::deserialize(d)? {
        OneOrMany::One(s) => vec![s],
        OneOrMany::Many(v) => v,
    })
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
/// an operator's edits on a reinstall — except the two keys `install
/// --controller` and `--pin` name, which it sets in a file that exists
/// (`set_top_level_keys`), leaving the rest as it was. Only `install`
/// calls it.
pub fn write_for_install(cfg: &Config) -> Result<PathBuf> {
    let path = config_path();
    std::fs::create_dir_all(config_dir()).context("creating the data directory")?;
    if !path.exists() {
        let text = format!(
            "# daedalus-agent — written by `install`; edit and restart the service.\n\n{}",
            toml::to_string_pretty(cfg)?
        );
        std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
        return Ok(path);
    }
    let keys: Vec<(&str, &str)> = [
        ("controller_address", cfg.controller_address.as_deref()),
        ("controller_pin", cfg.controller_pin.as_deref()),
    ]
    .into_iter()
    .filter_map(|(k, v)| v.map(|v| (k, v)))
    .collect();
    if !keys.is_empty() {
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let edited = set_top_level_keys(&text, &keys);
        toml::from_str::<Config>(&edited)
            .with_context(|| format!("{} would not parse with the new keys", path.display()))?;
        std::fs::write(&path, edited).with_context(|| format!("writing {}", path.display()))?;
    }
    Ok(path)
}

/// Set `controller_pin` in the config.toml at `path` to `fingerprint`,
/// every other line as it was: what a signed controller key rotation does
/// where config.toml held the pin (link/node.rs). Refused, and nothing
/// written, when the result would not parse.
pub fn set_controller_pin_at(path: &Path, fingerprint: &str) -> Result<()> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    let edited = set_top_level_keys(&text, &[("controller_pin", fingerprint)]);
    toml::from_str::<Config>(&edited)
        .with_context(|| format!("{} would not parse with the new pin", path.display()))?;
    crate::util::write_atomic(path, edited.as_bytes(), None)
        .with_context(|| format!("writing {}", path.display()))
}

/// `text` with each key set to its string value at the top level: an
/// existing line for the key (before the first table) is replaced, and a
/// missing one is added before the first table header, so it stays a
/// top-level key. Comments and every other line stay as they are.
fn set_top_level_keys(text: &str, keys: &[(&str, &str)]) -> String {
    let quoted = |v: &str| toml::Value::String(v.to_string()).to_string();
    let mut out: Vec<String> = Vec::new();
    let mut done = vec![false; keys.len()];
    let mut in_table = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') && !in_table {
            in_table = true;
            for (i, (k, v)) in keys.iter().enumerate() {
                if !done[i] {
                    out.push(format!("{k} = {}", quoted(v)));
                    done[i] = true;
                }
            }
        }
        if !in_table {
            let key = trimmed.split('=').next().unwrap_or("").trim();
            if let Some(i) = keys.iter().position(|(k, _)| *k == key) {
                if !done[i] {
                    out.push(format!("{} = {}", keys[i].0, quoted(keys[i].1)));
                    done[i] = true;
                }
                continue;
            }
        }
        out.push(line.to_string());
    }
    for (i, (k, v)) in keys.iter().enumerate() {
        if !done[i] {
            out.push(format!("{k} = {}", quoted(v)));
        }
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::env_dir;

    /// What `install` writes without `--controller` or `--pin`, byte for byte.
    const WRITTEN_BY_INSTALL: &str = "port = 7787\nupdate_check_secs = 600\nauto_update = true\n\
                                      log_level = \"info\"\nsearch_domains = []\n";

    #[test]
    fn install_writes_the_defaults_and_they_parse_back() {
        assert_eq!(
            toml::to_string_pretty(&Config::default()).unwrap(),
            WRITTEN_BY_INSTALL
        );
        let cfg: Config = toml::from_str(WRITTEN_BY_INSTALL).unwrap();
        assert_eq!(cfg, Config::default());
        assert_eq!(cfg.mode, Mode::Node);
        assert_eq!(cfg.telemetry, TelemetryLevel::Full);
        assert_eq!(cfg.updates, None);
        assert_eq!(cfg.data_dir, None);
        assert_eq!(cfg.self_update_off(), None);
    }

    #[test]
    fn a_top_level_key_the_agent_does_not_know_is_ignored() {
        // The file on a machine the updater moved is the one an earlier
        // install wrote: it must still start the service.
        let edited = "port = 7790\nupdate_check_secs = 1200\nauto_update = false\n\
                      log_level = \"debug\"\nsearch_domains = [\"lan\"]\nhello_secs = 30\n";
        let cfg: Config = toml::from_str(edited).unwrap();
        assert_eq!(
            cfg,
            Config {
                port: 7790,
                update_check_secs: 1200,
                auto_update: false,
                log_level: "debug".into(),
                search_domains: vec!["lan".into()],
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
    fn the_mode_parses_and_a_retired_key_is_ignored() {
        // `claude_rc` went in 0.17.0 (Claude is always a job of the OS); a
        // config.toml that still says it reads as if it did not.
        let cfg: Config = toml::from_str("claude_rc = \"child\"").unwrap();
        assert_eq!(cfg, Config::default());
        let cfg: Config = toml::from_str("mode = \"controller\"").unwrap();
        assert_eq!(cfg.mode, Mode::Controller);
    }

    // Controller mode exists only on the box (unix): these paths are unix paths.
    #[cfg(unix)]
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
        assert_eq!(node.initial_policy(), crate::link::wire::Policy::default());
        assert_eq!(node.claude_unit(), claude_unit_name());
    }

    // Controller mode exists only on the box (unix): these paths are unix paths.
    #[cfg(unix)]
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
        assert!(check("api_allowed_uids = [65534]").is_err());
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
    fn install_sets_the_controller_keys_and_keeps_the_rest() {
        let file = "# daedalus-agent — written by `install`\n\nport = 7790\ncontroller_pin = \"old\"\n\n[controller]\nclaude_unit = \"x\"\n";
        let out = set_top_level_keys(
            file,
            &[
                ("controller_address", "box.lan:7788"),
                ("controller_pin", "aa:bb"),
            ],
        );
        assert_eq!(
            out,
            "# daedalus-agent — written by `install`\n\nport = 7790\ncontroller_pin = \"aa:bb\"\n\n\
             controller_address = \"box.lan:7788\"\n[controller]\nclaude_unit = \"x\"\n"
        );
        let cfg: Config = toml::from_str(&out).unwrap();
        assert_eq!(cfg.port, 7790);
        assert_eq!(cfg.controller_address.as_deref(), Some("box.lan:7788"));
        assert_eq!(cfg.controller_pin.as_deref(), Some("aa:bb"));
        // No table: appended at the end.
        let out = set_top_level_keys("port = 1\n", &[("controller_pin", "p")]);
        assert_eq!(out, "port = 1\ncontroller_pin = \"p\"\n");
        // What install writes without the flags is unchanged.
        assert!(!toml::to_string_pretty(&Config::default())
            .unwrap()
            .contains("controller"));
    }

    #[test]
    fn the_listener_and_its_addresses_are_checked_in_controller_mode() {
        for ok in [
            "box.lan:7788",
            "192.168.0.2:7788",
            "[fe80::1]:7788",
            "s2-server:1",
        ] {
            assert!(valid_host_port(ok), "{ok}");
        }
        for bad in [
            "box.lan",
            ":7788",
            "box.lan:0",
            "box.lan:99999",
            "a b:1",
            "[zz]:1",
            "box;rm:1",
        ] {
            assert!(!valid_host_port(bad), "{bad}");
        }
        let check = |table: &str| {
            toml::from_str::<Config>(&format!("mode = \"controller\"\n[controller]\n{table}"))
                .unwrap()
                .validate()
        };
        assert!(check("listen = \"0.0.0.0:7788\"").is_ok());
        assert!(check("listen = \"box.lan:7788\"").is_err());
        assert!(check("advertise = \"box.lan:7788\"").is_ok());
        assert!(check("advertise = [\"box.lan:7788\", \"192.168.0.2:7788\"]").is_ok());
        assert!(check("advertise = [\"box.lan\"]").is_err());
        let cfg: Config = toml::from_str(
            "mode = \"controller\"\n[controller]\nlisten = \"127.0.0.1:7788\"\nadvertise = \"box.lan:7788\"\n",
        )
        .unwrap();
        assert_eq!(
            cfg.controller_listen(),
            Some("127.0.0.1:7788".parse().unwrap())
        );
        assert_eq!(cfg.controller.advertise, ["box.lan:7788"]);
        // A node never listens, whatever the table says.
        let node: Config = toml::from_str("[controller]\nlisten = \"127.0.0.1:7788\"\n").unwrap();
        assert_eq!(node.controller_listen(), None);
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
