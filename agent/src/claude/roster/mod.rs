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
//! - `managed`: the sessions this agent resumed (sessions/), running as
//!   jobs of their own, `claude-session-<uuid>` (jobs/) — the only live
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

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ActionState, SessionAction};
use crate::jobs::UnitCost;

mod live;
mod transcript;
mod tree;

pub use live::{bridge_dir, session_live, session_stats};
pub use transcript::{regular_file, scan, Head};
pub use tree::{find_transcript, Found, Scanner};

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

/// How one verb request went (sessions/).
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

#[cfg(test)]
mod tests;
