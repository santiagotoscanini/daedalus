//! Finding the box without being told.
//!
//! The box runs the LAN's DNS and DHCP, so it announces itself where every
//! machine already looks: an SRV record `_daedalus._tcp.<domain>` under the
//! search domain DHCP handed out. The agent asks each suffix its adapters
//! carry (net.rs), takes the first answer, and turns it into a URL — port
//! 443 is https, anything else plain http on that port. A URL in config.toml
//! wins over all of it, for a machine whose DNS is not the box's.
//!
//! The query goes through the OS resolver (`DnsQuery_W` on Windows, `dig`
//! through the system settings on macOS), so it honours the
//! machine's DNS settings and cache like everything else on it.

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
    #[cfg(windows)]
    {
        win::srv(name)
    }
    #[cfg(target_os = "macos")]
    {
        mac::srv(name)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = name;
        None
    }
}

#[cfg(windows)]
mod win {
    use windows::core::PCWSTR;
    use windows::Win32::NetworkManagement::Dns::{
        DnsFree, DnsFreeRecordList, DnsQuery_W, DNS_QUERY_STANDARD, DNS_RECORDA, DNS_RECORDW,
        DNS_TYPE_SRV,
    };

    pub fn srv(name: &str) -> Option<(String, u16)> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // The crate types the out-pointer as the ANSI record even for the wide
        // query; the W call fills wide records, so it is read as such.
        let mut list: *mut DNS_RECORDA = std::ptr::null_mut();
        // SAFETY: the record list the resolver allocates is walked and then
        // freed with the matching call; nothing is kept past that.
        unsafe {
            let rc = DnsQuery_W(
                PCWSTR(wide.as_ptr()),
                DNS_TYPE_SRV,
                DNS_QUERY_STANDARD,
                None,
                &mut list,
                None,
            );
            if rc.is_err() || list.is_null() {
                return None;
            }
            let mut found = None;
            let mut cur = list.cast::<DNS_RECORDW>();
            while !cur.is_null() {
                let r = &*cur;
                if r.wType == DNS_TYPE_SRV.0 {
                    let srv = &r.Data.SRV;
                    let target = srv.pNameTarget.to_string().unwrap_or_default();
                    if !target.is_empty() {
                        found = Some((target, srv.wPort));
                        break;
                    }
                }
                cur = r.pNext;
            }
            DnsFree(Some(list.cast()), DnsFreeRecordList);
            found
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    /// `dig +short SRV` through the system's resolver settings. macOS ships
    /// dig, and its short form is one line per record: `prio weight port target.`
    pub fn srv(name: &str) -> Option<(String, u16)> {
        let out = std::process::Command::new("dig")
            .args(["+short", "+time=2", "+tries=1", "SRV", name])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(super::parse_short_srv)
    }
}

/// One line of `dig +short SRV`: `0 0 443 daedalus-app.example.org.` → target and port.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_short_srv(line: &str) -> Option<(String, u16)> {
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
