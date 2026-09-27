//! Finding the box without being told.
//!
//! The box runs the LAN's DNS and DHCP, so it announces itself where every
//! machine already looks: an SRV record `_daedalus._tcp.<domain>` under the
//! search domain DHCP handed out. The agent asks config.toml's
//! `search_domains`, then each suffix its adapters carry (net.rs), takes the
//! first answer, and turns it into a URL — port 443 is https, anything else
//! plain http on that port. A `control_plane_url` in config.toml wins over
//! all of it, for a machine whose DNS is not the box's.
//!
//! The query is per OS (`os::srv_lookup`). On Windows it goes through the
//! OS resolver (`DnsQuery_W`), with the machine's DNS settings and cache.
//! On macOS it is `dig`, which reads the resolv.conf macOS generates from
//! its primary resolver and bypasses the system cache. On Linux it is one
//! UDP question to resolv.conf's nameservers (dns.rs), no tool needed.

use crate::config::Config;
use crate::net::Adapter;

pub const SERVICE: &str = "_daedalus._tcp";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub url: String,
    /// Where it came from, for the status page: the config, or the suffix that answered.
    pub via: String,
}

fn url_of(target: &str, port: u16) -> String {
    let host = target.trim_end_matches('.');
    if port == 443 {
        format!("https://{host}")
    } else {
        format!("http://{host}:{port}")
    }
}

/// The box's base URL, or None when neither config nor DNS names one.
pub fn find(cfg: &Config, adapter: &Adapter) -> Option<Found> {
    if let Some(u) = cfg.control_plane_url.as_deref().filter(|u| !u.is_empty()) {
        return Some(Found {
            url: u.trim_end_matches('/').to_string(),
            via: "config".into(),
        });
    }
    let mut suffixes: Vec<String> = cfg.search_domains.clone();
    for s in &adapter.dns_suffixes {
        if !suffixes.contains(s) {
            suffixes.push(s.clone());
        }
    }
    for suffix in suffixes {
        if let Some((target, port)) = srv(&format!("{SERVICE}.{suffix}")) {
            return Some(Found {
                url: url_of(&target, port),
                via: suffix,
            });
        }
    }
    None
}

/// One SRV lookup: the target and port of the first record, if any.
fn srv(name: &str) -> Option<(String, u16)> {
    crate::os::srv_lookup(name)
}

/// One line of `dig +short SRV`: `0 0 443 daedalus-app.example.org.` → target and port.
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
    use super::{parse_short_srv, url_of};

    #[test]
    fn https_on_443_and_explicit_port_otherwise() {
        assert_eq!(url_of("box.example.org.", 443), "https://box.example.org");
        assert_eq!(url_of("box.lan", 8080), "http://box.lan:8080");
    }

    #[test]
    fn dig_short_srv_line() {
        assert_eq!(
            parse_short_srv("0 0 443 daedalus-app.toscanini.me."),
            Some(("daedalus-app.toscanini.me".to_string(), 443))
        );
        assert_eq!(parse_short_srv(""), None);
        assert_eq!(parse_short_srv(";; connection timed out"), None);
    }
}
