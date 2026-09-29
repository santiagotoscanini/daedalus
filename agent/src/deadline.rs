//! Absolute deadlines. A timeout set per read (`SO_RCVTIMEO`) restarts with
//! every byte, so a peer that trickles one byte at a time holds a
//! connection for as long as it likes; a `Deadline` is a point in time that
//! does not move, and a `Watchdog` enforces one on a blocking transport by
//! tearing it down when it passes — whatever the thread holding it is
//! blocked in (a read, a write, a flush).

use crate::util::LockExt;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// A fixed point in time by which something must be done.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deadline {
    at: Instant,
}

impl Deadline {
    /// `d` from now.
    pub fn after(d: Duration) -> Self {
        Self {
            at: Instant::now() + d,
        }
    }

    pub fn at(at: Instant) -> Self {
        Self { at }
    }

    /// What is left of it; zero once it passed.
    pub fn remaining(&self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }

    pub fn passed(&self) -> bool {
        Instant::now() >= self.at
    }

    /// The timeout one blocking call may take: what is left, at most `cap`,
    /// never zero (a zero socket timeout means "block forever").
    pub fn timeout(&self, cap: Duration) -> Duration {
        self.remaining().min(cap).max(Duration::from_millis(1))
    }
}

/// How often a watchdog that fired fires again, for as long as it is armed:
/// an operation started after the first teardown (a flush, a retried read)
/// is cut too.
const REFIRE: Duration = Duration::from_millis(100);

/// Tears a transport down (`close`) when its deadline passes, and again
/// every `REFIRE` until dropped. Dropping it before the deadline disarms it
/// and never waits.
pub struct Watchdog {
    state: Arc<(Mutex<bool>, Condvar)>,
}

impl Watchdog {
    /// Arm `close` for `deadline`. Without a thread for it (the process is
    /// out of them) the transport is closed at once: failing shut.
    pub fn arm(deadline: Deadline, close: impl Fn() + Send + Sync + 'static) -> Self {
        let state = Arc::new((Mutex::new(false), Condvar::new()));
        let theirs = Arc::clone(&state);
        let close = Arc::new(close);
        let for_thread = Arc::clone(&close);
        let spawned = std::thread::Builder::new()
            .name("deadline".into())
            .spawn(move || {
                let (lock, cv) = &*theirs;
                let mut disarmed = lock.lock_ok();
                let mut wait = deadline.remaining();
                loop {
                    if *disarmed {
                        return;
                    }
                    if wait.is_zero() {
                        for_thread();
                        wait = REFIRE;
                        continue;
                    }
                    let (g, _) = cv
                        .wait_timeout(disarmed, wait)
                        .unwrap_or_else(|p| p.into_inner());
                    disarmed = g;
                    if !*disarmed {
                        wait = deadline.remaining();
                        if wait.is_zero() {
                            for_thread();
                            wait = REFIRE;
                        }
                    }
                }
            });
        if spawned.is_err() {
            close();
        }
        Self { state }
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        let (lock, cv) = &*self.state;
        *lock.lock_ok() = true;
        cv.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn a_deadline_does_not_move() {
        let d = Deadline::after(Duration::from_millis(50));
        assert!(!d.passed());
        assert!(d.timeout(Duration::from_secs(9)) <= Duration::from_millis(50));
        std::thread::sleep(Duration::from_millis(60));
        assert!(d.passed());
        assert_eq!(d.remaining(), Duration::ZERO);
        assert_eq!(d.timeout(Duration::from_secs(9)), Duration::from_millis(1));
    }

    #[test]
    fn a_watchdog_fires_and_refires_until_dropped_and_never_when_disarmed() {
        let n = Arc::new(AtomicUsize::new(0));
        let w = {
            let n = Arc::clone(&n);
            Watchdog::arm(Deadline::after(Duration::from_millis(30)), move || {
                n.fetch_add(1, Ordering::SeqCst);
            })
        };
        std::thread::sleep(Duration::from_millis(300));
        drop(w);
        let fired = n.load(Ordering::SeqCst);
        assert!(fired >= 2, "fired {fired} times");
        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(n.load(Ordering::SeqCst), fired, "stopped once dropped");

        let m = Arc::new(AtomicUsize::new(0));
        let w = {
            let m = Arc::clone(&m);
            Watchdog::arm(Deadline::after(Duration::from_millis(100)), move || {
                m.fetch_add(1, Ordering::SeqCst);
            })
        };
        drop(w);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(m.load(Ordering::SeqCst), 0);
    }
}
