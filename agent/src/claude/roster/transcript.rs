//! One transcript: what one pass over it counts (`scan`), and what its
//! first bytes and its sidecar title say (`Head`).

use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use super::{cut, Cost, Meta, RECORD_MAX};
use crate::claude::redact;
use crate::time::epoch_ms;

/// One transcript record, the fields the scan counts, by name: everything
/// else in it — the conversation, tool inputs and outputs — is skipped
/// unread (serde's ignored fields), and a value is never taken from a
/// nested object that happens to use the same key.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Record {
    #[serde(rename = "type")]
    kind: Option<String>,
    message: Option<Message>,
    attachment: Option<Typed>,
    is_sidechain: Option<bool>,
    timestamp: Option<String>,
    git_branch: Option<String>,
    version: Option<String>,
    last_prompt: Option<String>,
    #[serde(rename = "totalCostUSD")]
    total_cost_usd: Option<serde_json::Number>,
    total_lines_added: Option<serde_json::Number>,
    total_lines_removed: Option<serde_json::Number>,
    total_duration: Option<serde_json::Number>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Message {
    /// The content blocks' types; a plain-text content is none.
    #[serde(deserialize_with = "blocks")]
    content: Vec<Typed>,
}

/// An object by its `type`, and — a tool result's — the blocks inside it.
#[derive(Default, Deserialize)]
#[serde(default)]
struct Typed {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(deserialize_with = "blocks")]
    content: Vec<Typed>,
}

impl Typed {
    fn is(&self, kind: &str) -> bool {
        self.kind.as_deref() == Some(kind)
    }
}

/// A message's content: an array of blocks, or a string (no blocks).
fn blocks<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Typed>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Content {
        Blocks(Vec<Typed>),
        Other(serde::de::IgnoredAny),
    }
    Ok(match Content::deserialize(d)? {
        Content::Blocks(b) => b,
        Content::Other(_) => Vec::new(),
    })
}

/// A transcript line longer than this is skipped unread: one record past
/// it is a pasted blob, and the scan never holds more than one line.
pub(super) const LINE_MAX: usize = 16 << 20;

#[derive(Default)]
struct Scan {
    exchanges: u64,
    replies: u64,
    thinking: u64,
    images: u64,
    attached: u64,
    subagents: u64,
    sidechain_seen: bool,
    first_ts: Option<String>,
    last_ts: Option<String>,
    branch: Option<String>,
    version: Option<String>,
    last_prompt: Option<String>,
    cost: Option<Cost>,
}

impl Scan {
    /// One record: what it is, what its content blocks are, and the clocks
    /// and labels it carries at its top level.
    fn record(&mut self, r: Record, len: usize) {
        let blocks = r.message.map(|m| m.content).unwrap_or_default();
        let count = |bs: &[Typed], kind: &str| bs.iter().filter(|b| b.is(kind)).count() as u64;
        match r.kind.as_deref() {
            // What was typed: a user record that is not a tool's result.
            Some("user") if !blocks.iter().any(|b| b.is("tool_result")) => self.exchanges += 1,
            Some("assistant") => self.replies += 1,
            Some("last-prompt") if len <= RECORD_MAX => {
                self.last_prompt = r.last_prompt.clone();
            }
            Some("cost-state") if len <= RECORD_MAX => {
                self.cost = Some(Cost {
                    usd: r.total_cost_usd.clone(),
                    lines_added: r.total_lines_added.clone(),
                    lines_removed: r.total_lines_removed.clone(),
                    duration_ms: r.total_duration.clone(),
                });
            }
            _ => {}
        }
        self.thinking += count(&blocks, "thinking");
        // Images in the message, and in the tool results it carries.
        self.images += count(&blocks, "image")
            + blocks
                .iter()
                .map(|b| count(&b.content, "image"))
                .sum::<u64>();
        if r.attachment.is_some_and(|a| a.is("file")) {
            self.attached += 1;
        }
        if let Some(side) = r.is_sidechain {
            self.sidechain_seen = true;
            self.subagents += u64::from(side);
        }
        if let Some(ts) = r.timestamp.filter(|t| !t.is_empty()) {
            if self.first_ts.is_none() {
                self.first_ts = Some(ts.clone());
            }
            self.last_ts = Some(ts);
        }
        if self.branch.is_none() {
            self.branch = r.git_branch.filter(|b| !b.is_empty());
        }
        if self.version.is_none() {
            self.version = r.version.filter(|v| !v.is_empty());
        }
    }

    fn finish(self) -> Meta {
        let span_ms = match (
            self.first_ts.as_deref().and_then(epoch_ms),
            self.last_ts.as_deref().and_then(epoch_ms),
        ) {
            (Some(a), Some(b)) if b >= a => Some(b - a),
            _ => None,
        };
        Meta {
            exchanges: self.exchanges,
            replies: self.replies,
            thinking: self.thinking,
            images: self.images,
            attached: self.attached,
            subagents: self.sidechain_seen.then_some(self.subagents),
            span_ms,
            branch: self.branch.map(|b| cut(&b)),
            cli_version: self.version.map(|v| cut(&v)),
            last_prompt: self.last_prompt.as_deref().and_then(redact::prompt),
            cost: self.cost,
        }
    }
}

/// One pass over a whole transcript: the counts, the span, the branch and
/// version, the last prompt and the cost (module doc). Each line is one
/// JSON record; one that does not parse counts for nothing.
pub fn scan(r: impl Read) -> Meta {
    let mut r = BufReader::with_capacity(256 * 1024, r);
    let mut s = Scan::default();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r
            .by_ref()
            .take(LINE_MAX as u64 + 1)
            .read_until(b'\n', &mut buf)
        {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if buf.len() > LINE_MAX {
            // The rest of an oversized line, unread.
            if r.skip_until(b'\n').is_err() {
                break;
            }
            continue;
        }
        if let Ok(rec) = serde_json::from_slice::<Record>(&buf) {
            s.record(rec, buf.len());
        }
    }
    s.finish()
}

/// What a transcript's first bytes and its sidecar title say.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Head {
    pub ai: Option<String>,
    pub custom: Option<String>,
    pub sidecar: Option<String>,
    pub started_at: Option<String>,
    pub cwd: Option<String>,
}

impl Head {
    /// One record: each slot keeps the FIRST value it is offered.
    pub fn note(&mut self, r: &Value) {
        let s = |k: &str| r.get(k).and_then(Value::as_str);
        let ty = r.get("type");
        match ty.and_then(Value::as_str) {
            Some("ai-title") => {
                if let (None, Some(t)) = (&self.ai, s("aiTitle")) {
                    self.ai = Some(t.to_string());
                }
            }
            Some("custom-title") => {
                if let (None, Some(t)) = (&self.custom, s("customTitle")) {
                    self.custom = Some(t.to_string());
                }
            }
            _ => {}
        }
        if ty.is_none_or(Value::is_null) {
            if let (None, Some(t)) = (&self.sidecar, s("customTitle")) {
                self.sidecar = Some(t.to_string());
            }
        }
        if let (None, Some(t)) = (&self.started_at, s("timestamp")) {
            self.started_at = Some(t.to_string());
        }
        if let (None, Some(c)) = (&self.cwd, s("cwd")) {
            self.cwd = Some(c.to_string());
        }
    }

    /// Lines of a prefix: the last one, cut mid-record, is not JSON and
    /// drops out.
    pub fn note_text(&mut self, text: &[u8]) {
        for line in text.split(|b| *b == b'\n') {
            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                if v.is_object() {
                    self.note(&v);
                }
            }
        }
    }

    /// The title a person reads first: one the operator typed, the
    /// sidecar's, the model's.
    pub fn title(&self) -> (Option<String>, Option<&'static str>) {
        if let Some(t) = &self.custom {
            (Some(redact::clamp(t)), Some("custom-title"))
        } else if let Some(t) = &self.sidecar {
            (Some(redact::clamp(t)), Some("sidecar"))
        } else if let Some(t) = &self.ai {
            (Some(redact::clamp(t)), Some("ai-title"))
        } else {
            (None, None)
        }
    }
}

pub(super) fn read_prefix(path: &Path, n: u64) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(n)
        .read_to_end(&mut buf)
        .ok()?;
    Some(buf)
}

/// A regular file at `path`, not a link to one.
pub fn regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
}
