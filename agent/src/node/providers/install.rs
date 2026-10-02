//! Installing or updating a provider to one release (`provider_install`):
//! a state machine whose every step is journalled on disk before it runs,
//! so a reboot or a crash mid-install resumes it or says how it ended —
//! never a guess.
//!
//! ```text
//! downloading → stopping → installing → verifying → wiring → powering → done
//!                              │             │
//!                              └──── failed ─┴→ rolling_back → rolled_back | failed
//! ```
//!
//! - **downloading**: the asset from Lemonade's GitHub releases alone
//!   (`ProviderInstallParams::check`), kept only at the size and SHA-256
//!   the box named (update/ `download_verified`), in
//!   `<data>/providers/lemonade/`. The installer of the version running now,
//!   when an earlier install here left it, is kept beside it for a roll-back;
//!   every other is removed once the install ends.
//! - **stopping**: the catalog's downloaded ids are recorded, then the
//!   server is stopped gracefully (`/internal/shutdown`, or its service).
//! - **installing**: the OS's installer, silently (os/*/lemonade.rs) — on
//!   Windows msiexec in the console user's session, so the MSI's relaunch
//!   runs as that user.
//! - **verifying**: the server answers and its health states the target
//!   version, within `VERIFY_DEADLINE`; a server running outside the user's
//!   session is moved into it.
//! - **wiring**: every address, the policy's port, no broadcast
//!   (lemonade.rs `wire`); a failure is reported, not rolled back.
//! - **powering**: the box's `wanted` — or, without one, as it was before.
//!
//! The ids offered before and not after are reported (`vanished`): the
//! gateway's aliases derive from them. A failed install or verification
//! reinstalls the previous installer (on Windows after uninstalling the new
//! one: the MSI refuses a downgrade); with none kept, it ends `failed` with
//! the machine as the installer left it.
//!
//! **Resuming.** The service reads the journal as it starts: a download or
//! a stop under way starts over; an install under way is verified, and
//! installed once more if the target is not there; a roll-back under way
//! runs again. On Windows the steps that need the user's session wait for
//! one.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::*;
use crate::core::shared::Shared;

/// How long the new version has to answer with its version.
const VERIFY_DEADLINE: Duration = Duration::from_secs(180);
/// How often a step that waits for a user session looks again.
const SESSION_POLL: Duration = Duration::from_secs(30);
/// Installer runs an interrupted install may take, the first included.
const MAX_ATTEMPTS: u32 = 2;

/// The journal: one install, its parameters and where it stands.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Journal {
    pub request: String,
    pub version: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    /// The version running before, from its health; None when none
    /// answered.
    pub from_version: Option<String>,
    /// The installer of `from_version`, in the providers directory, when an
    /// earlier install here kept it: what a roll-back installs.
    pub previous: Option<String>,
    /// The ids offered before; None when the catalog could not be read.
    pub before: Option<Vec<String>>,
    pub was_running: bool,
    pub phase: LifecyclePhase,
    /// Installer runs so far.
    pub attempts: u32,
    pub rollbacks: u32,
    pub message: String,
    pub vanished: Vec<String>,
    pub log_tail: Vec<String>,
    pub started_at: String,
    pub at: String,
}

impl Journal {
    pub fn new(p: &ProviderInstallParams, now: &str) -> Self {
        Self {
            request: p.request.clone(),
            version: p.version.clone(),
            url: p.url.clone(),
            size: p.size,
            sha256: p.sha256.clone(),
            started_at: now.to_string(),
            at: now.to_string(),
            message: "downloading the installer".into(),
            ..Default::default()
        }
    }

    /// The installer's file name, the URL's last segment.
    pub fn file(&self) -> &str {
        self.url.rsplit('/').next().unwrap_or_default()
    }

    /// What the report carries of it.
    pub fn lifecycle(&self) -> ProviderLifecycle {
        ProviderLifecycle {
            request: self.request.clone(),
            version: self.version.clone(),
            from_version: self.from_version.clone(),
            phase: self.phase,
            message: clip(&self.message, MAX_TEXT),
            vanished: self.vanished.clone(),
            log_tail: self.log_tail.clone(),
            started_at: self.started_at.clone(),
            at: self.at.clone(),
        }
    }
}

/// Where a journal found unfinished at start picks up.
pub fn resume_phase(j: &Journal) -> LifecyclePhase {
    match j.phase {
        LifecyclePhase::Downloading | LifecyclePhase::Stopping => LifecyclePhase::Downloading,
        // The installer may or may not have finished: what runs says.
        LifecyclePhase::Installing => LifecyclePhase::Verifying,
        LifecyclePhase::RollingBack if j.rollbacks >= MAX_ATTEMPTS => LifecyclePhase::Failed,
        p => p,
    }
}

/// The ids offered before and gone after, in the order they were offered.
pub fn vanished(before: &[String], after: &[String]) -> Vec<String> {
    before
        .iter()
        .filter(|id| !after.contains(id))
        .take(MAX_MODELS)
        .cloned()
        .collect()
}

/// Whether an install may start: refused while one runs or the machine is
/// not one the agent may install on. `running`: a server answers.
pub fn refusal(
    p: &ProviderInstallParams,
    found: &Found,
    running: bool,
    pin: Option<&crate::link::wire::ProviderPin>,
) -> Option<String> {
    if let Some(pin) = pin {
        if pin.version != p.version
            || pin.url != p.url
            || pin.size != p.size
            || pin.sha256 != p.sha256
        {
            return Some(format!(
                "the box pins {}; this install is {}",
                pin.version, p.version
            ));
        }
    }
    let ext = p.file_name().rsplit('.').next().unwrap_or_default();
    if !crate::os::lemonade::INSTALLERS.contains(&ext) {
        return Some(format!("a .{ext} is not an installer for this OS"));
    }
    if let Some(who) = &found.foreign {
        return Some(format!("{who} has it installed in their own profile"));
    }
    if found.console.is_none() {
        return Some("no user session: it installs into a logged-on user's profile".into());
    }
    if running && found.install.is_none() {
        return Some(
            "a server answers that no installer here registered: uninstall it by hand first".into(),
        );
    }
    None
}

/// The providers' own directory, the installers in it.
fn dir() -> PathBuf {
    crate::core::paths::data_dir()
        .join("providers")
        .join("lemonade")
}

fn journal_path() -> PathBuf {
    crate::core::paths::data_dir()
        .join("providers")
        .join("lemonade-install.json")
}

/// The journal on disk; None when no install was ever asked for here.
pub fn load() -> Option<Journal> {
    serde_json::from_slice(&std::fs::read(journal_path()).ok()?).ok()
}

/// Keep the journal; a journal that cannot be written stops the install
/// before its next step.
fn save(j: &Journal) -> Result<(), String> {
    if cfg!(test) {
        return Ok(());
    }
    let path = journal_path();
    std::fs::create_dir_all(dir()).map_err(|e| format!("creating {}: {e}", dir().display()))?;
    let bytes = serde_json::to_vec_pretty(j).map_err(|e| e.to_string())?;
    crate::util::write_atomic(&path, &bytes, crate::util::Access::Private)
        .map_err(|e| format!("keeping the install's journal: {e}"))
}

/// Begin an install the controller asked for: the journal written, the
/// slot held by the caller, the steps on a thread of their own.
pub fn begin(shared: &Arc<Shared>, p: &ProviderInstallParams) -> Result<(), String> {
    let port = lemonade_port(&shared.settings.policy().providers);
    let mut j = Journal::new(p, &crate::core::state::now_rfc3339());
    j.from_version = health_version(port);
    j.was_running = j.from_version.is_some();
    // The installer of the version running now, if this agent installed it.
    j.previous = load()
        .filter(|last| last.phase == LifecyclePhase::Done)
        .filter(|last| {
            j.from_version
                .as_deref()
                .is_some_and(|v| same_version(&last.version, v))
        })
        .map(|last| last.file().to_string())
        .filter(|f| dir().join(f).is_file());
    save(&j)?;
    spawn(shared, j);
    Ok(())
}

/// At the service's start: an install the journal says was under way goes
/// on, holding the slot; one that ended is the report's.
pub fn resume(shared: &Arc<Shared>) {
    let Some(mut j) = load() else {
        return;
    };
    shared.providers.set_lifecycle(Some(j.lifecycle()));
    if j.phase.ended() || !shared.providers.begin_action() {
        return;
    }
    let from = j.phase;
    j.phase = resume_phase(&j);
    j.message = format!("resumed after the agent stopped while {}", word(from));
    tracing::info!(request = %j.request, from = ?from, to = ?j.phase, "resuming a provider install");
    spawn(shared, j);
}

fn spawn(shared: &Arc<Shared>, j: Journal) {
    let shared2 = Arc::clone(shared);
    let request = j.request.clone();
    let version = j.version.clone();
    let spawned = std::thread::Builder::new()
        .name("provider-install".into())
        .spawn(move || run(&shared2, j));
    if spawned.is_err() {
        shared.providers.finish_action(ProviderAction {
            request,
            verb: ProviderVerb::Install,
            model: version,
            ok: false,
            message: "could not start the install".into(),
            at: crate::core::state::now_rfc3339(),
        });
    }
}

fn word(p: LifecyclePhase) -> &'static str {
    match p {
        LifecyclePhase::Downloading => "downloading",
        LifecyclePhase::Stopping => "stopping the server",
        LifecyclePhase::Installing => "installing",
        LifecyclePhase::Verifying => "verifying",
        LifecyclePhase::Wiring => "wiring",
        LifecyclePhase::Powering => "applying the power state",
        LifecyclePhase::RollingBack => "rolling back",
        LifecyclePhase::Done => "done",
        LifecyclePhase::Failed => "failed",
        LifecyclePhase::RolledBack => "rolled back",
    }
}

/// The steps, from wherever the journal stands, to an end; the outcome
/// into `actions`, the slot freed.
fn run(shared: &Arc<Shared>, mut j: Journal) {
    let mut resumed_install = j.phase == LifecyclePhase::Verifying && j.attempts > 0;
    while !j.phase.ended() {
        let port = lemonade_port(&shared.settings.policy().providers);
        let next = match step(shared, &mut j, port, resumed_install) {
            Ok(next) => next,
            Err(e) => {
                tracing::warn!(request = %j.request, phase = ?j.phase, error = %e, "provider install step failed");
                j.message = e;
                match j.phase {
                    LifecyclePhase::Downloading | LifecyclePhase::Stopping => {
                        LifecyclePhase::Failed
                    }
                    LifecyclePhase::Verifying if resumed_install && j.attempts < MAX_ATTEMPTS => {
                        LifecyclePhase::Installing
                    }
                    LifecyclePhase::Installing | LifecyclePhase::Verifying => {
                        if j.previous.is_some() {
                            LifecyclePhase::RollingBack
                        } else {
                            j.message = format!(
                                "{}; no earlier installer kept here to roll back to",
                                j.message
                            );
                            LifecyclePhase::Failed
                        }
                    }
                    LifecyclePhase::RollingBack => LifecyclePhase::Failed,
                    _ => LifecyclePhase::Failed,
                }
            }
        };
        resumed_install = false;
        j.phase = next;
        j.at = crate::core::state::now_rfc3339();
        if let Err(e) = save(&j) {
            j.message = e;
            j.phase = LifecyclePhase::Failed;
        }
        shared.providers.set_lifecycle(Some(j.lifecycle()));
        shared.providers.ask_read();
    }
    if j.phase == LifecyclePhase::Done {
        tidy(&j);
    }
    tracing::info!(request = %j.request, phase = ?j.phase, message = %j.message, "provider install ended");
    shared.providers.finish_action(ProviderAction {
        request: j.request.clone(),
        verb: ProviderVerb::Install,
        model: clip(&j.version, MAX_TEXT),
        ok: j.phase == LifecyclePhase::Done,
        message: clip(&j.message, MAX_TEXT),
        at: j.at.clone(),
    });
}

/// Wait, on Windows, until someone is logged on: the installer and the
/// server run in their session.
fn session_found(shared: &Shared, j: &mut Journal) -> Found {
    loop {
        let found = crate::os::lemonade::find();
        if found.console.is_some() {
            return found;
        }
        if j.message != "waiting for a user session" {
            j.message = "waiting for a user session".into();
            shared.providers.set_lifecycle(Some(j.lifecycle()));
            shared.providers.ask_read();
        }
        std::thread::sleep(SESSION_POLL);
    }
}

/// One step: the phase to go to, or why it failed.
fn step(
    shared: &Shared,
    j: &mut Journal,
    port: u16,
    resumed_install: bool,
) -> Result<LifecyclePhase, String> {
    let file = dir().join(j.file());
    match j.phase {
        LifecyclePhase::Downloading => {
            std::fs::create_dir_all(dir())
                .map_err(|e| format!("creating {}: {e}", dir().display()))?;
            let sha: [u8; 32] = hex::decode(&j.sha256)
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or("the digest is not 32 bytes of hex")?;
            if !verified_on_disk(&file, j.size, &sha) {
                crate::node::update::download_verified(&j.url, &file, j.size, &sha)
                    .map_err(|e| format!("the installer: {e:#}"))?;
            }
            j.message = "stopping the server".into();
            Ok(LifecyclePhase::Stopping)
        }
        LifecyclePhase::Stopping => {
            // Kept from a first pass: a resumed one finds the server down.
            if j.before.is_none() {
                j.before = offered_ids(port).ok();
            }
            let found = crate::os::lemonade::find();
            if health_version(port).is_some() {
                // The installer stops what is still running its own way.
                if let Err(e) = power::stop(&found, port) {
                    tracing::info!(error = %e, "the server did not stop before the install");
                }
            }
            j.message = format!("installing {}", j.version);
            Ok(LifecyclePhase::Installing)
        }
        LifecyclePhase::Installing => {
            let found = session_found(shared, j);
            j.attempts += 1;
            save(j)?;
            let log = crate::os::lemonade::log_path(&found);
            let ran = crate::os::lemonade::install(&file, &found, &log, false);
            j.log_tail = host::log_tail(&log);
            ran?;
            j.message = format!("waiting for {} to answer", j.version);
            Ok(LifecyclePhase::Verifying)
        }
        LifecyclePhase::Verifying => {
            session_found(shared, j);
            let deadline = if resumed_install {
                Duration::from_secs(60)
            } else {
                VERIFY_DEADLINE
            };
            verify(port, &j.version, deadline)?;
            j.message = "wiring it".into();
            Ok(LifecyclePhase::Wiring)
        }
        LifecyclePhase::Wiring => {
            let mut notes = Vec::new();
            if let Err(e) = wire(port) {
                notes.push(format!("its wiring was not applied: {e}"));
            }
            match (&j.before, offered_ids(port)) {
                (Some(before), Ok(after)) => j.vanished = vanished(before, &after),
                (None, _) => notes.push("the catalog before it was not read".into()),
                (_, Err(e)) => notes.push(format!("the catalog after it was not read: {e}")),
            }
            j.message = if notes.is_empty() {
                format!("{} is running", j.version)
            } else {
                format!("{} is running; {}", j.version, notes.join("; "))
            };
            Ok(LifecyclePhase::Powering)
        }
        LifecyclePhase::Powering => {
            let policy = shared.settings.policy();
            let wanted = power::effective(
                policy.providers.lemonade.as_ref().and_then(|l| l.wanted),
                shared.providers.operator().as_ref(),
            );
            let stop = match wanted {
                Some(w) => w == PowerWanted::Stop,
                None => !j.was_running,
            };
            if stop {
                let found = crate::os::lemonade::find();
                power::stop(&found, port)
                    .map_err(|e| format!("installed, then not stopped: {e}"))?;
                j.message = format!("{}; stopped, as the box wants", j.message);
            }
            Ok(LifecyclePhase::Done)
        }
        LifecyclePhase::RollingBack => {
            let previous = j
                .previous
                .clone()
                .ok_or("no earlier installer kept here to roll back to")?;
            let from = j
                .from_version
                .clone()
                .ok_or("the version before is not known")?;
            let failure = j.message.clone();
            // A failed upgrade the MSI rolled back itself already runs it.
            if health_version(port).is_some_and(|v| same_version(&v, &from)) {
                j.message = format!("{failure}; {from} runs again");
                return Ok(LifecyclePhase::RolledBack);
            }
            let found = session_found(shared, j);
            j.rollbacks += 1;
            save(j)?;
            let log = crate::os::lemonade::log_path(&found);
            let back = (|| {
                crate::os::lemonade::uninstall(&file, &found, &log)?;
                crate::os::lemonade::install(&dir().join(&previous), &found, &log, true)?;
                verify(port, &from, VERIFY_DEADLINE)
            })();
            j.log_tail = host::log_tail(&log);
            match back {
                Ok(()) => {
                    let _ = wire(port);
                    j.message = format!("{failure}; rolled back to {from}");
                    Ok(LifecyclePhase::RolledBack)
                }
                Err(e) => Err(format!("{failure}; the roll-back to {from} failed: {e}")),
            }
        }
        p => Ok(p),
    }
}

/// The server answers with `version`, within `deadline`, in the user's
/// session — started there when the installer left it stopped, or moved
/// there, once, when it started outside it.
fn verify(port: u16, version: &str, deadline: Duration) -> Result<(), String> {
    let until = Instant::now() + deadline;
    let (mut started, mut moved) = (false, false);
    loop {
        let now = crate::os::lemonade::find();
        let late = Instant::now() >= until;
        match health_version(port) {
            Some(_) if now.outside_console() && !moved => {
                tracing::info!(session = ?now.session, "the new server runs outside the user's session; moving it");
                moved = true;
                power::stop(&now, port)?;
                power::start(&now, port)?;
            }
            Some(_) if now.outside_console() => {
                return Err(format!(
                    "it runs in session {:?}, not the user's",
                    now.session
                ));
            }
            Some(v) if same_version(&v, version) => return Ok(()),
            Some(v) if late => return Err(format!("it answers as {v}, not {version}")),
            None if !started && now.pid.is_none() => {
                // Nothing runs: the installer leaves it stopped on this OS.
                started = true;
                if let Err(e) = power::start(&now, port) {
                    tracing::info!(error = %e, "the new server did not start yet");
                }
            }
            None if late => {
                return Err(format!("it did not answer within {} s", deadline.as_secs()));
            }
            _ => {}
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Whether `path` already holds `size` bytes of `sha256`: a resumed
/// download that finished is not fetched again.
fn verified_on_disk(path: &Path, size: u64, sha256: &[u8; 32]) -> bool {
    use sha2::Digest;
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    if f.metadata().ok().map(|m| m.len()) != Some(size) {
        return false;
    }
    let mut hash = sha2::Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hash.update(&buf[..n]),
            Err(_) => return false,
        }
    }
    hash.finalize().as_slice() == sha256
}

/// After a good install: the new installer and none but it, so the next
/// install has this one to roll back to.
fn tidy(j: &Journal) {
    let Ok(entries) = std::fs::read_dir(dir()) else {
        return;
    };
    for e in entries.flatten() {
        if e.file_name().to_string_lossy() != j.file() {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
