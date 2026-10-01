//! The tray watchdog, where the OS needs one (`os::svc::WATCHES_TRAY`:
//! Windows): a tray that has not reported for a while is started again in
//! the console user's session, at most once a minute. Nothing starts it
//! otherwise until the next logon — the Run key fires once. On the Mac,
//! KeepAlive and `launchd::kickstart_tray` cover it; on Linux the session
//! is a user unit systemd restarts.

use std::time::{Duration, Instant};

use crate::core::shared::Shared;
use crate::os;

/// How long after the service's start a silent tray is first looked for.
const GRACE: Duration = Duration::from_secs(45);
/// The least time between two starts.
const EVERY: Duration = Duration::from_secs(60);

pub struct TrayWatchdog {
    started: Instant,
    tried: Instant,
}

impl TrayWatchdog {
    pub fn new(started: Instant) -> Self {
        Self {
            started,
            tried: Instant::now(),
        }
    }

    pub fn tick(&mut self, shared: &Shared) {
        if !os::svc::WATCHES_TRAY
            || !shared.role.tray
            || shared.claude.reporting()
            || self.started.elapsed() <= GRACE
            || self.tried.elapsed() <= EVERY
        {
            return;
        }
        self.tried = Instant::now();
        if let Err(e) = os::svc::launch_tray_or_session() {
            tracing::info!(error = format!("{e:#}"), "tray not started");
        }
    }
}
