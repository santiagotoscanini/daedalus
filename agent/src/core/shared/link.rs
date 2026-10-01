//! This machine's link to the controller as the service holds it: what its
//! loop last saw, the keys it dials under, how it reaches the box, and the
//! log-in and log-out waiting on it (node/link.rs, enroll.rs).

use std::sync::Mutex;

use crate::link::{LinkKeys, LinkStatus, TunnelStatus};
use crate::net::Dialer;
use crate::util::{LockExt, Shutdown};

/// Where the link answers a log-out's `leave` (`request_leave`): Ok, or the
/// controller's refusal.
pub type LeaveAnswer = std::sync::mpsc::SyncSender<Result<(), String>>;

pub struct LinkHub {
    /// This machine's link to the controller, as its loop last saw it;
    /// None on the controller, and until the loop starts.
    status: Mutex<Option<LinkStatus>>,
    /// Where the link goes and whom it trusts — config.toml's two keys as
    /// the service last read them — and a count that moves when they change
    /// (`set_keys`): pairing a running service moves it, and the link
    /// drops what it was doing and starts over under the new keys.
    keys: Mutex<(LinkKeys, u64)>,
    /// How this machine reaches the box (net.rs): direct, or through its
    /// own tunnel only — set at start from tunnel.toml, moved by a log-in
    /// or a log-out (enroll.rs).
    dialer: Mutex<Dialer>,
    /// A log-out waiting for the link to tell the controller
    /// (`request_leave`): answered once the controller answered.
    leave: Mutex<Option<LeaveAnswer>>,
    /// A log-in begun and not finished: its app and PKCE verifier
    /// (enroll.rs), held here and nowhere else.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    log_in: Mutex<Option<crate::node::enroll::Started>>,
    /// Nudged when the link should look at once (new keys, a log-out).
    stop: Shutdown,
}

impl LinkHub {
    pub fn new(stop: Shutdown) -> Self {
        Self {
            status: Mutex::new(None),
            keys: Mutex::default(),
            dialer: Mutex::new(Dialer::Direct),
            leave: Mutex::new(None),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            log_in: Mutex::new(None),
            stop,
        }
    }

    /// Edit this machine's view of its link to the controller (node/link.rs).
    pub fn set_status(&self, f: impl FnOnce(&mut LinkStatus)) {
        f(self
            .status
            .lock_ok()
            .get_or_insert_with(LinkStatus::default));
    }

    /// The link as the page shows it, the tunnel with it; None on the
    /// controller and before the link's loop starts.
    pub fn status(&self) -> Option<LinkStatus> {
        let tunnel = self.tunnel_status();
        self.status
            .lock_ok()
            .clone()
            .map(|l| LinkStatus { tunnel, ..l })
    }

    /// Whether the box can be asked now: the link up, this machine approved.
    pub fn linked(&self) -> bool {
        self.status
            .lock_ok()
            .as_ref()
            .is_some_and(|l| l.connected && l.state == Some(crate::link::LinkState::Approved))
    }

    /// The link's keys and their count.
    pub fn keys(&self) -> (LinkKeys, u64) {
        self.keys.lock_ok().clone()
    }

    /// Set the link's keys; when they differ from the ones held, the count
    /// moves and the waiting link is woken (the stop's nudge). True when
    /// they moved.
    pub fn set_keys(&self, keys: LinkKeys) -> bool {
        let moved = {
            let mut k = self.keys.lock_ok();
            if k.0 == keys {
                false
            } else {
                *k = (keys, k.1 + 1);
                true
            }
        };
        if moved {
            self.stop.nudge();
        }
        moved
    }

    /// How this machine reaches the box now (net.rs).
    pub fn dialer(&self) -> Dialer {
        self.dialer.lock_ok().clone()
    }

    /// Reach the box another way from now on: a log-in's tunnel, or
    /// direct again after a log-out. The old tunnel stops when its last
    /// user lets go of it (enroll.rs stops it at once).
    pub fn set_dialer(&self, d: Dialer) {
        *self.dialer.lock_ok() = d;
    }

    /// The tunnel as the page shows it: its own status, or why a tunnel
    /// config is not up; None without one.
    pub fn tunnel_status(&self) -> Option<TunnelStatus> {
        match self.dialer() {
            Dialer::Direct => None,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            Dialer::Tunnel(t) => Some(t.status()),
            Dialer::Refused(why) => Some(TunnelStatus {
                error: Some(why),
                ..Default::default()
            }),
        }
    }

    /// Ask the link to tell the controller this machine leaves (a log-out,
    /// enroll.rs): the answer comes once the controller answered — Ok when
    /// it acknowledged, its refusal's words when nobody at the box heard it
    /// — and never when the link is down; the caller waits a bounded time.
    pub fn request_leave(&self) -> std::sync::mpsc::Receiver<Result<(), String>> {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        *self.leave.lock_ok() = Some(tx);
        self.stop.nudge();
        rx
    }

    /// A log-out's request for the link, once (node/link.rs).
    pub fn take_leave(&self) -> Option<LeaveAnswer> {
        self.leave.lock_ok().take()
    }

    /// Keep a log-in begun (or drop the one kept: None).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub fn set_log_in(&self, s: Option<crate::node::enroll::Started>) {
        *self.log_in.lock_ok() = s;
    }

    /// The log-in begun, taken: a code is redeemed once.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub fn take_log_in(&self) -> Option<crate::node::enroll::Started> {
        self.log_in.lock_ok().take()
    }
}
