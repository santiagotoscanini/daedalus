//! This Mac on its network: the interface the default route leaves
//! through (`route`), its hardware and IPv4 addresses (`ifconfig`), and the
//! search domains (`scutil --dns`, which is where DHCP's domain lands).

use super::stdout_of as run;
use crate::net::Adapter;

/// The interface the default route leaves through, then its hardware
/// and IPv4 addresses from `ifconfig`, and the search domains from
/// `scutil --dns` — which is where DHCP's domain lands on macOS.
pub fn primary_adapter() -> Adapter {
    let mut out = Adapter::default();
    let route = run("route", &["-n", "get", "default"]);
    let iface = route
        .lines()
        .find_map(|l| l.trim().strip_prefix("interface:"))
        .map(|s| s.trim().to_string());
    if let Some(iface) = iface {
        let cfg = run("ifconfig", &[&iface]);
        for l in cfg.lines() {
            let l = l.trim();
            if let Some(rest) = l.strip_prefix("ether ") {
                out.mac = rest.split_whitespace().next().map(|m| m.to_uppercase());
            } else if let Some(rest) = l.strip_prefix("inet ") {
                out.ipv4 = rest.split_whitespace().next().map(str::to_string);
            }
        }
    }
    let dns = run("scutil", &["--dns"]);
    for l in dns.lines() {
        let l = l.trim();
        if l.starts_with("search domain[") {
            if let Some(d) = l.split(':').nth(1) {
                let d = d.trim().trim_end_matches('.').to_string();
                if !d.is_empty() && !out.dns_suffixes.contains(&d) {
                    out.dns_suffixes.push(d);
                }
            }
        }
    }
    out
}
