//! This machine on its network: the interface the default route leaves
//! through (`/proc/net/route`), its hardware address (sysfs, lowercase as
//! the kernel writes it) and IPv4 address (`getifaddrs`), the search
//! domains from resolv.conf — where DHCP's domain lands through NetworkManager,
//! systemd-resolved's stub or dhclient alike — and the SRV lookup, asked
//! over UDP of resolv.conf's nameservers (dns.rs).

use std::ffi::CStr;
use std::time::Duration;

use super::{read, read_line};
use crate::dns;
use crate::net::Adapter;
use crate::telemetry::parse::linux_sys;

fn resolv_conf() -> dns::ResolvConf {
    read("/etc/resolv.conf")
        .map(|t| dns::parse_resolv_conf(&t))
        .unwrap_or_default()
}

pub fn primary_adapter() -> Adapter {
    let mut out = Adapter {
        dns_suffixes: resolv_conf().search,
        ..Default::default()
    };
    let Some(iface) = read("/proc/net/route").and_then(|t| linux_sys::default_route_iface(&t))
    else {
        return out;
    };
    out.mac = read_line(format!("/sys/class/net/{iface}/address"))
        .map(|m| m.to_lowercase())
        .filter(|m| m != "00:00:00:00:00:00");
    out.ipv4 = ipv4_of(&iface);
    out
}

/// The first IPv4 address `getifaddrs` lists for the interface.
fn ipv4_of(iface: &str) -> Option<String> {
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills a list it allocates; it is walked read-only
    // and freed once below.
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return None;
    }
    let mut found = None;
    let mut cur = head;
    while !cur.is_null() {
        // SAFETY: a node of the list getifaddrs returned, alive until freeifaddrs.
        let ifa = unsafe { &*cur };
        cur = ifa.ifa_next;
        if ifa.ifa_addr.is_null() || ifa.ifa_name.is_null() {
            continue;
        }
        // SAFETY: a NUL-terminated name owned by the list.
        let name = unsafe { CStr::from_ptr(ifa.ifa_name) };
        // SAFETY: ifa_addr is non-null and at least a sockaddr.
        let family = unsafe { (*ifa.ifa_addr).sa_family };
        if name.to_bytes() != iface.as_bytes() || i32::from(family) != libc::AF_INET {
            continue;
        }
        // SAFETY: AF_INET means the address is a sockaddr_in.
        let sin = unsafe { &*(ifa.ifa_addr as *const libc::sockaddr_in) };
        let ip = std::net::Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr));
        found = Some(ip.to_string());
        break;
    }
    // SAFETY: the list getifaddrs allocated, freed once.
    unsafe { libc::freeifaddrs(head) };
    found
}

/// `name`'s SRV record, from resolv.conf's nameservers, two seconds each.
pub fn srv_lookup(name: &str) -> Option<(String, u16)> {
    let servers = resolv_conf().nameservers;
    dns::lookup(name, &servers, Duration::from_secs(2))
}
