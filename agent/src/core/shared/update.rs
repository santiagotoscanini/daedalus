//! What the updater says and is asked (update/): a newer release, a restart
//! waiting for the service manager, and a check asked for now.

use std::sync::Mutex;

use crate::util::{LockExt, Shutdown};

pub struct UpdateState {
    flags: Mutex<Flags>,
    /// Nudged by a check request, so the updater wakes at once.
    stop: Shutdown,
}

#[derive(Default)]
struct Flags {
    available: Option<String>,
    restart_pending: bool,
    /// Raised by the local socket's `update.check` or by the controller's
    /// command; the updater clears it when it looks.
    check_requested: bool,
}

impl UpdateState {
    pub fn new(stop: Shutdown) -> Self {
        Self {
            flags: Mutex::default(),
            stop,
        }
    }

    pub fn set_available(&self, v: Option<String>) {
        self.flags.lock_ok().available = v;
    }

    pub fn available(&self) -> Option<String> {
        self.flags.lock_ok().available.clone()
    }

    pub fn set_restart_pending(&self) {
        self.flags.lock_ok().restart_pending = true;
    }

    pub fn restart_pending(&self) -> bool {
        self.flags.lock_ok().restart_pending
    }

    pub fn request_check(&self) {
        self.flags.lock_ok().check_requested = true;
        self.stop.nudge();
    }

    /// Whether a check was asked for since the last call; clears it.
    pub fn take_check_request(&self) -> bool {
        std::mem::take(&mut self.flags.lock_ok().check_requested)
    }
}
