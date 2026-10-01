//! The roster: every Claude Code session this machine could still be asked
//! about — what the page's Resume, Stop and Remove act on — read by the
//! session, as the user whose profile it is, on every OS.
//!
//! Three populations, kept apart because the sources disagree and which one
//! said a thing is part of the answer (the app joins them on the session
//! uuid):
//!
//! - `agents`: `claude agents --json`, the CLI's own view — authoritative
//!   for what is ALIVE, and the only source for background agents (`claude
//!   --bg`), including ones whose project directory is gone. Named field by
//!   field; an agent's `detail` and `needs` (session content, in
//!   `~/.claude/jobs/`) are never read. `agents_available` false: the CLI did
//!   not answer, and every row is disk-only.
//! - `transcripts`: the `<uuid>.jsonl` files under `~/.claude/projects/<slug>/`
//!   — authoritative for what is RESUMABLE and nothing else. A regular file
//!   in a real directory, never a link; the newest `MAX_TRANSCRIPTS` that
//!   are not empty, with `transcript_total` and `empty_count` counting the
//!   rest. Each carries derived LABELS — a title the operator typed, the
//!   sidecar's, the CLI's `ai-title` — its start time and cwd from its first
//!   8 KB, and `meta`, what one pass over the file counted (`scan`, cached by
//!   size and mtime so the steady state reads only the file being typed
//!   into). The one line of conversation that leaves the file is
//!   `meta.last_prompt`, redacted and cut (redact.rs).
//! - `managed`: the sessions this agent resumed (sessions.rs), running as
//!   jobs of their own, `claude-session-<uuid>` (job.rs) — the only live
//!   ones it can end with a stop of their own.
//!
//! Beside them: `session_stats`, per live session file whose process is
//! still the one that wrote it, its CPU, resident memory and the Remote
//! Control bridge's debug log (`os::process_stats`, on every OS);
//! `server`, the Remote Control job's own accounting where the OS keeps
//! one (a systemd unit's; null elsewhere);
//! `actions`, the last requests the verbs took — the operator's and the
//! automatic recovery's (recovery.rs) — and how each ended.
//!
//! Bounded: `MAX_TRANSCRIPTS` and `MAX_AGENTS` rows, strings cut, and the
//! whole document at most `MAX_BYTES` once serialised (`fit` drops the
//! oldest transcripts and says `truncated`), so it rides one link line.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::profile::SessionFile;
use super::redact;
use super::{ActionState, SessionAction};
use crate::jobs::UnitCost;
use crate::time::epoch_ms;

/// Transcripts listed, newest first.
pub const MAX_TRANSCRIPTS: usize = 200;
/// Agents listed.
pub const MAX_AGENTS: usize = 200;
/// Files looked at under the projects tree, at most.
pub const MAX_FILES: usize = 20_000;
/// The roster serialised, at most: well inside one link line (1 MiB).
pub const MAX_BYTES: usize = 512 * 1024;
/// A string copied from the CLI's output, at most, in characters.
const MAX_FIELD: usize = 256;
/// The head read for titles, start time and cwd.
const HEAD_BYTES: u64 = 8192;
/// The sidecar title file read.
const SIDECAR_BYTES: u64 = 4096;
/// A `last-prompt` or `cost-state` record longer than this is dropped.
const RECORD_MAX: usize = 128 * 1024;

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Roster {
    pub reported_at: String,
    /// The CLI answered `claude agents --json`.
    pub agents_available: bool,
    pub agents: Vec<Agent>,
    pub transcripts: Vec<Transcript>,
    /// Non-empty transcripts on disk, before the cap.
    pub transcript_total: usize,
    /// Opened and never spoken to: counted, not listed.
    pub empty_count: usize,
    /// Transcripts were dropped to keep the document within `MAX_BYTES`.
    pub truncated: bool,
    pub managed: Vec<Managed>,
    pub session_stats: Vec<SessionStat>,
    /// The Remote Control job's accounting, where the OS keeps one.
    pub server: Option<UnitCost>,
    /// The verbs' last requests, newest first.
    pub actions: Vec<ActionResult>,
    /// What could not be read, one line each.
    pub errors: Vec<String>,
}

/// One `claude agents --json` entry, named field by field.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Agent {
    /// The SHORT id `claude stop` / `rm` take; background agents only.
    pub id: Option<String>,
    pub session_id: Option<String>,
    /// Present while a process runs it.
    pub pid: Option<u32>,
    /// `background` or `interactive`.
    pub kind: Option<String>,
    /// A background agent's lifecycle word.
    pub state: Option<String>,
    /// An interactive session's (`busy`).
    pub status: Option<String>,
    pub name: Option<String>,
    pub cwd: Option<String>,
    /// Milliseconds since the epoch.
    pub started_at: Option<u64>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Transcript {
    pub id: String,
    /// The `~/.claude/projects/` directory name.
    pub project: String,
    pub cwd: String,
    /// False: `cwd` was un-slugged from `project`, and a dash may be wrong.
    pub cwd_exact: bool,
    pub title: Option<String>,
    /// `custom-title`, `sidecar` or `ai-title`.
    pub title_source: Option<String>,
    /// The first timestamp in the head, milliseconds since the epoch.
    pub started_at: Option<u64>,
    /// The file's mtime, milliseconds since the epoch (whole seconds).
    pub modified_at: u64,
    pub size_bytes: u64,
    /// What `scan` counted; null when the file could not be read.
    pub meta: Option<Meta>,
}

/// One pass over a transcript (`scan`).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Meta {
    /// `"type":"user"` records that are not tool results: what was typed.
    pub exchanges: u64,
    /// `"type":"assistant"` records.
    pub replies: u64,
    /// Thinking blocks (their text is not in the file; a count only).
    pub thinking: u64,
    /// Image content blocks.
    pub images: u64,
    /// Files the operator attached.
    pub attached: u64,
    /// Sidechain records; null when the CLI never wrote the key.
    pub subagents: Option<u64>,
    /// Last timestamp minus first: the span it was open across.
    pub span_ms: Option<u64>,
    pub branch: Option<String>,
    pub cli_version: Option<String>,
    /// The last prompt typed, one line, redacted, cut (redact.rs).
    pub last_prompt: Option<String>,
    /// The CLI's own totals, where it wrote a `cost-state` record.
    pub cost: Option<Cost>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Cost {
    pub usd: Option<serde_json::Number>,
    pub lines_added: Option<serde_json::Number>,
    pub lines_removed: Option<serde_json::Number>,
    pub duration_ms: Option<serde_json::Number>,
}

/// A live session's cost, joined to the report's sessions by pid.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionStat {
    pub pid: u32,
    pub cpu_ms: Option<u64>,
    pub rss_bytes: Option<u64>,
    /// The bridge's per-session debug log (`cse_…` sessions only).
    pub log_bytes: Option<u64>,
    /// Its mtime, milliseconds since the epoch: a clock the session file lacks.
    pub bridge_at: Option<u64>,
}

/// A session this agent resumed, running as a job of its own.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Managed {
    /// The session uuid.
    pub id: String,
    /// Its job's name (a unit's, a launchd label's last part, a record's).
    pub job: String,
    pub pid: Option<u32>,
    pub memory_bytes: Option<u64>,
    pub cpu_nsec: Option<u64>,
    /// Where its filtered output goes.
    pub log: String,
    pub log_bytes: Option<u64>,
}

/// How one verb request went (sessions.rs).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActionResult {
    pub request: String,
    pub action: SessionAction,
    /// The selector it was given.
    pub id: String,
    pub state: ActionState,
    /// What was done, or why not, in a sentence. Never the CLI's own output.
    pub detail: String,
    pub started_at: String,
    pub finished_at: Option<String>,
}

impl Roster {
    /// Keep the serialised document within `max` bytes: the oldest
    /// transcripts go first, and `truncated` says some did.
    pub fn fit(&mut self, max: usize) {
        let size = |r: &Roster| serde_json::to_vec(r).map(|v| v.len()).unwrap_or(usize::MAX);
        let mut total = size(self);
        if total <= max {
            return;
        }
        // "true" is a byte shorter than "false": the size stands.
        self.truncated = true;
        while total > max {
            let Some(t) = self.transcripts.pop() else {
                break;
            };
            // Its bytes and a comma.
            total = total.saturating_sub(serde_json::to_vec(&t).map(|v| v.len() + 1).unwrap_or(0));
        }
        // Past the transcripts, the agents are the only list that grows.
        while size(self) > max && self.agents.pop().is_some() {}
    }

    /// Whether it says something `prev` did not, leaving out what moves by
    /// itself — the clock, and the costs that tick with every read: what
    /// the link pushes on (link/node.rs). Field by field, nothing copied.
    pub fn moved(&self, prev: &Roster) -> bool {
        fn jobs(r: &Roster) -> Vec<(&str, &str, Option<u32>, &str)> {
            r.managed
                .iter()
                .map(|m| (m.id.as_str(), m.job.as_str(), m.pid, m.log.as_str()))
                .collect()
        }
        self.agents_available != prev.agents_available
            || self.agents != prev.agents
            || self.transcripts != prev.transcripts
            || self.transcript_total != prev.transcript_total
            || self.empty_count != prev.empty_count
            || self.truncated != prev.truncated
            || self.actions != prev.actions
            || self.errors != prev.errors
            || jobs(self) != jobs(prev)
    }
}

// ── pure helpers ──────────────────────────────────────────────────────────

pub use crate::jobs::is_uuid;

/// Eight lowercase hex digits: a background agent's short id.
pub fn is_short_id(s: &str) -> bool {
    s.len() == 8 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// How the CLI names a project directory: every character that is not a
/// letter or a digit becomes a dash (`/etc/nixos` → `-etc-nixos`).
pub fn slug(dir: &str) -> String {
    dir.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The reverse, lossily: a dash in a directory's own name comes back as a
/// separator. Only a fallback for a head that recorded no cwd.
pub fn unslug(project: &str) -> String {
    match project.strip_prefix('-') {
        Some(rest) => format!("/{}", rest.replace('-', "/")),
        None => project.to_string(),
    }
}

fn cut(s: &str) -> String {
    s.chars().take(MAX_FIELD).collect()
}

/// `claude agents --json`'s array, field by field; None when it is not an
/// array (the CLI refused, or printed something else).
pub fn parse_agents(text: &str) -> Option<Vec<Agent>> {
    let v: Value = serde_json::from_str(text.trim()).ok()?;
    let a = v.as_array()?;
    Some(
        a.iter()
            .take(MAX_AGENTS)
            .filter_map(Value::as_object)
            .map(|o| {
                let s = |k: &str| o.get(k).and_then(Value::as_str).map(cut);
                let n = |k: &str| o.get(k).and_then(Value::as_u64);
                Agent {
                    id: s("id"),
                    session_id: s("sessionId"),
                    pid: n("pid").and_then(|p| u32::try_from(p).ok()),
                    kind: s("kind"),
                    state: s("state"),
                    status: s("status"),
                    name: s("name"),
                    cwd: s("cwd"),
                    started_at: n("startedAt"),
                }
            })
            .collect(),
    )
}

// ── one transcript ────────────────────────────────────────────────────────

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
const LINE_MAX: usize = 16 << 20;

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

fn read_prefix(path: &Path, n: u64) -> Option<Vec<u8>> {
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

// ── the tree ──────────────────────────────────────────────────────────────

struct FileStat {
    id: String,
    project: String,
    size: u64,
    mtime_ms: u64,
}

fn mtime_ms(m: &std::fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() * 1000)
        .unwrap_or(0)
}

/// Every `<uuid>.jsonl` regular file in a real directory under `projects`.
fn list(projects: &Path, errors: &mut Vec<String>) -> Vec<FileStat> {
    let mut out = Vec::new();
    let Ok(dirs) = std::fs::read_dir(projects) else {
        return out;
    };
    let mut seen = 0usize;
    for d in dirs.flatten() {
        // `file_type` does not follow a link: a linked project is skipped.
        if !d.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let project = d.file_name().to_string_lossy().into_owned();
        let Ok(files) = std::fs::read_dir(d.path()) else {
            continue;
        };
        for f in files.flatten() {
            seen += 1;
            if seen > MAX_FILES {
                errors.push(format!(
                    "more than {MAX_FILES} files under the projects tree; the rest were not read"
                ));
                return out;
            }
            let name = f.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".jsonl").filter(|i| is_uuid(i)) else {
                continue;
            };
            if !f.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let Ok(m) = f.metadata() else { continue };
            out.push(FileStat {
                id: id.to_string(),
                project: project.clone(),
                size: m.len(),
                mtime_ms: mtime_ms(&m),
            });
        }
    }
    out
}

/// The transcripts, with every scan kept between calls by (size, mtime),
/// so a warm read rescans only the files that moved.
#[derive(Default)]
pub struct Scanner {
    cache: HashMap<String, (u64, u64, Meta)>,
}

/// What `Scanner::transcripts` found.
pub struct Found {
    pub transcripts: Vec<Transcript>,
    pub total: usize,
    pub empty: usize,
}

impl Scanner {
    /// The newest `MAX_TRANSCRIPTS` non-empty transcripts under `projects`.
    pub fn transcripts(&mut self, projects: &Path, errors: &mut Vec<String>) -> Found {
        let mut files = list(projects, errors);
        let empty = files.iter().filter(|f| f.size == 0).count();
        files.retain(|f| f.size > 0);
        let total = files.len();
        files.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms).then(a.id.cmp(&b.id)));
        files.truncate(MAX_TRANSCRIPTS);
        let mut keep = HashMap::new();
        let transcripts = files
            .into_iter()
            .map(|f| {
                let dir = projects.join(&f.project);
                let path = dir.join(format!("{}.jsonl", f.id));
                let meta = match self.cache.remove(&f.id) {
                    Some((size, at, m)) if size == f.size && at == f.mtime_ms => Some(m),
                    _ => std::fs::File::open(&path).ok().map(scan),
                };
                if let Some(m) = &meta {
                    keep.insert(f.id.clone(), (f.size, f.mtime_ms, m.clone()));
                }
                let mut head = Head::default();
                if let Some(p) = read_prefix(&path, HEAD_BYTES) {
                    head.note_text(&p);
                }
                let sidecar = dir.join(&f.id).join("custom-title.json");
                if regular_file(&sidecar) {
                    if let Some(p) = read_prefix(&sidecar, SIDECAR_BYTES) {
                        head.note_text(&p);
                    }
                }
                let (title, title_source) = head.title();
                Transcript {
                    cwd: head
                        .cwd
                        .as_deref()
                        .map(cut)
                        .unwrap_or_else(|| unslug(&f.project)),
                    cwd_exact: head.cwd.is_some(),
                    title,
                    title_source: title_source.map(str::to_string),
                    started_at: head.started_at.as_deref().and_then(epoch_ms),
                    modified_at: f.mtime_ms,
                    size_bytes: f.size,
                    meta,
                    id: f.id,
                    project: f.project,
                }
            })
            .collect();
        // What left the listing leaves the cache.
        self.cache = keep;
        Found {
            transcripts,
            total,
            empty,
        }
    }
}

/// The project directory holding `<id>.jsonl` as a regular file, by name
/// (resume's existential check, sessions.rs).
pub fn find_transcript(projects: &Path, id: &str) -> Option<String> {
    let dirs = std::fs::read_dir(projects).ok()?;
    for d in dirs.flatten() {
        if !d.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        if regular_file(&d.path().join(format!("{id}.jsonl"))) {
            return Some(d.file_name().to_string_lossy().into_owned());
        }
    }
    None
}

/// The live session files' costs: each file whose pid still runs the
/// process that wrote it (`procStart` against the OS's start time — a
/// recycled pid is not the session), with the bridge log beside it.
pub fn session_stats(files: &[SessionFile], bridge_dir: Option<&Path>) -> Vec<SessionStat> {
    let mut out = Vec::new();
    for f in files {
        let pid = f.pid;
        let Some(st) = crate::os::process_stats(pid) else {
            continue;
        };
        if f.proc_start
            .zip(st.start_ticks)
            .is_some_and(|(r, s)| r != s)
        {
            continue;
        }
        let remote = st.args.iter().find(|a| {
            a.starts_with("cse_") && a.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        });
        let log = remote
            .zip(bridge_dir)
            .map(|(r, d)| d.join(format!("bridge-session-{r}.log")))
            .and_then(|l| std::fs::metadata(l).ok());
        out.push(SessionStat {
            pid,
            cpu_ms: Some(st.cpu_ms),
            rss_bytes: Some(st.rss_bytes),
            log_bytes: log.as_ref().map(std::fs::Metadata::len),
            bridge_at: log.as_ref().map(mtime_ms),
        });
    }
    out.sort_by_key(|s| s.pid);
    out
}

/// A session process alive on `id` right now, from the session files
/// (resume's idempotence check): the pid runs, and — where the OS says
/// when a process started — it is still the one that wrote the file.
pub fn session_live(files: &[SessionFile], id: &str) -> bool {
    files
        .iter()
        .any(|f| f.session_id.as_deref() == Some(id) && f.alive())
}

/// Where the Remote Control bridge writes its per-session debug logs: the
/// CLI's `claude-<uid>` directory under the temporary directory, on unix.
pub fn bridge_dir() -> Option<PathBuf> {
    crate::os::own_uid().map(|uid| std::env::temp_dir().join(format!("claude-{uid}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_and_slugs() {
        assert!(is_uuid("abdda3a9-0cb2-43f1-b13e-37f25a755fce"));
        for bad in [
            "ABDDA3A9-0cb2-43f1-b13e-37f25a755fce",
            "abdda3a9-0cb2-43f1-b13e-37f25a755fc",
            "abdda3a90cb2-43f1-b13e-37f25a755fce0",
            "../../../../etc/passwd-aaaa-bbbbbbbb",
            "abdda3a9-0cb2-43f1-b13e-37f25a755fcg",
        ] {
            assert!(!is_uuid(bad), "{bad}");
        }
        assert!(is_short_id("0a1b2c3d"));
        assert!(!is_short_id("0A1B2C3D") && !is_short_id("0a1b2c3") && !is_short_id("0a1b2c3d4"));
        assert_eq!(slug("/etc/nixos"), "-etc-nixos");
        assert_eq!(slug("/home/a/.x_y/p q"), "-home-a--x-y-p-q");
        assert_eq!(unslug("-etc-nixos"), "/etc/nixos");
        assert_eq!(unslug("C--Users-a"), "C--Users-a");
    }

    #[test]
    fn a_scan_counts_what_the_snapshot_counted() {
        let lines = [
            r#"{"type":"queue-operation","content":"secret prompt","timestamp":"2026-09-27T10:00:00.100Z"}"#,
            r#"{"type":"user","message":{"content":"hi"},"isSidechain":false,"gitBranch":"","version":"2.1.281","timestamp":"2026-09-27T10:00:01Z"}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]},"timestamp":"2026-09-27T10:00:02Z"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"thinking","thinking":""}]},"gitBranch":"main"}"#,
            r#"{"type":"user","message":{"content":[{"type":"image","source":{}}]},"attachment":{"type":"file"},"timestamp":"2026-09-27T10:05:00Z"}"#,
            r#"{"type":"last-prompt","lastPrompt":"first"}"#,
            r#"{"type":"last-prompt","lastPrompt":"deploy with   ghp_abcdefghijklmnopqrstuvwx\nnow"}"#,
            r#"{"type":"cost-state","totalCostUSD":1.25,"totalLinesAdded":10,"totalLinesRemoved":2,"totalDuration":5000}"#,
            "not json at all",
        ];
        let m = scan(lines.join("\n").as_bytes());
        assert_eq!(
            m,
            Meta {
                exchanges: 2,
                replies: 1,
                thinking: 2,
                images: 1,
                attached: 1,
                subagents: Some(0),
                span_ms: Some(300_000),
                branch: Some("main".into()),
                cli_version: Some("2.1.281".into()),
                last_prompt: Some("deploy with [redacted] now".into()),
                cost: Some(Cost {
                    usd: Some(serde_json::Number::from_f64(1.25).unwrap()),
                    lines_added: Some(10.into()),
                    lines_removed: Some(2.into()),
                    duration_ms: Some(5000.into()),
                }),
            }
        );
        // No sidechain key anywhere: unknown, not zero.
        let bare = scan(&b"{\"type\":\"assistant\"}\n"[..]);
        assert_eq!(bare.subagents, None);
        assert_eq!(bare.span_ms, None);
        assert!(!serde_json::to_string(&m).unwrap().contains("secret"));
    }

    /// The scan reads records, not text: a key inside a tool's input never
    /// stands for the record's own, spacing and escapes do not matter, and
    /// a line past `LINE_MAX` is skipped without stopping the scan.
    #[test]
    fn a_scan_reads_each_record_by_its_own_keys() {
        let lines = [
            // A tool input that names a version and a branch first.
            r#"{"type": "assistant", "message": {"content": [{"type": "tool_use", "input": {"version": "9.9.9", "gitBranch": "evil", "timestamp": "2020-01-01T00:00:00Z"}}]}}"#,
            r#"{"type": "user", "message": {"content": "say \"type\":\"assistant\" here"}, "version": "2.1.283", "gitBranch": "main", "timestamp": "2026-09-27T10:00:00Z"}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"image","source":{}}]}]},"timestamp":"2026-09-27T10:01:00Z"}"#,
        ];
        let mut text = lines.join("\n");
        text.push('\n');
        // An oversized record in the middle.
        text.push_str(&format!(
            "{{\"type\":\"user\",\"x\":\"{}\"}}\n",
            "a".repeat(LINE_MAX)
        ));
        text.push_str(r#"{"type":"assistant","timestamp":"2026-09-27T10:02:00Z"}"#);
        let m = scan(text.as_bytes());
        assert_eq!(m.cli_version.as_deref(), Some("2.1.283"));
        assert_eq!(m.branch.as_deref(), Some("main"));
        assert_eq!((m.exchanges, m.replies, m.images), (1, 2, 1));
        assert_eq!(m.span_ms, Some(120_000));
    }

    #[test]
    fn the_head_ranks_titles_and_keeps_first_values() {
        let mut h = Head::default();
        h.note_text(
            br#"{"type":"ai-title","aiTitle":"model's"}
{"type":"user","cwd":"/etc/nixos","timestamp":"2026-09-27T10:00:00Z"}
{"type":"user","cwd":"/other","timestamp":"2026-09-28T10:00:00Z"}
{"type":"custom-title","customTitle":"mine"}
{"type":"user","cwd":"/cut-mid-rec"#,
        );
        assert_eq!(h.cwd.as_deref(), Some("/etc/nixos"));
        assert_eq!(h.started_at.as_deref(), Some("2026-09-27T10:00:00Z"));
        assert_eq!(h.title(), (Some("mine".into()), Some("custom-title")));
        let mut side = Head::default();
        side.note_text(br#"{"type":"ai-title","aiTitle":"model's"}"#);
        side.note_text(br#"{"customTitle":"from the sidecar"}"#);
        assert_eq!(
            side.title(),
            (Some("from the sidecar".into()), Some("sidecar"))
        );
    }

    #[test]
    fn agents_are_copied_field_by_field() {
        let a = parse_agents(
            r#"[{"id":"0a1b2c3d","sessionId":"s","kind":"background","state":"blocked","name":"n","cwd":"/x","startedAt":5,"detail":"content","needs":"a question"},
               {"pid":42,"kind":"interactive","status":"busy","sessionId":"t"}]"#,
        )
        .unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].id.as_deref(), Some("0a1b2c3d"));
        assert_eq!(a[0].pid, None);
        assert_eq!(a[1].pid, Some(42));
        let json = serde_json::to_string(&a).unwrap();
        assert!(!json.contains("content") && !json.contains("question"));
        assert_eq!(parse_agents("error: unknown command"), None);
        assert_eq!(parse_agents("{}"), None);
    }

    #[test]
    fn the_tree_lists_regular_uuid_files_in_real_directories() {
        let root = std::env::temp_dir().join(format!("daedalus-roster-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let proj = root.join("-etc-nixos");
        std::fs::create_dir_all(&proj).unwrap();
        let a = "aaaaaaaa-0000-4000-8000-000000000001";
        let b = "aaaaaaaa-0000-4000-8000-000000000002";
        std::fs::write(
            proj.join(format!("{a}.jsonl")),
            "{\"type\":\"user\",\"cwd\":\"/etc/nixos\"}\n",
        )
        .unwrap();
        std::fs::write(proj.join(format!("{b}.jsonl")), "").unwrap();
        std::fs::write(proj.join("not-a-uuid.jsonl"), "x\n").unwrap();
        #[cfg(unix)]
        {
            let c = "aaaaaaaa-0000-4000-8000-000000000003";
            std::os::unix::fs::symlink(
                proj.join(format!("{a}.jsonl")),
                proj.join(format!("{c}.jsonl")),
            )
            .unwrap();
            std::os::unix::fs::symlink(&proj, root.join("-linked")).unwrap();
        }
        let mut s = Scanner::default();
        let mut errors = Vec::new();
        let f = s.transcripts(&root, &mut errors);
        assert_eq!((f.total, f.empty), (1, 1));
        assert_eq!(f.transcripts.len(), 1);
        let t = &f.transcripts[0];
        assert_eq!(
            (t.id.as_str(), t.project.as_str(), t.cwd.as_str()),
            (a, "-etc-nixos", "/etc/nixos")
        );
        assert!(t.cwd_exact);
        assert_eq!(t.meta.as_ref().unwrap().exchanges, 1);
        assert_eq!(find_transcript(&root, a).as_deref(), Some("-etc-nixos"));
        assert_eq!(find_transcript(&root, b).as_deref(), Some("-etc-nixos"));
        #[cfg(unix)]
        assert_eq!(
            find_transcript(&root, "aaaaaaaa-0000-4000-8000-000000000003"),
            None
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_roster_fits_its_bound_by_dropping_the_oldest() {
        let mut r = Roster {
            transcripts: (0..100)
                .map(|i| Transcript {
                    id: format!("{i:036}"),
                    title: Some("t".repeat(150)),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        let full = serde_json::to_vec(&r).unwrap().len();
        r.fit(full);
        assert!(!r.truncated && r.transcripts.len() == 100);
        r.fit(full / 2);
        assert!(r.truncated);
        assert!(serde_json::to_vec(&r).unwrap().len() <= full / 2);
        assert!(r.transcripts.len() < 100 && r.transcripts[0].id == format!("{:036}", 0));
    }
}
