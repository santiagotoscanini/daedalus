//! An update on probation proves itself, or fails its run (update/
//! probation.rs has the rules; this is the service's side of them).

use std::time::{Duration, Instant};

use crate::core::shared::Shared;
use crate::node::update;
use crate::os;

/// How often the proof is judged.
const LOOK_EVERY: Duration = Duration::from_secs(5);

pub struct Probation {
    /// This run is on probation and has not proved itself yet.
    on: bool,
    started: Instant,
    looked: Instant,
}

impl Probation {
    pub fn new(start: &update::Start, started: Instant) -> Self {
        Self {
            on: matches!(start, update::Start::Probation(_)),
            started,
            looked: started,
        }
    }

    /// Judge the proof every `LOOK_EVERY` (`update::judge_proof`): proven,
    /// the record is cleared; true when this run failed it, and the service
    /// is to stop so the service manager starts it again (a counted start).
    pub fn tick(&mut self, local_up_for: Option<Duration>, shared: &Shared) -> bool {
        if !self.on || self.looked.elapsed() < LOOK_EVERY {
            return false;
        }
        self.looked = Instant::now();
        let role = shared.role;
        let proof = update::judge_proof(
            local_up_for,
            self.started.elapsed(),
            || role.session && !role.session_in_service && os::svc::interactive_user(),
            shared.claude.reporting(),
        );
        match proof {
            update::Proof::Wait => false,
            update::Proof::Proven(rule) => {
                self.on = false;
                update::prove(shared, rule);
                false
            }
            update::Proof::Failed(why) => {
                tracing::error!(why, "this version failed its probation run; stopping so the service manager starts it again (a counted start)");
                true
            }
        }
    }
}
