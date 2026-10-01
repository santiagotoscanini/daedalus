//! The unit's side of an outcome entry (module doc, "Running a verb"):
//! `daedalus-agent outcome <done|refused> <words>`, what host/lib.sh
//! `outcome` runs. It sends journald ONE native-protocol datagram carrying
//! `OUTCOME_FIELD`, `DETAIL_FIELD` and a nonce of its own, then stays alive
//! until that entry can be read back (or `WAIT` passes).
//!
//! Staying alive is the point. journald ties a datagram to its unit — the
//! `_SYSTEMD_INVOCATION_ID` the helper vouches by — by reading the SENDER's
//! /proc entry when it processes the datagram, so a sender that has exited
//! by then lands in no unit, and the helper never sees the word. Read back
//! means processed, while the sender still ran: the entry is the unit's.

use std::io::Write;
use std::os::unix::net::UnixDatagram;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use super::{DETAIL_FIELD, OUTCOME_FIELD};

/// journald's native protocol socket.
pub const JOURNAL_SOCKET: &str = "/run/systemd/journal/socket";
/// The field the sender finds its own entry by.
pub const NONCE_FIELD: &str = "DAEDALUS_OUTCOME_NONCE";
/// The longest detail sent, in bytes; the helper cuts its progress lines
/// shorter still.
pub const MAX_DETAIL: usize = 2000;
/// How long the sender waits to read its entry back.
pub const WAIT: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(20);

/// The words as one line: line breaks become spaces, cut at `MAX_DETAIL`
/// bytes on a character boundary.
pub fn detail(words: &str) -> String {
    let mut s: String = words
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    if s.len() > MAX_DETAIL {
        let mut end = MAX_DETAIL;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

/// The datagram: every field in the protocol's binary-safe form (name,
/// newline, little-endian length, value, newline), so no value can end a
/// field early or add one.
pub fn datagram(outcome: &str, detail: &str, nonce: &str) -> Vec<u8> {
    let message = format!("outcome: {outcome}");
    let mut out = Vec::new();
    for (k, v) in [
        ("MESSAGE", message.as_str()),
        (OUTCOME_FIELD, outcome),
        (DETAIL_FIELD, detail),
        (NONCE_FIELD, nonce),
    ] {
        out.extend_from_slice(k.as_bytes());
        out.push(b'\n');
        out.extend_from_slice(&(v.len() as u64).to_le_bytes());
        out.extend_from_slice(v.as_bytes());
        out.push(b'\n');
    }
    out
}

fn nonce() -> String {
    let mut b = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Is the entry carrying `nonce` in the journal yet? `journalctl` from PATH.
fn visible(nonce: &str) -> bool {
    Command::new("journalctl")
        .args(["-q", "--no-pager", "-n", "1", "-o", "cat"])
        .arg(format!("{NONCE_FIELD}={nonce}"))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .is_ok_and(|o| o.status.success() && !o.stdout.is_empty())
}

/// `daedalus-agent outcome <done|refused> [words…]`: the words go to stdout
/// as they are (the unit's own journal and the page's progress), and the
/// entry to journald. Fails only on a wrong call; an entry that could not be
/// sent or read back leaves the helper to read the run by its last line.
pub fn main(args: &[String]) -> Result<()> {
    let outcome = match args.first().map(String::as_str) {
        Some(o @ ("done" | "refused")) => o,
        _ => bail!("usage: daedalus-agent outcome <done|refused> [words…]"),
    };
    let words = args[1..].join(" ");
    let mut out = std::io::stdout().lock();
    writeln!(out, "{words}").context("stdout")?;
    out.flush().ok();
    drop(out);

    let nonce = nonce();
    let sent = UnixDatagram::unbound()
        .and_then(|s| s.send_to(&datagram(outcome, &detail(&words), &nonce), JOURNAL_SOCKET));
    if sent.is_err() {
        return Ok(());
    }
    let deadline = Instant::now() + WAIT;
    while !visible(&nonce) && Instant::now() < deadline {
        std::thread::sleep(POLL);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse a native datagram back into its fields, as journald does.
    fn fields(mut d: &[u8]) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        while !d.is_empty() {
            let nl = d.iter().position(|&b| b == b'\n').unwrap();
            let name = String::from_utf8(d[..nl].to_vec()).unwrap();
            assert!(
                !name.contains('='),
                "every field is in the binary-safe form"
            );
            d = &d[nl + 1..];
            let len = u64::from_le_bytes(d[..8].try_into().unwrap()) as usize;
            out.push((name, d[8..8 + len].to_vec()));
            assert_eq!(d[8 + len], b'\n');
            d = &d[8 + len + 1..];
        }
        out
    }

    #[test]
    fn a_detail_cannot_add_a_field() {
        let d = datagram("refused", "busy\nDAEDALUS_OUTCOME=done", "n1");
        let f = fields(&d);
        let names: Vec<_> = f.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["MESSAGE", OUTCOME_FIELD, DETAIL_FIELD, NONCE_FIELD]);
        assert_eq!(f[1].1, b"refused");
        assert_eq!(f[2].1, b"busy\nDAEDALUS_OUTCOME=done");
        assert_eq!(f[3].1, b"n1");
    }

    #[test]
    fn the_detail_is_one_bounded_line() {
        assert_eq!(detail("a\nb\r\nc"), "a b  c");
        let long = "é".repeat(MAX_DETAIL);
        let d = detail(&long);
        assert!(d.len() <= MAX_DETAIL && d.len() >= MAX_DETAIL - 1);
        assert!(d.chars().all(|c| c == 'é'));
    }

    #[test]
    fn only_done_and_refused_are_words() {
        assert!(main(&["failed".into(), "x".into()]).is_err());
        assert!(main(&[]).is_err());
    }
}
