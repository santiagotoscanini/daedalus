//! This machine on its network: the adapter it talks through, its address,
//! its hardware address, and the DNS search suffixes DHCP handed it — the
//! last being how the agent finds the box (see discover.rs).
//!
//! The reading is per OS (`os::primary_adapter`): Windows reads
//! `GetAdaptersAddresses`, macOS asks `route`, `ifconfig` and `scutil`;
//! on Linux everything is empty.

#[derive(Clone, Debug, Default)]
pub struct Adapter {
    pub mac: Option<String>,
    pub ipv4: Option<String>,
    /// Connection-specific DNS suffixes, one per adapter that has one.
    pub dns_suffixes: Vec<String>,
}

/// The first adapter that is up, not loopback, and has an IPv4 address —
/// which on a desktop is the one connected to the LAN — plus every DNS
/// suffix seen on any adapter, since the search domain may be on another.
pub fn primary() -> Adapter {
    crate::os::primary_adapter()
}
