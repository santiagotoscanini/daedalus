//! Small helpers the agent's threads share.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Sleep in short steps so a stop request is honoured within half a second.
/// Returns true when stopped. For threads with nothing else to wake for
/// (the hello and the telemetry sampler; the updater has its own, which a
/// "check now" also cuts short).
pub fn sleep_until(stop: &AtomicBool, total: Duration) -> bool {
    let step = Duration::from_millis(500);
    let mut left = total;
    while !left.is_zero() {
        if stop.load(Ordering::Relaxed) {
            return true;
        }
        let d = left.min(step);
        std::thread::sleep(d);
        left -= d;
    }
    stop.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_raised_stop_ends_the_wait_at_once() {
        let stop = AtomicBool::new(true);
        let t = std::time::Instant::now();
        assert!(sleep_until(&stop, Duration::from_secs(30)));
        assert!(t.elapsed() < Duration::from_secs(1));
        assert!(!sleep_until(&AtomicBool::new(false), Duration::ZERO));
    }
}
