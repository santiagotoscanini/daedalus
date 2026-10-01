//! The pre-auth pools: a connection not yet admitted holds a slot from the
//! network's pool or loopback's, which cannot starve each other, and refused
//! handshakes are logged a few a minute. Why loopback has a pool of its own,
//! and what a local client can still do: README.md, "The link".

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::util::lock;

/// Connections from the network not yet admitted, in all…
pub const MAX_PREAUTH: usize = 32;
/// …and from one address.
pub const PREAUTH_PER_IP: usize = 3;
/// Connections from loopback (VPN peers, containers) not yet admitted: a
/// pool of their own.
pub const LOOPBACK_PREAUTH: usize = 64;
/// Refused handshakes logged a minute; the rest are counted.
pub const REFUSALS_PER_MINUTE: u32 = 10;

/// The address a limit counts: an IPv4 address as it is (an IPv4-mapped IPv6
/// one as its IPv4), an IPv6 address by its /64 — one host has a whole /64 to
/// pick from. The controller's link counts the same way.
fn ip_bucket(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => IpAddr::V4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
    }
}

/// The pre-auth pools.
#[derive(Default)]
pub(crate) struct Preauth {
    /// The network's, by address; its total is the sum.
    per_ip: Mutex<HashMap<IpAddr, usize>>,
    total: AtomicUsize,
    loopback: AtomicUsize,
}

/// One pre-auth slot, given back on drop.
pub(crate) struct Slot {
    preauth: Arc<Preauth>,
    /// None: a loopback slot.
    bucket: Option<IpAddr>,
}

impl Preauth {
    pub(crate) fn slot(self: &Arc<Self>, ip: IpAddr) -> Option<Slot> {
        let bucket = ip_bucket(ip);
        // `::1`'s /64 is `::`: loopback is asked of the address itself (and of
        // its IPv4, for an IPv4-mapped one).
        if ip.is_loopback() || bucket.is_loopback() {
            self.loopback
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                    (n < LOOPBACK_PREAUTH).then_some(n + 1)
                })
                .ok()?;
            return Some(Slot {
                preauth: self.clone(),
                bucket: None,
            });
        }
        let mut per = lock(&self.per_ip);
        let mine = per.get(&bucket).copied().unwrap_or(0);
        if mine >= PREAUTH_PER_IP || self.total.load(Ordering::Acquire) >= MAX_PREAUTH {
            return None;
        }
        per.insert(bucket, mine + 1);
        self.total.fetch_add(1, Ordering::AcqRel);
        Some(Slot {
            preauth: self.clone(),
            bucket: Some(bucket),
        })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let Some(bucket) = self.bucket else {
            self.preauth.loopback.fetch_sub(1, Ordering::AcqRel);
            return;
        };
        let mut per = lock(&self.preauth.per_ip);
        if let Some(n) = per.get_mut(&bucket) {
            *n -= 1;
            if *n == 0 {
                per.remove(&bucket);
            }
        }
        self.preauth.total.fetch_sub(1, Ordering::AcqRel);
    }
}

/// At most [`REFUSALS_PER_MINUTE`] refusal lines a minute; the rest counted
/// and summed up in the first line of the next minute.
#[derive(Default)]
pub(crate) struct RefusalLog {
    window: Mutex<(Option<Instant>, u32, u64)>,
}

impl RefusalLog {
    /// Whether to log this one, and how many were held back before it.
    pub(crate) fn admit(&self) -> Option<u64> {
        let now = Instant::now();
        let mut w = lock(&self.window);
        let (start, logged, held) = &mut *w;
        if start.is_none_or(|s| now.duration_since(s) >= Duration::from_secs(60)) {
            *start = Some(now);
            *logged = 0;
        }
        if *logged < REFUSALS_PER_MINUTE {
            *logged += 1;
            Some(std::mem::take(held))
        } else {
            *held += 1;
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Loopback has a pool of its own, the network its per-address
    /// and total limits, and neither can starve the other.
    #[test]
    fn loopback_and_the_network_have_separate_pre_auth_pools() {
        let pre = Arc::new(Preauth::default());
        let lan = |n: u8| IpAddr::from([192, 0, 2, n]);
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        let lo6: IpAddr = "::1".parse().unwrap();

        let mut held: Vec<Slot> = (0..LOOPBACK_PREAUTH)
            .map(|i| pre.slot(if i % 2 == 0 { lo } else { lo6 }).unwrap())
            .collect();
        assert!(pre.slot(lo).is_none(), "loopback's pool is full");
        // The network is untouched by it: three per address…
        for _ in 0..PREAUTH_PER_IP {
            held.push(pre.slot(lan(1)).unwrap());
        }
        assert!(pre.slot(lan(1)).is_none());
        // …and MAX_PREAUTH in all.
        let mut n = 2;
        while held.len() < LOOPBACK_PREAUTH + MAX_PREAUTH {
            if let Some(slot) = pre.slot(lan(n)) {
                held.push(slot);
            } else {
                n += 1;
            }
        }
        assert!(pre.slot(lan(200)).is_none(), "the network's pool is full");
        drop(held);
        assert!(pre.slot(lo).is_some() && pre.slot(lan(1)).is_some());
        assert_eq!(pre.loopback.load(Ordering::Acquire), 0);
        assert_eq!(pre.total.load(Ordering::Acquire), 0);
    }

    #[test]
    fn refusals_are_logged_a_few_a_minute() {
        let log = RefusalLog::default();
        for _ in 0..REFUSALS_PER_MINUTE {
            assert_eq!(log.admit(), Some(0));
        }
        assert_eq!(log.admit(), None);
        assert_eq!(log.admit(), None);
        // A new minute: the first line says how many were held back.
        log.window.lock().unwrap().0 = Some(Instant::now() - Duration::from_secs(61));
        assert_eq!(log.admit(), Some(2));
    }
}
