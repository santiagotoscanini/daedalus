//! The point of the whole thing on a node: the machine held awake while
//! the policy says so — held by default, then the box's word once the
//! controller has approved this machine. The guard releases it on a clean
//! stop, the OS on any other.

use crate::power;
use crate::shared::Shared;

#[derive(Default)]
pub struct HoldKeeper {
    hold: Option<power::Hold>,
    /// The policy's word last followed; None before the first.
    wanted: Option<bool>,
}

impl HoldKeeper {
    /// Follow the policy's `awake_hold` when it moved.
    pub fn follow(&mut self, wanted: bool, shared: &Shared) {
        if self.wanted == Some(wanted) {
            return;
        }
        self.wanted = Some(wanted);
        if !wanted {
            // The box said this machine may sleep: release the request.
            // The plan's timers stay as they are — the request is what
            // held the machine, and the plan is the user's to set back.
            self.hold = None;
            shared.power.set_hold(false, None);
            tracing::info!("awake hold released: the policy for this machine is off");
            return;
        }
        self.hold = match power::Hold::acquire(
            "daedalus-agent: this machine serves the fleet and is kept awake by the box",
        ) {
            Ok(h) => {
                shared.power.set_hold(true, None);
                Some(h)
            }
            Err(e) => {
                tracing::error!(error = %e, "could not hold the machine awake");
                shared.power.set_hold(false, Some(e.to_string()));
                None
            }
        };
        match power::converge_plan() {
            Ok(Some(what)) => tracing::info!("power plan set: {what}"),
            // Nothing to converge on this OS; the assertion is the whole hold.
            Ok(None) => {}
            Err(e) => tracing::warn!(error = %e, "power plan not set"),
        }
    }
}
