//! What the service reads of the machine itself: the last telemetry
//! sample, the providers and their verbs, the awake hold and the
//! OS's power requests, and santree's door.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::node::providers::power::Operator;
use crate::node::providers::{PowerWanted, ProviderAction, ProviderLifecycle, ProviderReport};
use crate::telemetry::Telemetry;
use crate::util::LockExt;

/// The last telemetry document, from the sampling thread.
#[derive(Default)]
pub struct TelemetryHub(Mutex<Sample>);

#[derive(Default)]
struct Sample {
    /// Shared rather than copied: its application list is long.
    doc: Option<Arc<Telemetry>>,
    /// Moves whenever a sample carries newly read static or slow facts or
    /// OS updates — what the link pushes at once rather than on its sample
    /// cadence (node/link.rs).
    tier: u64,
}

impl TelemetryHub {
    /// A new sample; `tiers_moved` when it carries static or slow facts or
    /// OS updates read since the last one (telemetry.rs).
    pub fn set(&self, t: Telemetry, tiers_moved: bool) {
        let mut s = self.0.lock_ok();
        s.doc = Some(Arc::new(t));
        if tiers_moved {
            s.tier += 1;
        }
    }

    /// The last document, at the level config.toml sets; None before the
    /// first sample, or when the level is `off`.
    pub fn get(&self) -> Option<Telemetry> {
        self.0.lock_ok().doc.as_deref().cloned()
    }

    /// The last document with its tier counter (`set`).
    pub fn with_tier(&self) -> Option<(Arc<Telemetry>, u64)> {
        let s = self.0.lock_ok();
        s.doc.clone().map(|t| (t, s.tier))
    }
}

/// The providers on this machine (providers/) and their verbs.
#[derive(Default)]
pub struct ProvidersHub(Mutex<Providers>);

#[derive(Default)]
struct Providers {
    /// From their reader; None until its first read.
    reports: Option<Vec<ProviderReport>>,
    /// The verbs' outcomes, newest last.
    actions: Vec<ProviderAction>,
    /// A verb or an install is running; another is refused until it ends.
    busy: bool,
    /// Raised when a verb ends or an install moves: the reader reads again
    /// at once.
    read: bool,
    /// The last install, from its journal (providers/install.rs).
    lifecycle: Option<ProviderLifecycle>,
    /// The operator's last power verb (providers/power.rs).
    operator: Option<Operator>,
}

impl ProvidersHub {
    /// The providers as their reader last found them.
    pub fn set(&self, list: Vec<ProviderReport>) {
        self.0.lock_ok().reports = Some(list);
    }

    /// The last read; None before the first.
    pub fn get(&self) -> Option<Vec<ProviderReport>> {
        self.0.lock_ok().reports.clone()
    }

    /// Claim the one slot every verb and install shares; false while one
    /// runs.
    pub fn begin_action(&self) -> bool {
        let mut p = self.0.lock_ok();
        !std::mem::replace(&mut p.busy, true)
    }

    /// A verb ended: its outcome is kept (the last `MAX_ACTIONS`), the
    /// slot freed, and the reader asked to read again at once.
    pub fn finish_action(&self, a: ProviderAction) {
        let mut p = self.0.lock_ok();
        p.actions.push(a);
        let over = p
            .actions
            .len()
            .saturating_sub(crate::node::providers::MAX_ACTIONS);
        p.actions.drain(..over);
        p.busy = false;
        p.read = true;
    }

    pub fn actions(&self) -> Vec<ProviderAction> {
        self.0.lock_ok().actions.clone()
    }

    /// Whether a read was asked for since the last call.
    pub fn take_read(&self) -> bool {
        std::mem::take(&mut self.0.lock_ok().read)
    }

    /// Ask the reader to read again at once.
    pub fn ask_read(&self) {
        self.0.lock_ok().read = true;
    }

    /// Whether a verb or an install holds the slot.
    pub fn busy(&self) -> bool {
        self.0.lock_ok().busy
    }

    pub fn set_lifecycle(&self, l: Option<ProviderLifecycle>) {
        self.0.lock_ok().lifecycle = l;
    }

    pub fn lifecycle(&self) -> Option<ProviderLifecycle> {
        self.0.lock_ok().lifecycle.clone()
    }

    /// The operator asked for `wanted` while the policy said `policy`.
    pub fn set_operator(&self, wanted: PowerWanted, policy: Option<PowerWanted>) {
        let mut p = self.0.lock_ok();
        let generation = p.operator.map_or(1, |o| o.generation + 1);
        p.operator = Some(Operator {
            wanted,
            policy,
            generation,
        });
    }

    pub fn operator(&self) -> Option<Operator> {
        self.0.lock_ok().operator
    }
}

/// The awake hold as the service last set it, and the OS's power requests
/// as last read.
#[derive(Default)]
pub struct PowerHub(Mutex<Power>);

#[derive(Default)]
struct Power {
    held: bool,
    error: Option<String>,
    requests: Option<String>,
}

impl PowerHub {
    pub fn set_hold(&self, held: bool, error: Option<String>) {
        let mut p = self.0.lock_ok();
        p.held = held;
        p.error = error;
    }

    /// Whether the machine is held awake, and why not when it could not be.
    pub fn hold(&self) -> (bool, Option<String>) {
        let p = self.0.lock_ok();
        (p.held, p.error.clone())
    }

    /// The OS's power requests as last read (`refresh_requests`).
    pub fn requests(&self) -> Option<String> {
        self.0.lock_ok().requests.clone()
    }

    /// Read the OS's power requests for the status document — a command,
    /// on Windows `powercfg`, far too slow for a request: called on the
    /// service's own thread, never on a request's path.
    pub fn refresh_requests(&self) {
        let r = crate::node::power::requests_report();
        self.0.lock_ok().requests = r;
    }
}

/// santree's door (santree.rs): connections piping now, and the last one
/// refused.
#[derive(Default)]
pub struct SantreeCounters {
    open: AtomicUsize,
    refused: Mutex<Option<crate::core::status::SantreeRefused>>,
}

/// Counts one santree connection while it pipes (`SantreeCounters::opened`).
pub struct SantreeOpen<'a>(&'a SantreeCounters);

impl Drop for SantreeOpen<'_> {
    fn drop(&mut self) {
        self.0.open.fetch_sub(1, Ordering::Relaxed);
    }
}

impl SantreeCounters {
    /// A santree connection starts piping; the guard counts it until dropped.
    pub fn opened(&self) -> SantreeOpen<'_> {
        self.open.fetch_add(1, Ordering::Relaxed);
        SantreeOpen(self)
    }

    /// santree's door refused a connection with `code`.
    pub fn refused(&self, code: crate::ipc::rpc::ErrorCode) {
        *self.refused.lock_ok() = Some(crate::core::status::SantreeRefused {
            at: crate::core::state::now_rfc3339(),
            code,
        });
    }

    /// Connections piping now.
    pub fn open(&self) -> usize {
        self.open.load(Ordering::Relaxed)
    }

    pub fn last_refused(&self) -> Option<crate::core::status::SantreeRefused> {
        self.refused.lock_ok().clone()
    }
}
