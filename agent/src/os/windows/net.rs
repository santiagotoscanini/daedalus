//! The adapter this machine talks through, from `GetAdaptersAddresses`.

use crate::net::Adapter;
use windows::Win32::Foundation::ERROR_BUFFER_OVERFLOW;
use windows::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST,
    IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::Networking::WinSock::{AF_INET, AF_UNSPEC, SOCKADDR_IN};

pub fn primary_adapter() -> Adapter {
    let mut out = Adapter::default();
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size: u32 = 16 * 1024;
    let mut buf: Vec<u8> = Vec::new();
    // SAFETY: the buffer is sized by the call itself; the list it returns
    // is walked only within that buffer.
    unsafe {
        for _ in 0..3 {
            buf.resize(size as usize, 0);
            let rc = GetAdaptersAddresses(
                AF_UNSPEC.0 as u32,
                flags,
                None,
                Some(buf.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>()),
                &mut size,
            );
            if rc == ERROR_BUFFER_OVERFLOW.0 {
                continue;
            }
            if rc != 0 {
                return out;
            }
            break;
        }
        let mut cur = buf.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        while !cur.is_null() {
            let a = &*cur;
            let up = a.OperStatus == IfOperStatusUp;
            let loopback = a.IfType == IF_TYPE_SOFTWARE_LOOPBACK;
            if !a.DnsSuffix.is_null() {
                let s = a.DnsSuffix.to_string().unwrap_or_default();
                if !s.is_empty() && !out.dns_suffixes.contains(&s) {
                    out.dns_suffixes.push(s);
                }
            }
            if up && !loopback && out.ipv4.is_none() {
                let mut ua = a.FirstUnicastAddress;
                while !ua.is_null() {
                    let sa = (*ua).Address.lpSockaddr;
                    if !sa.is_null() && (*sa).sa_family == AF_INET {
                        let v4 = &*(sa.cast::<SOCKADDR_IN>());
                        let b = v4.sin_addr.S_un.S_un_b;
                        out.ipv4 = Some(format!("{}.{}.{}.{}", b.s_b1, b.s_b2, b.s_b3, b.s_b4));
                        let n = a.PhysicalAddressLength as usize;
                        if n > 0 {
                            out.mac = Some(
                                a.PhysicalAddress[..n]
                                    .iter()
                                    .map(|x| format!("{x:02x}"))
                                    .collect::<Vec<_>>()
                                    .join(":"),
                            );
                        }
                        break;
                    }
                    ua = (*ua).Next;
                }
            }
            cur = a.Next;
        }
    }
    out
}
