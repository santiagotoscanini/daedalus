//! One DNS SRV question over UDP, asked of the nameservers resolv.conf
//! names — how Linux finds `_daedalus._tcp` without `dig` or a resolver
//! library (the static musl build has neither worth trusting). Windows asks
//! its own resolver and macOS asks `dig` (os/*/); discover.rs picks the name.
//!
//! The wire format is the plain RFC 1035 one: a query with recursion
//! desired, and an answer whose SRV records are read with name compression
//! followed. The text and byte handling is pure and tested on every OS; only
//! `lookup` touches the network.

use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::time::Duration;

/// What resolv.conf says: the nameservers to ask and the search domains.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResolvConf {
    pub nameservers: Vec<IpAddr>,
    pub search: Vec<String>,
}

/// resolv.conf(5): `nameserver` lines in order, and the search list from
/// the LAST `search` or `domain` line (each replaces the other). Comments
/// start with `#` or `;`. A link-local IPv6 server with a zone
/// (`fe80::1%eth0`) is skipped: it is reachable only through that interface's
/// scope id, which a plain address cannot carry, and a LAN that hands one
/// out hands out an IPv4 server beside it.
pub fn parse_resolv_conf(text: &str) -> ResolvConf {
    let mut out = ResolvConf::default();
    for line in text.lines() {
        let line = line.split(['#', ';']).next().unwrap_or("").trim();
        let mut words = line.split_whitespace();
        match words.next() {
            Some("nameserver") => {
                if let Some(ip) = words
                    .next()
                    .filter(|w| !w.contains('%'))
                    .and_then(|w| w.parse::<IpAddr>().ok())
                {
                    out.nameservers.push(ip);
                }
            }
            Some("search") | Some("domain") => {
                out.search = words
                    .map(|w| w.trim_end_matches('.').to_string())
                    .filter(|w| !w.is_empty())
                    .collect();
            }
            _ => {}
        }
    }
    out
}

/// One SRV record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Srv {
    pub priority: u16,
    pub weight: u16,
    pub port: u16,
    pub target: String,
}

const TYPE_SRV: u16 = 33;
const CLASS_IN: u16 = 1;

/// A query for `name`'s SRV records, recursion desired. None for a name no
/// label of which fits the format (empty, or longer than 63 bytes).
pub fn srv_query(id: u16, name: &str) -> Option<Vec<u8>> {
    let mut q = Vec::with_capacity(32 + name.len());
    q.extend_from_slice(&id.to_be_bytes());
    q.extend_from_slice(&0x0100u16.to_be_bytes()); // RD
    q.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
    q.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // AN, NS, AR
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        q.push(label.len() as u8);
        q.extend_from_slice(label.as_bytes());
    }
    q.push(0);
    q.extend_from_slice(&TYPE_SRV.to_be_bytes());
    q.extend_from_slice(&CLASS_IN.to_be_bytes());
    Some(q)
}

fn u16_at(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

/// A (possibly compressed) name at `off`: the name, and where the bytes
/// after it start. A name is at most 128 steps (labels or pointers), so a
/// pointer loop ends as malformed.
fn read_name(msg: &[u8], mut off: usize) -> Option<(String, usize)> {
    let mut labels: Vec<String> = Vec::new();
    let mut end: Option<usize> = None;
    for _ in 0..128 {
        let len = *msg.get(off)?;
        match len {
            0 => {
                return Some((labels.join("."), end.unwrap_or(off + 1)));
            }
            l if l & 0xC0 == 0xC0 => {
                let ptr = (usize::from(l & 0x3F) << 8) | usize::from(*msg.get(off + 1)?);
                end.get_or_insert(off + 2);
                off = ptr;
            }
            l if l & 0xC0 == 0 => {
                let l = usize::from(l);
                let bytes = msg.get(off + 1..off + 1 + l)?;
                labels.push(String::from_utf8_lossy(bytes).into_owned());
                off += 1 + l;
            }
            _ => return None,
        }
    }
    None
}

/// The SRV records in an answer to query `id`; None when it is not that
/// answer, or says the name does not exist, or is malformed.
pub fn parse_srv_answer(id: u16, msg: &[u8]) -> Option<Vec<Srv>> {
    if u16_at(msg, 0)? != id {
        return None;
    }
    let flags = u16_at(msg, 2)?;
    if flags & 0x8000 == 0 || flags & 0x000F != 0 {
        return None;
    }
    let qd = u16_at(msg, 4)?;
    let an = u16_at(msg, 6)?;
    let mut off = 12;
    for _ in 0..qd {
        off = read_name(msg, off)?.1 + 4;
    }
    let mut out = Vec::new();
    for _ in 0..an {
        let (_, after) = read_name(msg, off)?;
        let ty = u16_at(msg, after)?;
        let len = usize::from(u16_at(msg, after + 8)?);
        let rdata = after + 10;
        if msg.len() < rdata + len {
            return None;
        }
        if ty == TYPE_SRV && len >= 7 {
            let (target, _) = read_name(msg, rdata + 6)?;
            out.push(Srv {
                priority: u16_at(msg, rdata)?,
                weight: u16_at(msg, rdata + 2)?,
                port: u16_at(msg, rdata + 4)?,
                target,
            });
        }
        off = rdata + len;
    }
    Some(out)
}

/// The record to use: the lowest priority, then the heaviest weight.
/// A target of "." means "no such service" and is never picked.
pub fn pick(records: &[Srv]) -> Option<(String, u16)> {
    records
        .iter()
        .filter(|r| !r.target.is_empty())
        .min_by(|a, b| a.priority.cmp(&b.priority).then(b.weight.cmp(&a.weight)))
        .map(|r| (r.target.clone(), r.port))
}

/// Ask each server in turn, `timeout` each, and pick from the first that
/// answers with records.
pub fn lookup(name: &str, servers: &[IpAddr], timeout: Duration) -> Option<(String, u16)> {
    let mut idb = [0u8; 2];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut idb);
    let id = u16::from_be_bytes(idb);
    let query = srv_query(id, name)?;
    for server in servers {
        let bind: SocketAddr = if server.is_ipv4() {
            "0.0.0.0:0".parse().ok()?
        } else {
            "[::]:0".parse().ok()?
        };
        let Ok(sock) = UdpSocket::bind(bind) else {
            continue;
        };
        if sock.set_read_timeout(Some(timeout)).is_err()
            || sock.connect(SocketAddr::new(*server, 53)).is_err()
            || sock.send(&query).is_err()
        {
            continue;
        }
        let mut buf = [0u8; 1500];
        // A stray datagram for another id is skipped; the timeout bounds it.
        for _ in 0..3 {
            let Ok(n) = sock.recv(&mut buf) else { break };
            if let Some(records) = parse_srv_answer(id, &buf[..n]) {
                if let Some(found) = pick(&records) {
                    return Some(found);
                }
                break;
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolv_conf_nameservers_and_the_last_search_line() {
        let r = parse_resolv_conf(
            "# Generated by NetworkManager\ndomain old.lan\nsearch toscanini.me lan.\n\
             nameserver 192.168.0.2\nnameserver fe80::1%enp3s0 ; link-local\n\
             nameserver bogus\nnameserver 2001:db8::53\noptions edns0\n",
        );
        assert_eq!(
            r.nameservers,
            vec![
                "192.168.0.2".parse::<IpAddr>().unwrap(),
                "2001:db8::53".parse::<IpAddr>().unwrap()
            ]
        );
        assert_eq!(r.search, vec!["toscanini.me", "lan"]);
        // systemd-resolved's stub file.
        let stub =
            parse_resolv_conf("nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch home\n");
        assert_eq!(stub.search, vec!["home"]);
        assert_eq!(parse_resolv_conf(""), ResolvConf::default());
    }

    #[test]
    fn a_query_is_the_rfc_1035_bytes() {
        let q = srv_query(0xBEEF, "_d._tcp.lan").unwrap();
        assert_eq!(
            q,
            [
                0xBE, 0xEF, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2, b'_', b'd', 4, b'_', b't', b'c', b'p',
                3, b'l', b'a', b'n', 0, 0, 33, 0, 1
            ]
        );
        assert!(srv_query(1, "a..b").is_none());
        assert!(srv_query(1, &"x".repeat(64)).is_none());
    }

    /// An answer the way a server writes one: the question echoed, then
    /// two SRV records whose owner names point back at it, one target
    /// compressed against the question.
    fn answer(id: u16, rcode: u8) -> Vec<u8> {
        let mut m = srv_query(id, "_daedalus._tcp.toscanini.me").unwrap();
        m[2] = 0x81;
        m[3] = 0x80 | rcode;
        m[7] = 2; // ANCOUNT
        let record = |m: &mut Vec<u8>, prio: u16, weight: u16, port: u16, target: &[u8]| {
            m.extend_from_slice(&[0xC0, 12]); // owner: the question's name
            m.extend_from_slice(&[0, 33, 0, 1, 0, 0, 0, 60]);
            m.extend_from_slice(&((6 + target.len()) as u16).to_be_bytes());
            m.extend_from_slice(&prio.to_be_bytes());
            m.extend_from_slice(&weight.to_be_bytes());
            m.extend_from_slice(&port.to_be_bytes());
            m.extend_from_slice(target);
        };
        // "daedalus-app" then a pointer to "toscanini.me" in the question
        // (offset 12 + 1+9 + 1+4 = 27).
        let mut t1 = vec![12];
        t1.extend_from_slice(b"daedalus-app");
        t1.extend_from_slice(&[0xC0, 27]);
        record(&mut m, 10, 5, 443, &t1);
        let mut t2 = vec![6];
        t2.extend_from_slice(b"backup");
        t2.extend_from_slice(&[3, b'l', b'a', b'n', 0]);
        record(&mut m, 20, 0, 8080, &t2);
        m
    }

    #[test]
    fn an_answer_reads_with_compression_and_the_lowest_priority_wins() {
        let recs = parse_srv_answer(7, &answer(7, 0)).unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].target, "daedalus-app.toscanini.me");
        assert_eq!(recs[1].target, "backup.lan");
        assert_eq!(
            pick(&recs),
            Some(("daedalus-app.toscanini.me".to_string(), 443))
        );
        // Another id, NXDOMAIN, a query rather than an answer, truncation.
        assert!(parse_srv_answer(8, &answer(7, 0)).is_none());
        assert!(parse_srv_answer(7, &answer(7, 3)).is_none());
        assert!(parse_srv_answer(7, &srv_query(7, "a.b").unwrap()).is_none());
        let full = answer(7, 0);
        assert!(parse_srv_answer(7, &full[..full.len() - 3]).is_none());
        // "." is "no such service".
        assert_eq!(
            pick(&[Srv {
                priority: 0,
                weight: 0,
                port: 1,
                target: String::new()
            }]),
            None
        );
    }

    #[test]
    fn a_pointer_loop_is_refused() {
        let mut m = vec![0u8; 12];
        m.extend_from_slice(&[0xC0, 12]);
        assert!(read_name(&m, 12).is_none());
    }
}
