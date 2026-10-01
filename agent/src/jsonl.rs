//! Newline-delimited lines, read incrementally: every door of this agent
//! frames its JSON this way (rpc.rs). `LineBuf` holds what arrived and
//! scans only the bytes it has not scanned before (so a long line fed a
//! byte at a time costs its length, not its length squared) and refuses a
//! line past its maximum as soon as the buffer passes it; `LineReader`
//! feeds one from a `Read`, optionally within an absolute deadline.

use std::io::{self, Read, Write};

use serde::Serialize;

use crate::deadline::Deadline;

/// How much one read takes.
const CHUNK: usize = 16 * 1024;

/// A line past the maximum, inside the `io::Error` a read returns
/// (`too_long`, `is_too_long`).
#[derive(Debug)]
pub struct TooLong(pub usize);

impl std::fmt::Display for TooLong {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "a line is at most {} bytes", self.0)
    }
}

impl std::error::Error for TooLong {}

/// A line past `max`.
pub fn too_long(max: usize) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, TooLong(max))
}

/// Whether `e` is a line past the maximum (`too_long`).
pub fn is_too_long(e: &io::Error) -> bool {
    e.get_ref().is_some_and(|inner| inner.is::<TooLong>())
}

/// Bytes received, and the lines in them.
#[derive(Debug, Default)]
pub struct LineBuf {
    buf: Vec<u8>,
    /// How much of `buf` is known to hold no newline.
    scanned: usize,
    max: usize,
}

impl LineBuf {
    pub fn new(max: usize) -> Self {
        Self {
            buf: Vec::new(),
            scanned: 0,
            max,
        }
    }

    pub fn set_max(&mut self, max: usize) {
        self.max = max;
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// The next whole line, without its `\n` (or `\r\n`); None while it is
    /// still arriving; an error once it is past the maximum.
    pub fn take(&mut self) -> io::Result<Option<Vec<u8>>> {
        match memchr::memchr(b'\n', &self.buf[self.scanned..]) {
            Some(i) => {
                let at = self.scanned + i;
                let mut line: Vec<u8> = self.buf.drain(..=at).collect();
                self.scanned = 0;
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if line.len() > self.max {
                    return Err(too_long(self.max));
                }
                Ok(Some(line))
            }
            None => {
                self.scanned = self.buf.len();
                if self.buf.len() > self.max {
                    return Err(too_long(self.max));
                }
                Ok(None)
            }
        }
    }

    /// What arrived after the last whole line.
    pub fn rest(&self) -> &[u8] {
        &self.buf
    }

    pub fn into_rest(self) -> Vec<u8> {
        self.buf
    }
}

/// Lines from a `Read`.
pub struct LineReader<R> {
    inner: R,
    buf: LineBuf,
    ended: bool,
}

impl<R: Read> LineReader<R> {
    pub fn new(inner: R, max: usize) -> Self {
        Self {
            inner,
            buf: LineBuf::new(max),
            ended: false,
        }
    }

    pub fn get_ref(&self) -> &R {
        &self.inner
    }

    /// The next line; None at the end of the stream. An unterminated last
    /// line is still a line.
    pub fn next_line(&mut self) -> io::Result<Option<Vec<u8>>> {
        self.next_with(|_| Ok(()))
    }

    /// The same, all of it before `deadline`: `set_timeout` is handed what
    /// is left before each read (a socket's read timeout), and the deadline
    /// passing is a `TimedOut` error however the bytes trickle in.
    pub fn next_line_by(
        &mut self,
        deadline: Deadline,
        set_timeout: impl Fn(&R, std::time::Duration) -> io::Result<()>,
    ) -> io::Result<Option<Vec<u8>>> {
        self.next_with(|r| {
            if deadline.passed() {
                return Err(io::ErrorKind::TimedOut.into());
            }
            set_timeout(r, deadline.timeout(deadline.remaining()))
        })
    }

    fn next_with(
        &mut self,
        before_read: impl Fn(&R) -> io::Result<()>,
    ) -> io::Result<Option<Vec<u8>>> {
        let mut chunk = [0u8; CHUNK];
        loop {
            if let Some(line) = self.buf.take()? {
                return Ok(Some(line));
            }
            if self.ended {
                return Ok(None);
            }
            before_read(&self.inner)?;
            match self.inner.read(&mut chunk) {
                Ok(0) => {
                    self.ended = true;
                    if self.buf.rest().is_empty() {
                        return Ok(None);
                    }
                    self.buf.push(b"\n");
                }
                Ok(n) => self.buf.push(&chunk[..n]),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock) => {
                    return Err(io::ErrorKind::TimedOut.into())
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// What was read past the last line, and the reader.
    pub fn into_parts(self) -> (Vec<u8>, R) {
        (self.buf.into_rest(), self.inner)
    }
}

/// `v` as one line, newline included, written and flushed.
pub fn write_line<W: Write + ?Sized, T: Serialize>(w: &mut W, v: &T) -> io::Result<()> {
    let mut line = serde_json::to_vec(v).map_err(io::Error::other)?;
    line.push(b'\n');
    w.write_all(&line)?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn lines_come_whole_and_a_long_one_is_refused_early() {
        let mut b = LineBuf::new(8);
        b.push(b"ab");
        assert_eq!(b.take().unwrap(), None);
        b.push(b"c\r\nde\nf");
        assert_eq!(b.take().unwrap().unwrap(), b"abc");
        assert_eq!(b.take().unwrap().unwrap(), b"de");
        assert_eq!(b.take().unwrap(), None);
        assert_eq!(b.rest(), b"f");
        // Past the maximum without a newline: refused before it ends.
        let mut long = LineBuf::new(8);
        long.push(b"123456789");
        assert!(is_too_long(&long.take().unwrap_err()));
        // Told by its type, not by words another error could carry.
        assert!(!is_too_long(&io::Error::new(
            io::ErrorKind::InvalidData,
            "a line is at most 8 bytes"
        )));
        // A whole line past it too.
        let mut whole = LineBuf::new(3);
        whole.push(b"1234\n");
        assert!(whole.take().is_err());
    }

    /// A byte at a time: each byte is scanned once, so a line at the
    /// maximum costs its length. (The old reader rescanned from the start:
    /// a megabyte fed in single bytes took about 5 * 10^11 comparisons.)
    #[test]
    fn a_trickled_line_is_scanned_once() {
        let max = 1 << 20;
        let mut b = LineBuf::new(max);
        let t = Instant::now();
        for _ in 0..max {
            b.push(b"x");
            assert_eq!(b.take().unwrap(), None);
        }
        b.push(b"\n");
        assert_eq!(b.take().unwrap().unwrap().len(), max);
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    }

    #[test]
    fn a_reader_yields_lines_then_the_end() {
        let mut r = LineReader::new(&b"one\ntwo\nthree"[..], 16);
        assert_eq!(r.next_line().unwrap().unwrap(), b"one");
        assert_eq!(r.next_line().unwrap().unwrap(), b"two");
        assert_eq!(r.next_line().unwrap().unwrap(), b"three");
        assert_eq!(r.next_line().unwrap(), None);
        let mut rest = LineReader::new(&b"a\nbc"[..], 16);
        rest.next_line().unwrap();
        let (left, _) = rest.into_parts();
        assert_eq!(left, b"bc");
    }

    /// A peer that sends a byte just inside every read timeout is still cut
    /// off at the deadline.
    #[cfg(unix)]
    #[test]
    fn a_trickling_peer_is_cut_off_at_the_deadline() {
        use std::io::Write as _;
        use std::os::unix::net::UnixStream;
        let (a, mut b) = UnixStream::pair().unwrap();
        let writer = std::thread::spawn(move || {
            for _ in 0..40 {
                if b.write_all(b"x").is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let mut r = LineReader::new(a, 1 << 20);
        let t = Instant::now();
        let e = r
            .next_line_by(Deadline::after(Duration::from_millis(300)), |s, d| {
                s.set_read_timeout(Some(d))
            })
            .unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::TimedOut);
        assert!(
            t.elapsed() < Duration::from_millis(900),
            "{:?}",
            t.elapsed()
        );
        drop(r);
        writer.join().unwrap();
    }

    #[test]
    fn a_value_is_one_line() {
        let mut out = Vec::new();
        write_line(&mut out, &serde_json::json!({"id": 1})).unwrap();
        assert_eq!(out, b"{\"id\":1}\n");
    }
}
