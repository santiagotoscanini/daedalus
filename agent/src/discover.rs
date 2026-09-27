//! Finding the controller without being told.
//!
//! The box runs the LAN's DNS and DHCP, so it announces its controller where
//! every machine already looks: an SRV record `_daedalus-controller._tcp.<domain>`
//! under the search domain DHCP handed out. The agent asks config.toml's
//! `search_domains`, then each suffix its adapters carry (net.rs), and takes
//! the first answer. A `controller_address` in config.toml wins over all of
//! it (link/node.rs), for a machine whose DNS is not the box's. What DNS
//! names is only an address: the key is still the pin's, or a first use.
//!
//! The query is per OS (`os::srv_lookup`). On Windows it goes through the
//! OS resolver (`DnsQuery_W`), with the machine's DNS settings and cache.
//! On macOS it is `dig`, which reads the resolv.conf macOS generates from
//! its primary resolver and bypasses the system cache. On Linux it is one
//! UDP question to resolv.conf's nameservers (dns.rs), no tool needed.

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
        crate::os::srv_lookup(&format!("{}.{suffix}", crate::link::SRV_SERVICE))
            .map(|(target, port)| (format!("{}:{port}", target.trim_end_matches('.')), suffix))
    })
}

/// One line of `dig +short SRV`: `0 0 7788 s2-server.lan.` → target and port.
/// Pure, so it is tested everywhere; macOS's lookup (`dig`) reads it.
pub fn parse_short_srv(line: &str) -> Option<(String, u16)> {
    let mut parts = line.split_whitespace();
    let _prio = parts.next()?;
    let _weight = parts.next()?;
    let port: u16 = parts.next()?.parse().ok()?;
    let target = parts.next()?.trim_end_matches('.').to_string();
    (!target.is_empty()).then_some((target, port))
}

#[cfg(test)]
mod tests {
    use super::parse_short_srv;

    #[test]
    fn dig_short_srv_line() {
        assert_eq!(
            parse_short_srv("0 0 7788 s2-server.lan."),
            Some(("s2-server.lan".to_string(), 7788))
        );
        assert_eq!(parse_short_srv(""), None);
        assert_eq!(parse_short_srv(";; connection timed out"), None);
    }
}
