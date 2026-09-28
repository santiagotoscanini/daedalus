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
//!   transient user units `claude-session-<uuid>` — the only live ones it
//!   can end with a stop of their own.
//!
//! Beside them: `session_stats`, per live session file whose process is
//! still the one that wrote it, its CPU, resident memory and the Remote
//! Control bridge's debug log (Linux reads /proc; elsewhere the list is
//! empty and `errors` says so); `server`, the Remote Control unit's own
//! accounting where it runs as one; `actions`, the last requests the verbs
//! took and how each ended.
//!
//! Bounded: `MAX_TRANSCRIPTS` and `MAX_AGENTS` rows, strings cut, and the
//! whole document at most `MAX_BYTES` once serialised (`fit` drops the
//! oldest transcripts and says `truncated`), so it rides one link line.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::redact;
use super::{ActionState, SessionAction};

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
/// Session files looked at, at most.
const MAX_SESSION_FILES: usize = 400;

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
    /// Why `resume` is not offered here; null where it is.
    pub resume_unavailable: Option<String>,
    pub session_stats: Vec<SessionStat>,
    /// The Remote Control unit's accounting, where it runs as a unit.
    pub server: Option<UnitCost>,
    /// The verbs' last requests, newest first.
    pub actions: Vec<ActionResult>,
    /// What could not be read, one line each.
    pub errors: Vec<String>,
}

/// One `claude agents --json` entry, named field by field.
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

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Cost {
    pub usd: Option<serde_json::Number>,
    pub lines_added: Option<serde_json::Number>,
    pub lines_removed: Option<serde_json::Number>,
    pub duration_ms: Option<serde_json::Number>,
}

/// A live session's cost, joined to the report's sessions by pid.
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

/// A session this agent resumed, running as its own unit.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Managed {
    /// The session uuid.
    pub id: String,
    pub unit: String,
    pub pid: Option<u32>,
    pub memory_bytes: Option<u64>,
    pub cpu_nsec: Option<u64>,
    /// Where its filtered output goes.
    pub log: String,
    pub log_bytes: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UnitCost {
    pub memory_bytes: Option<u64>,
    pub cpu_nsec: Option<u64>,
}

/// How one verb request went (sessions.rs).
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
        self.truncated = true;
        total = size(self);
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

    /// The document without what moves by itself: the clock, and the costs
    /// that tick with every read — what the link compares to push on change.
    pub fn digest(&self) -> String {
        let mut r = self.clone();
        r.reported_at.clear();
        r.session_stats.clear();
        r.server = None;
        for m in &mut r.managed {
            m.cpu_nsec = None;
            m.memory_bytes = None;
            m.log_bytes = None;
        }
        serde_json::to_string(&r).unwrap_or_default()
    }
}

// ── pure helpers ──────────────────────────────────────────────────────────

/// A canonical lowercase uuid: what `--resume` takes.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => matches!(c, b'0'..=b'9' | b'a'..=b'f'),
        })
}

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

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` as milliseconds since the epoch, whole
/// seconds (the fraction is dropped, as the snapshot's `fromdateiso8601`
/// did).
pub fn epoch_ms(s: &str) -> Option<u64> {
    let s = s.strip_suffix('Z')?;
    let s = match s.find('.') {
        Some(dot) if s[dot + 1..].bytes().all(|b| b.is_ascii_digit()) && dot + 1 < s.len() => {
            &s[..dot]
        }
        Some(_) => return None,
        None => s,
    };
    let b = s.as_bytes();
    if b.len() != 19
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let n = |r: std::ops::Range<usize>| -> Option<i64> {
        let t = &s[r];
        t.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| t.parse().ok())?
    };
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days from civil (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hh * 3600 + mm * 60 + ss;
    u64::try_from(secs).ok().map(|s| s * 1000)
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

/// What `/proc/<pid>/stat` says of a process: its start time in clock
/// ticks since boot, and its user and system time in ticks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcStat {
    pub start_ticks: u64,
    pub utime: u64,
    pub stime: u64,
}

/// `/proc/<pid>/stat`: `comm` is parenthesised and may hold spaces and
/// parens, so everything through the LAST `)` goes first; the rest starts
/// at field 3 (state), which puts utime, stime and starttime at 14, 15 and
/// 22.
pub fn parse_proc_stat(text: &str) -> Option<ProcStat> {
    let rest = &text[text.rfind(')')? + 1..];
    let f: Vec<&str> = rest.split_whitespace().collect();
    Some(ProcStat {
        utime: f.get(11)?.parse().ok()?,
        stime: f.get(12)?.parse().ok()?,
        start_ticks: f.get(19)?.parse().ok()?,
    })
}

/// A process as the OS reads it (os `process_stats`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcStats {
    pub start_ticks: u64,
    pub cpu_ms: u64,
    pub rss_bytes: u64,
    /// Its command line, argument by argument.
    pub args: Vec<String>,
}

/// `systemctl --user show -p MemoryCurrent -p CPUUsageNSec`: systemd writes
/// accounting it lacks as `[not set]` or the u64 sentinel, both null here.
pub fn parse_unit_cost(text: &str) -> UnitCost {
    let get = |k: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(k)?.strip_prefix('='))
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|v| *v != u64::MAX)
    };
    UnitCost {
        memory_bytes: get("MemoryCurrent"),
        cpu_nsec: get("CPUUsageNSec"),
    }
}

/// `systemctl --user list-units --type=service --all --no-legend --plain
/// '<prefix>*.service'`: the uuids whose unit is active or activating.
pub fn parse_managed_units(text: &str, prefix: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let (unit, active) = (*f.first()?, *f.get(2)?);
            if !matches!(active, "active" | "activating") {
                return None;
            }
            let id = unit.strip_prefix(prefix)?.strip_suffix(".service")?;
            is_uuid(id).then(|| id.to_string())
        })
        .collect()
}

// ── one transcript ────────────────────────────────────────────────────────

/// Where in the line a `"key":"` string value is, and the value.
fn string_after<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let p = line.find(key)? + key.len();
    let rest = &line[p..];
    Some(&rest[..rest.find('"')?])
}

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
    cost_state: Option<String>,
}

impl Scan {
    /// One line, as the snapshot's awk pass read it: every test a plain
    /// substring search first.
    fn line(&mut self, l: &str) {
        if l.contains("\"type\":\"user\"") && !l.contains("\"type\":\"tool_result\"") {
            self.exchanges += 1;
        }
        if l.contains("\"type\":\"assistant\"") {
            self.replies += 1;
        }
        self.thinking += l.matches("{\"type\":\"thinking\"").count() as u64;
        self.images += l.matches("{\"type\":\"image\",\"source\"").count() as u64;
        self.attached += l.matches("\"attachment\":{\"type\":\"file\"").count() as u64;
        if l.contains("\"isSidechain\"") {
            self.sidechain_seen = true;
            self.subagents += l.matches("\"isSidechain\":true").count() as u64;
        }
        if let Some(ts) = string_after(l, "\"timestamp\":\"").filter(|t| !t.is_empty()) {
            if self.first_ts.is_none() {
                self.first_ts = Some(ts.to_string());
            }
            self.last_ts = Some(ts.to_string());
        }
        if self.branch.as_deref().is_none_or(str::is_empty) {
            if let Some(b) = string_after(l, "\"gitBranch\":\"") {
                self.branch = Some(b.to_string());
            }
        }
        if self.version.as_deref().is_none_or(str::is_empty) {
            if let Some(v) = string_after(l, "\"version\":\"") {
                self.version = Some(v.to_string());
            }
        }
        if l.len() <= RECORD_MAX {
            if l.contains("\"type\":\"last-prompt\"") {
                self.last_prompt = Some(l.to_string());
            }
            if l.contains("\"type\":\"cost-state\"") {
                self.cost_state = Some(l.to_string());
            }
        }
    }

    fn finish(self) -> Meta {
        let non_empty = |s: Option<String>| s.filter(|s| !s.is_empty());
        let span_ms = match (
            self.first_ts.as_deref().and_then(epoch_ms),
            self.last_ts.as_deref().and_then(epoch_ms),
        ) {
            (Some(a), Some(b)) if b >= a => Some(b - a),
            _ => None,
        };
        let last_prompt = self
            .last_prompt
            .and_then(|l| serde_json::from_str::<Value>(&l).ok())
            .and_then(|v| v.get("lastPrompt")?.as_str().and_then(redact::prompt));
        let cost = self
            .cost_state
            .and_then(|l| serde_json::from_str::<Value>(&l).ok())
            .and_then(|v| {
                let o = v.as_object()?;
                let n = |k: &str| match o.get(k) {
                    Some(Value::Number(n)) => Some(n.clone()),
                    _ => None,
                };
                Some(Cost {
                    usd: n("totalCostUSD"),
                    lines_added: n("totalLinesAdded"),
                    lines_removed: n("totalLinesRemoved"),
                    duration_ms: n("totalDuration"),
                })
            });
        Meta {
            exchanges: self.exchanges,
            replies: self.replies,
            thinking: self.thinking,
            images: self.images,
            attached: self.attached,
            subagents: self.sidechain_seen.then_some(self.subagents),
            span_ms,
            branch: non_empty(self.branch).map(|b| cut(&b)),
            cli_version: non_empty(self.version).map(|v| cut(&v)),
            last_prompt,
            cost,
        }
    }
}

/// One pass over a whole transcript: the counts, the span, the branch and
/// version, the last prompt and the cost (module doc).
pub fn scan(r: impl Read) -> Meta {
    let mut r = BufReader::with_capacity(256 * 1024, r);
    let mut s = Scan::default();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        while matches!(buf.last(), Some(b'\n' | b'\r')) {
            buf.pop();
        }
        s.line(&String::from_utf8_lossy(&buf));
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
pub fn session_stats(claude_dir: &Path, bridge_dir: Option<&Path>) -> Vec<SessionStat> {
    let Ok(entries) = std::fs::read_dir(claude_dir.join("sessions")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten().take(MAX_SESSION_FILES) {
        let p = e.path();
        if p.extension().is_none_or(|x| x != "json") || !regular_file(&p) {
            continue;
        }
        let Some(v) = std::fs::read_to_string(&p)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        else {
            continue;
        };
        let Some(pid) = v
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|p| u32::try_from(p).ok())
        else {
            continue;
        };
        let Some(st) = crate::os::process_stats(pid) else {
            continue;
        };
        let recorded = v.get("procStart").and_then(|s| match s {
            Value::String(s) => s.parse::<u64>().ok(),
            Value::Number(n) => n.as_u64(),
            _ => None,
        });
        if recorded.is_some_and(|r| r != st.start_ticks) {
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
pub fn session_live(claude_dir: &Path, id: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(claude_dir.join("sessions")) else {
        return false;
    };
    entries.flatten().any(|e| {
        let p = e.path();
        if p.extension().is_none_or(|x| x != "json") || !regular_file(&p) {
            return false;
        }
        let Some(v) = std::fs::read_to_string(&p)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        else {
            return false;
        };
        if v.get("sessionId").and_then(Value::as_str) != Some(id) {
            return false;
        }
        let Some(pid) = v
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|p| u32::try_from(p).ok())
        else {
            return false;
        };
        match crate::os::process_stats(pid) {
            Some(st) => v
                .get("procStart")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<u64>().ok())
                .is_none_or(|r| r == st.start_ticks),
            None => !crate::os::PROCESS_STATS && crate::os::pid_alive(pid),
        }
    })
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
    fn timestamps_read_as_the_snapshot_read_them() {
        assert_eq!(epoch_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            epoch_ms("2026-09-27T10:00:00.789Z"),
            Some(1_790_503_200_000)
        );
        assert_eq!(epoch_ms("2000-03-01T00:00:01Z"), Some(951_868_801_000));
        for bad in [
            "2026-09-27T10:00:00",
            "2026-09-27 10:00:00Z",
            "2026-13-01T00:00:00Z",
            "x",
            "2026-09-27T10:00:00.Z",
        ] {
            assert_eq!(epoch_ms(bad), None, "{bad}");
        }
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
    fn proc_stat_units_and_their_costs() {
        let stat = "4242 (claude (x) y) S 1 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 12 0 987654 1000 200 18446744073709551615";
        assert_eq!(
            parse_proc_stat(stat),
            Some(ProcStat {
                utime: 250,
                stime: 50,
                start_ticks: 987654
            })
        );
        assert_eq!(parse_proc_stat("4242 (x) S 1"), None);
        assert_eq!(
            parse_unit_cost("MemoryCurrent=1048576\nCPUUsageNSec=[not set]\n"),
            UnitCost {
                memory_bytes: Some(1_048_576),
                cpu_nsec: None
            }
        );
        assert_eq!(
            parse_unit_cost("MemoryCurrent=18446744073709551615\n").memory_bytes,
            None
        );
        let units = "claude-session-abdda3a9-0cb2-43f1-b13e-37f25a755fce.service loaded active running Claude\n\
                     claude-session-bbdda3a9-0cb2-43f1-b13e-37f25a755fce.service loaded failed failed Claude\n\
                     claude-session-x.service loaded active running Claude\n\
                     claude-session-cbdda3a9-0cb2-43f1-b13e-37f25a755fce.service loaded activating start Claude\n";
        assert_eq!(
            parse_managed_units(units, "claude-session-"),
            [
                "abdda3a9-0cb2-43f1-b13e-37f25a755fce",
                "cbdda3a9-0cb2-43f1-b13e-37f25a755fce"
            ]
        );
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
