//! The hook queue: pushed on the local hook socket, delivered to the newest
//! `hooks.subscribe`r.

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

use santree_remote_proto::*;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

use super::conn::{Conn, Out};
use super::*;
use crate::framing::read_line;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) struct HookQueue {
    pub(super) cap: usize,
    /// The queue's budget in bytes ([`hook_size`]), besides its count: one
    /// push can carry a 32 MiB stdin, and nobody may be subscribed for days.
    pub(super) max_bytes: usize,
    pub(super) bytes: usize,
    pub(super) last_seq: u64,
    pub(super) items: VecDeque<HookEvent>,
    /// Overflow not yet reported to a subscriber.
    pub(super) dropped: u64,
    pub(super) subscriber: Option<(u64, Out)>,
}

impl HookQueue {
    fn notify(&mut self, line: String) {
        if let Some((_, out)) = &self.subscriber {
            if !out.send(line) {
                self.subscriber = None;
            }
        }
    }

    fn report_dropped(&mut self) {
        if self.dropped > 0 && self.subscriber.is_some() {
            let count = std::mem::take(&mut self.dropped);
            self.notify(Event::HooksDropped(HooksDropped { count }).encode());
        }
    }

    pub(super) fn push(
        &mut self,
        event: String,
        env: Vec<(String, String)>,
        stdin: Vec<u8>,
    ) -> u64 {
        self.last_seq += 1;
        let hook = HookEvent {
            seq: self.last_seq,
            at: now_ms(),
            event,
            env,
            stdin,
        };
        let size = hook_size(&hook);
        // The oldest go first, counted as dropped, until the new one fits
        // (one larger than the whole budget is still kept, alone).
        while !self.items.is_empty()
            && (self.items.len() >= self.cap.max(1) || self.bytes + size > self.max_bytes)
        {
            if let Some(old) = self.items.pop_front() {
                self.bytes -= hook_size(&old);
            }
            self.dropped += 1;
        }
        self.report_dropped();
        self.bytes += size;
        self.items.push_back(hook.clone());
        self.notify(Event::Hook(hook).encode());
        self.last_seq
    }

    /// `hooks.ack`: drop everything up to `up_to`.
    pub(super) fn ack(&mut self, up_to: u64) {
        self.items.retain(|h| h.seq > up_to);
        self.bytes = self.items.iter().map(hook_size).sum();
    }
}

/// What one queued hook costs, roughly its size in memory.
fn hook_size(h: &HookEvent) -> usize {
    64 + h.event.len() + h.stdin.len() + h.env.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>()
}

impl Daemon {
    /// Queue one hook (the local hook socket's only method).
    fn push_hook(&self, p: HookPushParams) -> u64 {
        let seq = lock(&self.hooks).push(p.event, p.env, p.stdin);
        self.touch();
        seq
    }

    /// `hooks.subscribe`: the response, the dropped report, the backlog
    /// after `after`, then live events. The backlog is cloned
    /// [`BACKLOG_CHUNK`] events at a time under the queue's lock and encoded
    /// outside it; `conn` becomes the subscriber under the lock that finds
    /// nothing more to send, so no event is missed, repeated or reordered.
    pub(super) fn subscribe_hooks(&self, conn: &Conn, req_id: u64, mut after: Option<u64>) {
        if !conn
            .out
            .send(encode_ok(req_id, &Empty).expect("empty serializes"))
        {
            return;
        }
        loop {
            let (dropped, chunk) = {
                let mut hooks = lock(&self.hooks);
                let start = hooks
                    .items
                    .partition_point(|h| after.is_some_and(|after| h.seq <= after));
                let chunk: Vec<HookEvent> = hooks
                    .items
                    .range(start..)
                    .take(BACKLOG_CHUNK)
                    .cloned()
                    .collect();
                if chunk.is_empty() {
                    hooks.subscriber = Some((conn.id, conn.out.clone()));
                    hooks.report_dropped();
                    return;
                }
                (std::mem::take(&mut hooks.dropped), chunk)
            };
            if dropped > 0
                && !conn
                    .out
                    .send(Event::HooksDropped(HooksDropped { count: dropped }).encode())
            {
                return;
            }
            for hook in chunk {
                after = Some(hook.seq);
                if !conn.out.send(Event::Hook(hook).encode()) {
                    return;
                }
            }
        }
    }
}

// ── the local hook socket ─────────────────────────────────────────────────

/// Serve one connection to the hook socket: `hooks.push` and nothing else,
/// no `hello` (the hook command has ~200 ms in all). The caller checked the
/// peer is this process's uid. The framing is frozen with protocol v1: the
/// `hook` command on PATH is always the newest build, and the running host
/// may be older.
pub async fn serve_hook_conn<S>(daemon: Arc<Daemon>, stream: S)
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    while read_line(&mut reader, &mut line, MAX_REQUEST_LINE)
        .await
        .is_ok()
    {
        if line.is_empty() {
            continue;
        }
        let Ok(request) = std::str::from_utf8(&line)
            .map_err(|e| e.to_string())
            .and_then(|text| decode_request(text).map_err(|e| e.to_string()))
        else {
            log::warn!("hook socket: undecodable request");
            continue;
        };
        let answer = if request.m == m::HooksPush::NAME {
            match request.params::<HookPushParams>() {
                Ok(p) => {
                    let seq = daemon.push_hook(p);
                    encode_ok(request.id, &HookPushResult { seq }).expect("serializes")
                }
                Err(e) => encode_err(request.id, &e),
            }
        } else {
            encode_err(
                request.id,
                &err(
                    ErrorCode::BadRequest,
                    format!("the hook socket serves hooks.push only, not {}", request.m),
                ),
            )
        };
        let mut answer = answer.into_bytes();
        answer.push(b'\n');
        if writer.write_all(&answer).await.is_err() {
            break;
        }
    }
}
