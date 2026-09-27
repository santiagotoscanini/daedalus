//! One SRV lookup through the OS resolver (`DnsQuery_W`), with the
//! machine's DNS settings and cache.

use windows::core::PCWSTR;
use windows::Win32::NetworkManagement::Dns::{
    DnsFree, DnsFreeRecordList, DnsQuery_W, DNS_QUERY_STANDARD, DNS_RECORDA, DNS_RECORDW,
    DNS_TYPE_SRV,
};

pub fn srv_lookup(name: &str) -> Option<(String, u16)> {
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
