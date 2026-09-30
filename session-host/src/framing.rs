//! Newline framing for the host's side of a connection.
//!
//! Copied from santree's `crates/remote/src/framing.rs` at rev
//! c9766c4539973e7959287d9fc65dff01c585c575, where `read_line` is
//! `pub(crate)` and so cannot be imported. The host never passes an idle
//! bound (the client times a silent link out, and TCP keepalive catches a
//! vanished peer, serve.rs), so that parameter and its branch are dropped;
//! the rest is unchanged.

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// Why a link stopped yielding frames.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadEnd {
    /// Clean EOF at a frame boundary.
    Closed,
    /// Anything else, as a short human reason.
    Failed(String),
}

/// Read one line into `buf` (without its `\n` or a trailing `\r`).
///
/// A line longer than `max` ends the link rather than growing without bound:
/// a peer that never sends a newline must not be able to exhaust memory.
pub async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
) -> Result<(), ReadEnd> {
    buf.clear();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|e| ReadEnd::Failed(format!("read failed: {e}")))?;

        if available.is_empty() {
            return Err(if buf.is_empty() {
                ReadEnd::Closed
            } else {
                ReadEnd::Failed("connection closed mid-message".into())
            });
        }
        let (take, done) = match available.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (available.len(), false),
        };
        // `max` counts the line's content; the newline itself is free.
        if buf.len() + take - usize::from(done) > max {
            return Err(ReadEnd::Failed(format!("message over {max} bytes")));
        }
        buf.extend_from_slice(&available[..take]);
        reader.consume(take);
        if done {
            buf.pop();
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(());
        }
    }
}
