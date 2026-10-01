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
mod lemonade;
mod model;

pub use check::{check, digest};
pub use lemonade::{clip, lemonade_in, read, residency, LEMONADE_DEFAULT_PORT};
pub use model::{
    LoadedModel, ModelAction, ModelFigures, ProviderAction, ProviderBackend, ProviderDownload,
    ProviderKind, ProviderModel, ProviderModelParams, ProviderReport,
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
/// The residency outcomes a document carries.
pub const MAX_ACTIONS: usize = 8;

/// The reader's thread: a read now, then on the cadence above — and at
/// once after a residency verb (`ProvidersHub::finish_action`) — each
/// published to `shared` with the verbs' outcomes, for the link to push.
pub fn run_loop(shared: Arc<Shared>, stop: Shutdown) {
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
            let mut list = read(&policy, shared.telemetry.lemonade_installed());
            let actions = shared.providers.actions();
            for p in &mut list {
                p.actions = actions.clone();
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
