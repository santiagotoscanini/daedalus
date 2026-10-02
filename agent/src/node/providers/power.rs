//! Whether the provider runs, and whether it starts on its own: the box's
//! word (`ProviderPolicy::wanted` and `always_on`, or the operator's last
//! `provider_power`), converged by the reader after every read, and the
//! two power verbs themselves.
//!
//! **Never fight the user.** A server the box wants running is started
//! when it is found stopped — after a boot, a logon, a crash the agent did
//! not see — but one that was seen running in this logon and then stopped
//! without the box asking (the tray's Quit, a `systemctl stop`) is the
//! user's decision: it stays off (`manual_off`) until the next logon or
//! the operator's start. A turn to `stop` stops it once; a server the user
//! starts again afterwards is left alone. The manual-off is kept on disk
//! with the boot it belongs to, so an agent restart (an update) keeps it
//! and a reboot ends it.
//!
//! **Startup** is the OS's own switch, set to `always_on` whenever it
//! differs: Windows' `StartupApproved` value for the Startup-folder
//! shortcut, which survives the shortcut every upgrade reinstalls;
//! launchd's enable/disable; systemd's.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::*;

/// How often a wanted server found stopped is started again, at most.
const RETRY_START: Duration = Duration::from_secs(5 * 60);
/// How often a startup switch that would not take is tried again.
const RETRY_STARTUP: Duration = Duration::from_secs(10 * 60);
/// How long a start or a stop is waited for.
const SETTLE: Duration = Duration::from_secs(30);

/// The operator's last power verb, and the policy's `wanted` when it came:
/// it stands while the policy still says that.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Operator {
    pub wanted: PowerWanted,
    pub policy: Option<PowerWanted>,
    /// Counts the verbs, so the reader sees each once.
    pub generation: u64,
}

/// What the box wants now: the operator's verb while the policy has not
/// moved since, else the policy's.
pub fn effective(policy: Option<PowerWanted>, operator: Option<&Operator>) -> Option<PowerWanted> {
    match operator {
        Some(o) if o.policy == policy => Some(o.wanted),
        _ => policy,
    }
}

/// One read's facts, for `Converge::decide`.
#[derive(Clone, Debug)]
pub struct Input {
    pub wanted: Option<PowerWanted>,
    pub generation: u64,
    pub running: bool,
    /// The session the server runs in for its user: the console session on
    /// Windows, None while nobody is logged on; `Some(0)` elsewhere.
    pub session: Option<u32>,
    pub installed: bool,
    /// A verb or an install holds the provider: nothing to converge.
    pub busy: bool,
    pub always_on: Option<bool>,
    pub startup: Option<ProviderStartup>,
    /// The OS's boot, seconds since the epoch, give or take.
    pub boot: u64,
    pub now: Instant,
}

/// What converging asks of the OS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Start,
    Stop,
    Startup(bool),
}

/// The user stopped it: in which session, of which boot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManualOff {
    pub session: u32,
    pub boot: u64,
}

/// Two boot times read a little apart are the same boot.
fn same_boot(a: u64, b: u64) -> bool {
    a.abs_diff(b) <= 120
}

/// The reader's power state between reads.
#[derive(Debug, Default)]
pub struct Converge {
    /// The `wanted` last acted on.
    applied: Option<PowerWanted>,
    generation: u64,
    /// The session it was last seen running in, while the box wanted it.
    seen_in: Option<u32>,
    manual_off: Option<ManualOff>,
    last_start: Option<Instant>,
    last_startup: Option<Instant>,
}

impl Converge {
    pub fn new(manual_off: Option<ManualOff>) -> Self {
        Self {
            manual_off,
            ..Default::default()
        }
    }

    pub fn manual_off(&self) -> Option<ManualOff> {
        self.manual_off
    }

    /// What to do after one read. Pure: the caller runs the steps.
    pub fn decide(&mut self, i: &Input) -> Vec<Step> {
        let mut steps = Vec::new();
        if !i.installed || i.busy {
            // An install stops and starts it on its own; what it leaves is
            // not the user's doing.
            self.seen_in = None;
            return steps;
        }
        // A new logon, or a new boot: the user's quit held for the last one.
        if let Some(m) = self.manual_off {
            if Some(m.session) != i.session || !same_boot(m.boot, i.boot) {
                self.manual_off = None;
            }
        }
        if i.generation != self.generation {
            // The operator's verb ran it, or stopped it, itself.
            self.generation = i.generation;
            self.applied = i.wanted;
            if i.wanted == Some(PowerWanted::Start) {
                self.manual_off = None;
            }
            self.seen_in = if i.running { i.session } else { None };
        } else {
            match i.wanted {
                Some(PowerWanted::Start) => {
                    if i.running {
                        self.seen_in = i.session;
                    } else if let Some(s) = i.session {
                        if self.seen_in == Some(s) && self.applied == Some(PowerWanted::Start) {
                            self.manual_off = Some(ManualOff {
                                session: s,
                                boot: i.boot,
                            });
                            self.seen_in = None;
                        } else if self.manual_off.is_none()
                            && self
                                .last_start
                                .is_none_or(|at| i.now.duration_since(at) >= RETRY_START)
                        {
                            self.last_start = Some(i.now);
                            steps.push(Step::Start);
                        }
                    } else {
                        self.seen_in = None;
                    }
                    self.applied = Some(PowerWanted::Start);
                }
                Some(PowerWanted::Stop) => {
                    // A turn to stop acts once; the first sight of it (the
                    // agent just started) does not, nor does a server the
                    // user started again after.
                    if self.applied.is_some_and(|a| a != PowerWanted::Stop) && i.running {
                        steps.push(Step::Stop);
                    }
                    self.applied = Some(PowerWanted::Stop);
                    self.seen_in = None;
                }
                None => {
                    self.applied = None;
                    self.seen_in = None;
                }
            }
        }
        if let (Some(on), Some(st)) = (i.always_on, i.startup) {
            let is_on = st == ProviderStartup::Enabled;
            if st != ProviderStartup::Missing
                && on != is_on
                && self
                    .last_startup
                    .is_none_or(|at| i.now.duration_since(at) >= RETRY_STARTUP)
            {
                self.last_startup = Some(i.now);
                steps.push(Step::Startup(on));
            }
        }
        steps
    }
}

/// Where the manual-off is kept between the agent's runs.
fn manual_off_path() -> PathBuf {
    crate::core::paths::data_dir()
        .join("providers")
        .join("lemonade-power.json")
}

pub fn load_manual_off() -> Option<ManualOff> {
    serde_json::from_slice(&std::fs::read(manual_off_path()).ok()?).ok()
}

pub fn save_manual_off(m: Option<ManualOff>) {
    if cfg!(test) {
        return;
    }
    let path = manual_off_path();
    let wrote = match m {
        None => match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
        Some(m) => std::fs::create_dir_all(path.parent().unwrap_or(&path)).and_then(|()| {
            crate::util::write_atomic(
                &path,
                &serde_json::to_vec(&m).unwrap_or_default(),
                crate::util::Access::Private,
            )
        }),
    };
    if let Err(e) = wrote {
        tracing::warn!(error = %e, "the provider's manual-off was not kept");
    }
}

/// The OS's boot, seconds since the epoch, from its uptime.
pub fn boot_epoch() -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    now.saturating_sub(crate::os::os_uptime_secs().unwrap_or(0))
}

/// Start the provider and wait until it answers, or its process runs in
/// the console session (a server that answers was already running: the
/// single-instance lock makes a second launch exit 0 without a word).
pub fn start(found: &Found, port: u16) -> Result<String, String> {
    if found.install.is_none() {
        return Err("no install of it on this machine".into());
    }
    if found.console.is_none() {
        return Err("no user session: it runs in a logged-on user's tray".into());
    }
    crate::os::lemonade::start(found)?;
    let until = Instant::now() + SETTLE;
    loop {
        if health_version(port).is_some() {
            let now = crate::os::lemonade::find();
            if now.outside_console() {
                return Err(format!(
                    "it runs in session {:?}, not the user's",
                    now.session
                ));
            }
            return Ok("running".into());
        }
        if Instant::now() >= until {
            return Err(format!(
                "started, but it did not answer within {} s",
                SETTLE.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Stop the provider and wait until it no longer answers.
pub fn stop(found: &Found, port: u16) -> Result<String, String> {
    crate::os::lemonade::stop(found, port)?;
    let until = Instant::now() + SETTLE;
    while health_version(port).is_some() {
        if Instant::now() >= until {
            return Err(format!("still answering after {} s", SETTLE.as_secs()));
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    Ok("stopped".into())
}
