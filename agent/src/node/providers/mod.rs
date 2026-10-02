//! What a machine offers the network beyond itself: a model server today.
//!
//! The agent reads its own provider over loopback — presence, the catalog,
//! the health, what it is downloading, which runtimes it has, and what each
//! model has served — and pushes the result up the link as the `providers`
//! document (link/wire.rs `name::PROVIDERS`). The box reads it from the
//! controller (`nodes.providers`) and never dials the provider for it; only
//! the gateway's data plane (LiteLLM's routes) still goes to the machine
//! directly, since a model request has no business passing through the
//! controller.
//!
//! **The install itself** says whether there is one, never the app
//! inventory: Windows' `Software\AMD\Lemonade Server` key in the console
//! user's hive or HKLM, the macOS pkg receipt and LaunchDaemon, the Linux
//! package that owns `lemond.service` (`os::lemonade::find`, host.rs). The
//! report carries it with the process, its startup and the last install.
//! The box installs, updates, starts and stops it through two verbs beside
//! the residency ones: `provider_install` (install.rs) and `provider_power`
//! (power.rs), and keeps it as its policy says (`wanted`, `always_on`).
//!
//! **When.** `run_loop` reads every `READ_EVERY`, every `READ_DOWNLOADING`
//! while a download runs (a percentage a minute old is worthless), and at
//! once when the box's policy for the providers changes (a new port). The
//! link pushes the document when it changes, its clock aside, and every
//! `PUSH_EVERY` (node/link.rs).
//!
//! **Bounds.** Each endpoint's body is read to at most `MAX_BODY` bytes;
//! lists and strings are cut to the bounds below at read time, and the
//! controller refuses a document past them (`check`), so what it keeps in
//! memory and what the app renders is bounded whatever the machine sends.
//!
//! Lemonade is the one kind the agent detects. Ollama is deliberately not
//! one: Lemonade's installer brings it along, so detecting it would list
//! every Lemonade machine twice (app/src/lib/providers/kinds.ts says more).

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::core::shared::Shared;
use crate::link::wire::ProvidersPolicy;
use crate::util::Shutdown;

mod check;
pub mod host;
pub mod install;
mod lemonade;
mod model;
pub mod power;

pub use check::{check, digest};
pub use host::{Console, Found, MAX_LOG_LINES};
pub use lemonade::{
    clip, health_version, lemonade_port, offered_ids, read, residency, shutdown, wire,
    LEMONADE_DEFAULT_PORT,
};
pub use model::{
    same_version, LifecyclePhase, LoadedModel, ModelAction, ModelFigures, PowerWanted,
    ProviderAction, ProviderBackend, ProviderDownload, ProviderInstall, ProviderInstallMethod,
    ProviderInstallParams, ProviderInstallScope, ProviderKind, ProviderLifecycle, ProviderModel,
    ProviderModelParams, ProviderPowerParams, ProviderReport, ProviderStartup, ProviderVerb,
    LEMONADE_RELEASES, MAX_INSTALLER,
};

/// How often the reader reads, and while a download runs.
const READ_EVERY: Duration = Duration::from_secs(60);
const READ_DOWNLOADING: Duration = Duration::from_secs(10);
/// How often the reader looks at the policy between reads.
const POLICY_POLL: Duration = Duration::from_secs(1);

pub const MAX_PROVIDERS: usize = 4;
pub const MAX_MODELS: usize = 256;
pub const MAX_LABELS: usize = 16;
pub const MAX_LOADED: usize = 32;
pub const MAX_DOWNLOADS: usize = 32;
pub const MAX_BACKENDS: usize = 64;
/// An id, a URL, a sentence.
pub const MAX_TEXT: usize = 256;
/// A label, a status word, a recipe.
pub const MAX_WORD: usize = 64;
/// The verbs' outcomes a document carries.
pub const MAX_ACTIONS: usize = 8;

/// The reader's thread: an unfinished install resumed (install.rs), then a
/// read now and on the cadence above — and at once after a verb or an
/// install's step (`ProvidersHub::ask_read`) — each published to `shared`
/// with the verbs' outcomes and the last install, for the link to push,
/// and the power state converged after it (power.rs).
pub fn run_loop(shared: Arc<Shared>, stop: Shutdown) {
    install::resume(&shared);
    let mut converge = power::Converge::new(power::load_manual_off());
    let mut last_policy: Option<ProvidersPolicy> = None;
    let mut read_at: Option<Instant> = None;
    let mut every = READ_EVERY;
    loop {
        let policy = shared.settings.policy();
        let asked = shared.providers.take_read();
        let due = asked
            || read_at.is_none_or(|at| at.elapsed() >= every)
            || last_policy.as_ref() != Some(&policy.providers);
        if due {
            let found = crate::os::lemonade::find();
            let lemonade = policy.providers.lemonade.clone().unwrap_or_default();
            let wanted = power::effective(lemonade.wanted, shared.providers.operator().as_ref());
            let running = health_version(lemonade_port(&policy.providers)).is_some();
            let before = converge.manual_off();
            let steps = converge.decide(&power::Input {
                wanted,
                generation: shared.providers.operator().map_or(0, |o| o.generation),
                running,
                session: found.console.as_ref().map(|c| c.session),
                installed: found.install.is_some(),
                busy: shared.providers.busy(),
                always_on: lemonade.always_on,
                startup: found.startup,
                boot: power::boot_epoch(),
                now: Instant::now(),
            });
            if converge.manual_off() != before {
                power::save_manual_off(converge.manual_off());
            }
            let port = lemonade_port(&policy.providers);
            for s in &steps {
                let done = match s {
                    power::Step::Start => power::start(&found, port),
                    power::Step::Stop => power::stop(&found, port),
                    power::Step::Startup(on) => {
                        crate::os::lemonade::set_startup(&found, *on).map(|()| "set".into())
                    }
                };
                match done {
                    Ok(_) => tracing::info!(step = ?s, "provider converged"),
                    Err(e) => tracing::warn!(step = ?s, error = %e, "provider did not converge"),
                }
            }
            // What the steps changed is in this read, not the next.
            let found = if steps.is_empty() {
                found
            } else {
                crate::os::lemonade::find()
            };
            let mut list = read(&policy, &found);
            let actions = shared.providers.actions();
            let lifecycle = shared.providers.lifecycle();
            for p in &mut list {
                p.actions = actions.clone();
                p.lifecycle = lifecycle.clone();
                p.wanted = wanted;
                p.manual_off = converge.manual_off().is_some();
            }
            every = if list.iter().any(|p| !p.downloads.is_empty()) {
                READ_DOWNLOADING
            } else {
                READ_EVERY
            };
            shared.providers.set(list);
            last_policy = Some(policy.providers);
            read_at = Some(Instant::now());
        }
        if stop.wait(POLICY_POLL) {
            return;
        }
    }
}

#[cfg(test)]
mod tests;
