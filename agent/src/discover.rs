//! Finding the controller without being told.
//!
//! The box runs the LAN's DNS and DHCP, so it announces its controller where
//! every machine already looks: an SRV record `_daedalus-controller._tcp.<domain>`
//! under the search domain DHCP handed out. The agent asks config.toml's
//! `search_domains`, then each suffix its adapters carry (net.rs), and takes
//! the first answer. A `controller_address` in config.toml wins over all of
//! it (link/node.rs), for a machine whose DNS is not the box's. What DNS
//! names is only an address: the key is still the pin's.
//!
//! The records come from the OS (`os::srv_lookup`): on Windows its resolver
//! (`DnsQuery_W`), with the machine's DNS settings and cache; on macOS and
//! Linux one UDP question to resolv.conf's nameservers (dns.rs), no tool
//! needed. Which record is used is `dns::pick`'s, the same everywhere: the
//! lowest priority, then the heaviest weight.

use crate::config::Config;
use crate::net::Adapter;

/// The controller's `host:port` and the suffix that named it; None when no
/// domain has the record.
pub fn find_controller(cfg: &Config, adapter: &Adapter) -> Option<(String, String)> {
    let mut suffixes: Vec<String> = cfg.search_domains.clone();
    for s in &adapter.dns_suffixes {
        if !suffixes.contains(s) {
            suffixes.push(s.clone());
        }
    }
    suffixes.into_iter().find_map(|suffix| {
        let records = crate::os::srv_lookup(&format!("{}.{suffix}", crate::link::SRV_SERVICE));
        crate::dns::pick(&records)
            .map(|(target, port)| (format!("{}:{port}", target.trim_end_matches('.')), suffix))
    })
}
