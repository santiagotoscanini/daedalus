//! The box's policy for this machine, and the settings its user asked the
//! box to change (settings.rs `Book`): one hub, since a policy that lands
//! settles the requests it carries.

use std::sync::Mutex;
use std::time::Instant;

use crate::link::wire::{Policy, PolicyRequest};
use crate::node::settings::{Asked, Book, Key};
use crate::util::{LockExt, Shutdown};

pub struct SettingsBook {
    /// What the box wants of this machine; the config's defaults until the
    /// controller has approved it.
    policy: Mutex<Policy>,
    /// The settings asked for from this machine, on their way or failed.
    book: Mutex<Book>,
    /// Nudged when a request is to be sent: the link wakes.
    stop: Shutdown,
}

impl SettingsBook {
    pub fn new(policy: Policy, stop: Shutdown) -> Self {
        Self {
            policy: Mutex::new(policy),
            book: Mutex::default(),
            stop,
        }
    }

    pub fn policy(&self) -> Policy {
        self.policy.lock_ok().clone()
    }

    /// The box's decision, from the controller. Returns whether it changed.
    pub fn set_policy(&self, p: Policy) -> bool {
        let changed = {
            let mut held = self.policy.lock_ok();
            let changed = *held != p;
            held.clone_from(&p);
            changed
        };
        // A request this policy carries is done (settings.rs).
        self.book.lock_ok().settle(&p, Instant::now());
        changed
    }

    /// The machine's user asks for `key` = `value` (`Book::ask`), `linked`
    /// saying whether the box can be asked now; a request to send wakes the
    /// link.
    pub fn ask(
        &self,
        key: Key,
        value: bool,
        linked: bool,
    ) -> Result<Asked, crate::ipc::rpc::ApiError> {
        let kept = self.policy();
        let asked = self
            .book
            .lock_ok()
            .ask(key, value, &kept, linked, Instant::now())?;
        if asked == Asked::Sent {
            self.stop.nudge();
        }
        Ok(asked)
    }

    /// The requests to send now, as one, under a fresh id (node/link.rs).
    pub fn take_request(&self) -> Option<(u64, PolicyRequest)> {
        self.book.lock_ok().take_request(Instant::now())
    }

    /// The controller answered settings request `id` (node/link.rs).
    pub fn answered(&self, id: u64, result: Result<(), String>) {
        let kept = self.policy();
        self.book
            .lock_ok()
            .answered(id, result, &kept, Instant::now());
    }

    /// The policy with the requests still pending and the ones that failed,
    /// settled against it first: what the settings view shows.
    pub fn standing(
        &self,
    ) -> (
        Policy,
        Vec<crate::node::settings::PendingView>,
        Vec<crate::node::settings::FailedView>,
    ) {
        let kept = self.policy();
        let mut b = self.book.lock_ok();
        b.settle(&kept, Instant::now());
        (kept, b.pending(), b.failed())
    }
}
