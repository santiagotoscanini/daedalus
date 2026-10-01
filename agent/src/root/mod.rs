//! The root helper: how the controller, which runs as the operator, asks the
//! box for the few things only root may do (PLAN feature 13, "Root behind a
//! socket-activated helper").
//!
//! **Shape.** systemd owns a socket (`daedalus-root.socket`, `Accept=yes`,
//! the operator's and 0600) and starts a FRESH, sandboxed root process per
//! connection (`daedalus-root@.service`): `daedalus-agent root-helper
//! --table <file>`, the connection on its stdin. There is no resident root
//! daemon. The process checks the peer (`SO_PEERCRED`: the table's
//! `allow_uid`, the operator, and nobody else — root included), reads ONE
//! request line, answers, and exits. Only the controller connects: the app
//! reaches it through the controller's `root.run` (api/), never directly —
//! one door.
//!
//! **The table** (`Table`) is rendered by nix from the running
//! configuration and checked twice: at evaluation (the controller module's
//! assertions) and here at start (`Table::check`). Each verb names an
//! EXISTING oneshot unit and a selector schema — each selector a fixed list
//! of values, spliced into the unit name as `{name}` (a template instance).
//! Nothing from the caller ever becomes a path, a flag or a free unit name:
//! a verb is a table key, a selector value one of its list.
//!
//! **The run file.** A value that cannot be listed — a repository slug, a
//! variable name — is a PATTERN selector: a regex nix declared (anchored,
//! from a small character set, with a length cap), checked at evaluation and
//! again here. Such a value never goes into a unit name: escaping one
//! (`systemd-escape`) would make `-` four characters and `/` a `-`, push a
//! 200-character slug past systemd's 256-character name limit, and leave the
//! unit to unescape `%I` and trust it. Instead a verb with a pattern, or one
//! that carries a payload (a sealed secret), names a template, `x@.service`,
//! and the helper starts `x@<run id>.service` after writing the request's
//! selectors and payload to `<run_dir>/<run id>.json` — root's, 0600,
//! created exclusively (`O_EXCL`) without following a link (`O_NOFOLLOW`),
//! in a directory that must be root's and 0700. The unit reads that file and
//! deletes it; the helper deletes what is left when the start job ends. The
//! value is on no command line and in no unit name; the helper logs neither
//! it nor the payload. One such run at a time: any instance of the template
//! still running refuses the next.
//!
//! **Running a verb** is `systemctl start <unit>`: the work is the unit's,
//! so it survives a switch restarting its caller, this helper or the
//! controller. Once the start is asked for, the helper says `started`;
//! while the unit runs, its own journal lines stream back as progress; when
//! the start job ends, `systemctl start`'s own exit says how: `failed` when
//! the job failed, else what the unit's OUTCOME ENTRY says — `refused` (the
//! unit exits 0, so a refusal is not a failed unit) or `done` — and `done`
//! with its last line when it wrote none. The outcome entry is one journal
//! entry carrying `OUTCOME_FIELD` (`done` or `refused`) and `DETAIL_FIELD`,
//! written by host/lib.sh `outcome` and taken only when journald's own
//! fields vouch for it (helper.rs `vouched`: the unit run's
//! `_SYSTEMD_INVOCATION_ID`, a root or operator `_UID`), never by its text:
//! a line a unit prints, or an entry another process journals, cannot pass
//! for a refusal. The journal, not the exit status,
//! carries the outcome because systemd forgets a oneshot's exit status once
//! it is inactive (measured: `ExecMainStatus=0` after an exit 3 listed in
//! `SuccessExitStatus`). A unit already running is `refused`, never joined:
//! systemd would merge a second start into the first one's job, and both
//! callers would read its end as their own. So every verb holds a lock,
//! `<run_dir>/<unit>.lock` (`.service` dropped; a run-file verb's is its
//! template's, `x@.lock`), from before its busy check until its answer: a
//! second request while it is held is refused, never queued, and two
//! helpers (one per connection) cannot both find the unit idle and both
//! start it. `status` is built in and read-only: every verb, its unit and
//! that unit's state (a template's: whether an instance runs).
//!
//! **Framing.** One JSON object per line. In: `Request`, at most
//! `MAX_REQUEST` bytes, within `REQUEST_DEADLINE`. Out: `Line` — `started`
//! once the start is asked for, any number of `progress`, then exactly one
//! `result` or `error` (a refusal before the start has no `started`).
//!
//! ```text
//! → {"verb":"reboot","id":"5f0c9d2e7a1b3c4d","selectors":{}}
//! ← {"t":"started","unit":"daedalus-power.service"}
//! ← {"t":"progress","line":"rebooting"}
//! ← {"t":"result","outcome":"done","detail":"rebooting"}
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::time::Duration;

use regex_automata::meta::Regex;
use serde::{Deserialize, Serialize};

use crate::deadline::Deadline;
use crate::jsonl::LineReader;

pub mod relay;
pub mod runs;

#[cfg(target_os = "linux")]
pub mod helper;

/// The longest request line read: the largest payload, JSON-escaped, and
/// room for the rest.
pub const MAX_REQUEST: usize = 2 * MAX_PAYLOAD + 64 * 1024;
/// The largest payload any verb may declare (`payload_max`): an Apply's
/// rendered files are the largest, about 40 KiB on the reference box.
pub const MAX_PAYLOAD: usize = 256 * 1024;
/// The longest value a pattern selector may declare (`max_len`).
pub const MAX_PATTERN_LEN: usize = 256;
/// What a pattern's regex may be written with: anchors, classes, counts,
/// groups and a few literals — no backslash, so what a pattern accepts reads
/// off it, with no escape class (`\w`, `\s`, `\p{…}`) reaching past ASCII.
pub const PATTERN_CHARS: &str = "^$[]{}(),|*+?._@ /:-";
/// The longest answer line either side accepts (a `status` is the largest).
pub const MAX_ANSWER: usize = 1 << 20;
/// A progress line is cut to this many characters.
pub const MAX_PROGRESS: usize = 2048;
/// How long a connection has to send its request.
pub const REQUEST_DEADLINE: Duration = Duration::from_secs(10);
/// The outcome entry's fields (module doc): `done` or `refused`, and the words.
pub const OUTCOME_FIELD: &str = "DAEDALUS_OUTCOME";
pub const DETAIL_FIELD: &str = "DAEDALUS_DETAIL";
/// The built-in read-only verb; no table entry may take its name.
pub const STATUS_VERB: &str = "status";
/// The longest `timeout_secs` a verb may carry: a day.
pub const MAX_TIMEOUT_SECS: u64 = 86_400;

/// What nix renders: who may ask, the two tools, and the verbs.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Table {
    /// The one uid served (the operator's; the controller runs as it).
    pub allow_uid: u32,
    /// Absolute paths, fixed by nix.
    pub systemctl: String,
    pub journalctl: String,
    /// Where run files and every verb's lock go (module doc): root's, 0700.
    pub run_dir: String,
    pub verbs: BTreeMap<String, VerbSpec>,
}

/// One verb: the unit it starts and what it may be told.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerbSpec {
    /// A `.service` name; `{selector}` marks where a selector's value goes.
    /// A verb with a run file names a template, `x@.service`, instead.
    pub unit: String,
    pub description: String,
    /// How long the helper waits for the start job before it reports
    /// `failed` (the unit goes on; its own TimeoutStartSec is the real one).
    pub timeout_secs: u64,
    /// Selector → the values it may take.
    #[serde(default)]
    pub selectors: BTreeMap<String, Vec<String>>,
    /// Pattern selector → the shape its value must have.
    #[serde(default)]
    pub patterns: BTreeMap<String, PatternSpec>,
    /// The largest payload this verb takes, in bytes; none when absent.
    #[serde(default)]
    pub payload_max: Option<usize>,
}

/// A pattern selector: an anchored regex over `PATTERN_CHARS`, and a cap.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatternSpec {
    pub regex: String,
    pub max_len: usize,
}

impl VerbSpec {
    /// Whether this verb's values travel in a run file (module doc).
    pub fn run_file(&self) -> bool {
        !self.patterns.is_empty() || self.payload_max.is_some()
    }
}

/// One request.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub verb: String,
    /// The caller's run id, for the logs on both sides.
    pub id: String,
    #[serde(default)]
    pub selectors: BTreeMap<String, String>,
    /// For a verb that takes one: bytes the unit reads from its run file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
}

/// Never the payload, whatever prints a request.
impl std::fmt::Debug for Request {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Request")
            .field("verb", &self.verb)
            .field("id", &self.id)
            .field("selectors", &self.selectors)
            .field(
                "payload",
                &self
                    .payload
                    .as_ref()
                    .map(|p| format!("<{} bytes>", p.len())),
            )
            .finish()
    }
}

/// How a verb ended.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "RootOutcome"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    /// The unit ran and exited 0.
    Done,
    /// The unit (or the helper: already running) declined; `detail` says why.
    Refused,
    /// The unit failed, or gave no result in time.
    Failed,
}

/// One verb as `status` states it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "RootVerb"))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerbState {
    pub verb: String,
    pub unit: String,
    pub description: String,
    pub selectors: BTreeMap<String, Vec<String>>,
    /// Pattern selector → its regex.
    pub patterns: BTreeMap<String, String>,
    /// The largest payload it takes, if it takes one.
    pub payload_max: Option<usize>,
    /// The unit's `ActiveState` — a template's is `activating` while an
    /// instance runs, else `inactive`; null when systemd could not be asked
    /// or the unit has a selector in its name.
    pub active_state: Option<String>,
    /// Its `Result` from the last run.
    pub result: Option<String>,
}

/// One line the helper writes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Line {
    /// The start was asked for: from here the unit's, whatever happens to
    /// this connection.
    Started {
        unit: String,
    },
    Progress {
        line: String,
    },
    Result {
        outcome: Outcome,
        detail: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        verbs: Option<Vec<VerbState>>,
    },
    Error {
        code: String,
        msg: String,
    },
}

/// The helper's error codes.
pub mod code {
    pub const BAD_REQUEST: &str = "bad_request";
    pub const UNKNOWN_VERB: &str = "unknown_verb";
    pub const FORBIDDEN: &str = "forbidden";
    pub const INTERNAL: &str = "internal";
}

/// What a checked request asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolved {
    Status,
    Run {
        verb: String,
        unit: String,
        timeout: Duration,
        /// The lock this run holds until its answer (module doc).
        lock: std::path::PathBuf,
        /// For a run-file verb: the file to write before the start, and the
        /// template whose running instances refuse this run.
        run_file: Option<RunFile>,
    },
}

/// A run file, resolved: where it goes and what it holds.
#[derive(Clone, PartialEq, Eq)]
pub struct RunFile {
    pub path: std::path::PathBuf,
    pub body: Vec<u8>,
    /// `x@`, the template every instance of this verb is.
    pub template: String,
}

/// Its body holds a payload; only the path and the size print.
impl std::fmt::Debug for RunFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunFile")
            .field("path", &self.path)
            .field("body", &format!("<{} bytes>", self.body.len()))
            .field("template", &self.template)
            .finish()
    }
}

/// A refusal before anything ran: a code and words.
pub type Refusal = (&'static str, String);

/// The one peer check: the kernel's word for the peer's uid is `allowed`.
/// Unreadable credentials are no credentials.
pub fn peer_allowed(peer_uid: Option<u32>, allowed: u32) -> bool {
    peer_uid == Some(allowed)
}

/// A verb's or a selector's name: `[a-z][a-z0-9-]{0,31}`.
pub fn valid_name(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=32).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A selector's value: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` — no `/`, no
/// leading `-` or `.`, nothing a unit name or a command line reads twice.
pub fn valid_value(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=64).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// What any pattern selector's value is before its regex is asked: 1 to
/// `max` bytes of printable ASCII (space included, no control character),
/// not starting with `-`. The floor under every pattern, so no regex can let
/// a newline or a flag through.
pub fn valid_free_value(s: &str, max: usize) -> bool {
    let b = s.as_bytes();
    (1..=max.min(MAX_PATTERN_LEN)).contains(&b.len())
        && b[0] != b'-'
        && b.iter().all(|c| (0x20..0x7f).contains(c))
}

/// A pattern as nix declares it, or why not: anchored at both ends, written
/// with `PATTERN_CHARS` and ASCII alphanumerics only, a cap of 1 to
/// `MAX_PATTERN_LEN`, and a regex that compiles. What it compiles to matches
/// a value whole: the regex is wrapped as `^(?:…)$`, so an alternation
/// (`^[a-z]+|x$`) cannot leave one branch unanchored.
pub fn check_pattern(p: &PatternSpec) -> Result<Regex, String> {
    if !(1..=MAX_PATTERN_LEN).contains(&p.max_len) {
        return Err(format!("max_len is 1 to {MAX_PATTERN_LEN}"));
    }
    if !(p.regex.len() >= 2 && p.regex.starts_with('^') && p.regex.ends_with('$')) {
        return Err(format!("{:?} is not anchored with ^ and $", p.regex));
    }
    if let Some(c) = p
        .regex
        .chars()
        .find(|c| !c.is_ascii_alphanumeric() && !PATTERN_CHARS.contains(*c))
    {
        return Err(format!("{:?} uses {c:?}", p.regex));
    }
    Regex::new(&format!("^(?:{})$", p.regex)).map_err(|e| format!("{:?}: {e}", p.regex))
}

/// A run id: `[A-Za-z0-9_-]{1,64}`.
pub fn valid_id(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}

/// A concrete unit name: systemd's characters, `.service`, at most 128.
fn valid_unit(s: &str) -> bool {
    s.len() <= 128
        && s.strip_suffix(".service").is_some_and(|stem| {
            !stem.is_empty()
                && !stem.starts_with('-')
                && stem.bytes().all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, b'@' | b'.' | b'_' | b'-' | b':')
                })
        })
}

/// The `{name}` placeholders in a unit template, or why it has a bad one.
fn placeholders(unit: &str) -> Result<BTreeSet<String>, String> {
    let mut out = BTreeSet::new();
    let mut rest = unit;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let close = after
            .find('}')
            .ok_or_else(|| format!("{unit:?} opens a {{ it never closes"))?;
        let name = &after[..close];
        if !valid_name(name) {
            return Err(format!("{unit:?} names a selector {name:?}"));
        }
        out.insert(name.to_string());
        rest = &after[close + 1..];
    }
    if rest.contains('}') {
        return Err(format!("{unit:?} closes a }} it never opened"));
    }
    Ok(out)
}

/// A template with each `{name}` replaced by its selector's value.
fn expand(unit: &str, selectors: &BTreeMap<String, String>) -> String {
    selectors.iter().fold(unit.to_string(), |u, (k, v)| {
        u.replace(&format!("{{{k}}}"), v)
    })
}

/// One table entry, by the rules the evaluation asserts: its patterns,
/// compiled, or why not.
fn check_verb(verb: &str, spec: &VerbSpec) -> Result<Patterns, String> {
    if !valid_name(verb) {
        return Err("not a verb name ([a-z][a-z0-9-]{0,31})".into());
    }
    if verb == STATUS_VERB {
        return Err("`status` is the helper's own".into());
    }
    if !(1..=MAX_TIMEOUT_SECS).contains(&spec.timeout_secs) {
        return Err(format!("timeout_secs is 1 to {MAX_TIMEOUT_SECS}"));
    }
    let named = placeholders(&spec.unit)?;
    let declared: BTreeSet<String> = spec.selectors.keys().cloned().collect();
    let mut compiled = BTreeMap::new();
    if spec.run_file() {
        // Every value travels in the run file; the unit is a template the
        // run id instantiates.
        if !named.is_empty() {
            return Err("a verb with a run file splices nothing into its unit".into());
        }
        if !spec
            .unit
            .strip_suffix("@.service")
            .is_some_and(|stem| valid_unit(&format!("{stem}@x.service")))
        {
            return Err(format!(
                "{:?}: a verb with a run file names a template, x@.service",
                spec.unit
            ));
        }
        for (name, p) in &spec.patterns {
            if !valid_name(name) {
                return Err(format!("{name:?} is not a selector name"));
            }
            if declared.contains(name) {
                return Err(format!("{name:?} is both a selector and a pattern"));
            }
            let re = check_pattern(p).map_err(|why| format!("pattern {name:?}: {why}"))?;
            compiled.insert(name.clone(), (p.max_len, re));
        }
        if let Some(max) = spec.payload_max {
            if !(1..=MAX_PAYLOAD).contains(&max) {
                return Err(format!("payload_max is 1 to {MAX_PAYLOAD}"));
            }
        }
    } else if named != declared {
        return Err(format!(
            "the unit names selectors {named:?} and the schema declares {declared:?}"
        ));
    }
    for (sel, values) in &spec.selectors {
        if values.is_empty() {
            return Err(format!("selector {sel:?} allows no value"));
        }
        if let Some(v) = values.iter().find(|v| !valid_value(v)) {
            return Err(format!("selector {sel:?} lists {v:?}"));
        }
    }
    // Any one value per selector shows the shape every expansion has.
    let sample: BTreeMap<String, String> = spec
        .selectors
        .iter()
        .map(|(k, v)| (k.clone(), v[0].clone()))
        .collect();
    if !valid_unit(&expand(&spec.unit, &sample)) {
        return Err(format!("{:?} is not a .service name", spec.unit));
    }
    Ok(compiled)
}

/// A verb's pattern selectors, compiled: selector → its cap and its regex.
type Patterns = BTreeMap<String, (usize, Regex)>;

/// A table `Table::check` passed, with every pattern compiled once: the only
/// thing a request is resolved against.
#[derive(Debug)]
pub struct Checked {
    pub table: Table,
    /// Verb → its compiled patterns.
    patterns: BTreeMap<String, Patterns>,
}

impl Table {
    /// Every rule the evaluation asserts, again: a table this refuses
    /// makes the helper answer nothing but `internal`.
    pub fn check(self) -> Result<Checked, String> {
        for (what, p) in [
            ("systemctl", &self.systemctl),
            ("journalctl", &self.journalctl),
            ("run_dir", &self.run_dir),
        ] {
            if !p.starts_with('/') {
                return Err(format!("{what} must be an absolute path, not {p:?}"));
            }
        }
        let mut patterns = BTreeMap::new();
        for (verb, spec) in &self.verbs {
            let compiled = check_verb(verb, spec).map_err(|why| format!("verb {verb:?}: {why}"))?;
            patterns.insert(verb.clone(), compiled);
        }
        Ok(Checked {
            table: self,
            patterns,
        })
    }

    /// Every verb this table answers, `status` first.
    pub fn known(&self) -> Vec<String> {
        std::iter::once(STATUS_VERB.to_string())
            .chain(self.verbs.keys().cloned())
            .collect()
    }
}

impl Checked {
    /// A request, against the table: the unit it starts, or why not.
    pub fn resolve(&self, req: &Request) -> Result<Resolved, Refusal> {
        let t = &self.table;
        if !valid_id(&req.id) {
            return Err((
                code::BAD_REQUEST,
                "an id is 1 to 64 of [A-Za-z0-9_-]".into(),
            ));
        }
        if req.verb == STATUS_VERB {
            if !req.selectors.is_empty() || req.payload.is_some() {
                return Err((
                    code::BAD_REQUEST,
                    "`status` takes no selectors and no payload".into(),
                ));
            }
            return Ok(Resolved::Status);
        }
        let (Some(spec), Some(patterns)) = (t.verbs.get(&req.verb), self.patterns.get(&req.verb))
        else {
            return Err((
                code::UNKNOWN_VERB,
                format!(
                    "no verb {:?}; this helper knows {}",
                    req.verb.chars().take(40).collect::<String>(),
                    t.known().join(", ")
                ),
            ));
        };
        let bad = |msg: String| Err((code::BAD_REQUEST, msg));
        for (k, v) in &req.selectors {
            if let Some(allowed) = spec.selectors.get(k) {
                if !allowed.contains(v) {
                    return bad(format!("`{}`: {k} is not one of its values", req.verb));
                }
            } else if let Some((max_len, re)) = patterns.get(k) {
                // The floor, then the regex.
                let fits = valid_free_value(v, *max_len) && re.is_match(v.as_str());
                if !fits {
                    return bad(format!("`{}`: {k} does not have its shape", req.verb));
                }
            } else {
                return bad(format!(
                    "`{}` takes no selector {:?}",
                    req.verb,
                    k.chars().take(40).collect::<String>()
                ));
            }
        }
        if let Some(missing) = spec
            .selectors
            .keys()
            .chain(spec.patterns.keys())
            .find(|k| !req.selectors.contains_key(*k))
        {
            return bad(format!("`{}` needs the selector {missing}", req.verb));
        }
        match (&req.payload, spec.payload_max) {
            (Some(_), None) => return bad(format!("`{}` takes no payload", req.verb)),
            (Some(p), Some(max)) if p.len() > max => {
                return bad(format!(
                    "`{}`: the payload is {} bytes, and it takes at most {max}",
                    req.verb,
                    p.len()
                ))
            }
            _ => {}
        }
        let timeout = Duration::from_secs(spec.timeout_secs);
        let dir = std::path::Path::new(&t.run_dir);
        if !spec.run_file() {
            let unit = expand(&spec.unit, &req.selectors);
            return Ok(Resolved::Run {
                verb: req.verb.clone(),
                lock: dir.join(format!("{}.lock", unit.trim_end_matches(".service"))),
                unit,
                timeout,
                run_file: None,
            });
        }
        let template = spec.unit.trim_end_matches(".service").to_string();
        let body = serde_json::to_vec(&serde_json::json!({
            "id": req.id,
            "verb": req.verb,
            "selectors": req.selectors,
            "payload": req.payload,
        }))
        .map_err(|e| (code::INTERNAL, e.to_string()))?;
        Ok(Resolved::Run {
            verb: req.verb.clone(),
            unit: format!("{template}{}.service", req.id),
            timeout,
            lock: dir.join(format!("{template}.lock")),
            run_file: Some(RunFile {
                path: dir.join(format!("{}.json", req.id)),
                body,
                template,
            }),
        })
    }
}

/// The next line from `r` as text, all of it before `deadline` however it
/// trickles in (`set_timeout` is handed what is left before each read);
/// None at the end of the stream. A line past the reader's maximum is an
/// error, and so is one that is not UTF-8.
pub fn read_line<R: Read>(
    r: &mut LineReader<R>,
    deadline: Deadline,
    set_timeout: impl Fn(&R, Duration) -> std::io::Result<()>,
) -> std::io::Result<Option<String>> {
    match r.next_line_by(deadline, set_timeout)? {
        None => Ok(None),
        Some(buf) => String::from_utf8(buf).map(Some).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "a line that is not UTF-8")
        }),
    }
}

/// A journal message as a progress line: control characters (ANSI's ESC
/// among them) dropped, cut to `MAX_PROGRESS` characters.
pub fn progress_text(message: &str) -> String {
    message
        .chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .take(MAX_PROGRESS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Table {
        serde_json::from_str(
            r#"{"allow_uid":1000,"systemctl":"/bin/systemctl","journalctl":"/bin/journalctl",
                "run_dir":"/run/daedalus-root-runs",
                "verbs":{
                  "reboot":{"unit":"daedalus-power.service","description":"Restart the box","timeout_secs":90},
                  "deploy":{"unit":"app-{app}-deploy.service","description":"Deploy an app","timeout_secs":600,
                            "selectors":{"app":["blog","shop"]}}}}"#,
        )
        .unwrap()
    }

    fn req(verb: &str, sel: &[(&str, &str)]) -> Request {
        Request {
            verb: verb.into(),
            id: "0123456789abcdef".into(),
            selectors: sel
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            payload: None,
        }
    }

    #[test]
    fn only_the_listed_uid_is_served() {
        assert!(peer_allowed(Some(1000), 1000));
        assert!(!peer_allowed(Some(0), 1000), "root is not the operator");
        assert!(!peer_allowed(Some(100999), 1000));
        assert!(!peer_allowed(None, 1000));
    }

    #[test]
    fn a_verb_resolves_to_its_unit_and_nothing_else() {
        let t = table().check().unwrap();
        assert_eq!(
            t.resolve(&req("reboot", &[])).unwrap(),
            Resolved::Run {
                verb: "reboot".into(),
                unit: "daedalus-power.service".into(),
                timeout: Duration::from_secs(90),
                lock: "/run/daedalus-root-runs/daedalus-power.lock".into(),
                run_file: None
            }
        );
        assert_eq!(
            t.resolve(&req("deploy", &[("app", "blog")])).unwrap(),
            Resolved::Run {
                verb: "deploy".into(),
                unit: "app-blog-deploy.service".into(),
                timeout: Duration::from_secs(600),
                lock: "/run/daedalus-root-runs/app-blog-deploy.lock".into(),
                run_file: None
            }
        );
        assert_eq!(t.resolve(&req("status", &[])).unwrap(), Resolved::Status);
    }

    #[test]
    fn what_a_caller_cannot_say() {
        let t = table().check().unwrap();
        let code_of = |r: Request| t.resolve(&r).unwrap_err().0;
        assert_eq!(code_of(req("poweroff", &[])), code::UNKNOWN_VERB);
        assert_eq!(code_of(req("Reboot", &[])), code::UNKNOWN_VERB);
        // A selector the verb does not take, a value off its list, one missing.
        assert_eq!(
            code_of(req("reboot", &[("app", "blog")])),
            code::BAD_REQUEST
        );
        assert_eq!(
            code_of(req("deploy", &[("app", "../../etc")])),
            code::BAD_REQUEST
        );
        assert_eq!(
            code_of(req("deploy", &[("app", "blog --now")])),
            code::BAD_REQUEST
        );
        assert_eq!(code_of(req("deploy", &[])), code::BAD_REQUEST);
        assert_eq!(
            code_of(req("status", &[("app", "blog")])),
            code::BAD_REQUEST
        );
        let mut r = req("reboot", &[]);
        r.id = "a b".into();
        assert_eq!(code_of(r), code::BAD_REQUEST);
        // Unknown fields are refused at parse.
        assert!(serde_json::from_str::<Request>(
            r#"{"verb":"reboot","id":"x","unit":"sshd.service"}"#
        )
        .is_err());
        let known = t.resolve(&req("halt", &[])).unwrap_err().1;
        assert!(known.contains("status, deploy, reboot"), "{known}");
    }

    #[test]
    fn a_bad_table_is_refused() {
        let with = |f: &dyn Fn(&mut Table)| {
            let mut t = table();
            f(&mut t);
            t.check()
        };
        let spec = |unit: &str| VerbSpec {
            unit: unit.into(),
            description: String::new(),
            timeout_secs: 60,
            selectors: BTreeMap::new(),
            patterns: BTreeMap::new(),
            payload_max: None,
        };
        assert!(with(&|_| {}).is_ok());
        assert!(with(&|t| {
            t.verbs.insert("status".into(), spec("x.service"));
        })
        .unwrap_err()
        .contains("helper's own"));
        assert!(with(&|t| {
            t.verbs.insert("x".into(), spec("x.socket"));
        })
        .is_err());
        assert!(with(&|t| {
            t.verbs.insert("x".into(), spec("../x.service"));
        })
        .is_err());
        assert!(with(&|t| {
            t.verbs.insert("x".into(), spec("x-{app}.service"));
        })
        .unwrap_err()
        .contains("declares"));
        assert!(with(&|t| {
            t.verbs
                .get_mut("deploy")
                .unwrap()
                .selectors
                .insert("app".into(), vec![]);
        })
        .is_err());
        assert!(with(&|t| {
            t.verbs
                .get_mut("deploy")
                .unwrap()
                .selectors
                .insert("app".into(), vec!["a/b".into()]);
        })
        .is_err());
        assert!(with(&|t| t.verbs.get_mut("reboot").unwrap().timeout_secs = 0).is_err());
        assert!(with(&|t| t.systemctl = "systemctl".into()).is_err());
        assert!(with(&|t| {
            t.verbs.insert("Bad".into(), spec("x.service"));
        })
        .is_err());
    }

    #[test]
    fn the_lines_on_the_wire() {
        let l = |v: &Line| serde_json::to_string(v).unwrap();
        assert_eq!(
            l(&Line::Started {
                unit: "daedalus-power.service".into()
            }),
            r#"{"t":"started","unit":"daedalus-power.service"}"#
        );
        assert_eq!(
            l(&Line::Progress {
                line: "rebooting".into()
            }),
            r#"{"t":"progress","line":"rebooting"}"#
        );
        assert_eq!(
            l(&Line::Result {
                outcome: Outcome::Refused,
                detail: "an apply is running".into(),
                verbs: None
            }),
            r#"{"t":"result","outcome":"refused","detail":"an apply is running"}"#
        );
        assert_eq!(
            l(&Line::Error {
                code: "forbidden".into(),
                msg: "uid 0".into()
            }),
            r#"{"t":"error","code":"forbidden","msg":"uid 0"}"#
        );
        let back: Line =
            serde_json::from_str(r#"{"t":"result","outcome":"done","detail":""}"#).unwrap();
        assert_eq!(
            back,
            Line::Result {
                outcome: Outcome::Done,
                detail: String::new(),
                verbs: None
            }
        );
    }

    #[test]
    fn lines_are_bounded() {
        let later = || Deadline::after(Duration::from_secs(5));
        let mut r = LineReader::new(&b"abc\ndef"[..], 8);
        let none = |_: &&[u8], _| Ok(());
        assert_eq!(
            read_line(&mut r, later(), none).unwrap().as_deref(),
            Some("abc")
        );
        assert_eq!(
            read_line(&mut r, later(), none).unwrap().as_deref(),
            Some("def")
        );
        assert_eq!(read_line(&mut r, later(), none).unwrap(), None);
        let long = [b'x'; 20];
        let mut long = LineReader::new(&long[..], 8);
        assert!(read_line(&mut long, later(), none).is_err());
        assert_eq!(progress_text("\x1b[31mred\x1b[0m\tok"), "[31mred[0m\tok");
        assert_eq!(progress_text(&"y".repeat(5000)).len(), MAX_PROGRESS);
    }

    fn run_table() -> Table {
        serde_json::from_str(
            r#"{"allow_uid":1000,"systemctl":"/bin/systemctl","journalctl":"/bin/journalctl",
                "run_dir":"/run/daedalus-root-runs",
                "verbs":{
                  "clone":{"unit":"ws-clone@.service","description":"Clone","timeout_secs":60,
                           "patterns":{"repo":{"regex":"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$","max_len":140}}},
                  "secret":{"unit":"secret-set@.service","description":"Set","timeout_secs":60,
                            "selectors":{"app":["blog"]},
                            "patterns":{"key":{"regex":"^[A-Za-z_][A-Za-z0-9_]{0,63}$","max_len":64}},
                            "payload_max":100}}}"#,
        )
        .unwrap()
    }

    #[test]
    fn a_pattern_value_goes_to_the_run_file_never_the_unit() {
        let t = run_table().check().unwrap();
        let Resolved::Run {
            unit,
            lock,
            run_file,
            ..
        } = t
            .resolve(&req("clone", &[("repo", "octo/hello.world")]))
            .unwrap()
        else {
            panic!("not a run")
        };
        assert_eq!(unit, "ws-clone@0123456789abcdef.service");
        // Every instance of the template shares one lock.
        assert_eq!(
            lock,
            std::path::Path::new("/run/daedalus-root-runs/ws-clone@.lock")
        );
        let rf = run_file.unwrap();
        assert_eq!(
            rf.path,
            std::path::Path::new("/run/daedalus-root-runs/0123456789abcdef.json")
        );
        assert_eq!(rf.template, "ws-clone@");
        let body: serde_json::Value = serde_json::from_slice(&rf.body).unwrap();
        assert_eq!(body["selectors"]["repo"], "octo/hello.world");
        assert_eq!(body["payload"], serde_json::Value::Null);
        assert_eq!(body["id"], "0123456789abcdef");

        let code_of = |r: Request| t.resolve(&r).unwrap_err().0;
        for bad in [
            "octo",
            "octo/..",
            "octo/.hidden",
            "-octo/x",
            "octo/x/y",
            "octo/x\nreboot",
            "octo/x y",
            "../../etc",
        ] {
            assert_eq!(
                code_of(req("clone", &[("repo", bad)])),
                code::BAD_REQUEST,
                "{bad:?}"
            );
        }
        let long = format!("octo/{}", "x".repeat(150));
        assert_eq!(code_of(req("clone", &[("repo", &long)])), code::BAD_REQUEST);
        assert_eq!(code_of(req("clone", &[])), code::BAD_REQUEST);
    }

    #[test]
    fn an_alternation_is_anchored_as_a_whole() {
        let mut t = run_table();
        t.verbs.get_mut("clone").unwrap().patterns.insert(
            "repo".into(),
            PatternSpec {
                regex: "^[a-z]+|x$".into(),
                max_len: 40,
            },
        );
        let t = t.check().unwrap();
        let fits = |v: &str| t.resolve(&req("clone", &[("repo", v)])).is_ok();
        assert!(fits("abc") && fits("x"));
        for bad in ["ABC/../x", "abc/def", "ABCx", "abc x"] {
            assert!(!fits(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_payload_is_capped_and_only_for_the_verb_that_takes_one() {
        let t = run_table().check().unwrap();
        let with = |verb: &str, sel: &[(&str, &str)], payload: Option<&str>| {
            let mut r = req(verb, sel);
            r.payload = payload.map(str::to_string);
            t.resolve(&r)
        };
        let sel = [("app", "blog"), ("key", "API_TOKEN")];
        let Resolved::Run { run_file, .. } = with("secret", &sel, Some("sealed")).unwrap() else {
            panic!("not a run")
        };
        let body: serde_json::Value = serde_json::from_slice(&run_file.unwrap().body).unwrap();
        assert_eq!(body["payload"], "sealed");
        assert_eq!(body["selectors"]["key"], "API_TOKEN");
        // A remove carries none.
        assert!(with("secret", &sel, None).is_ok());
        assert_eq!(
            with("secret", &sel, Some(&"x".repeat(101))).unwrap_err().0,
            code::BAD_REQUEST
        );
        assert_eq!(
            with("secret", &[("app", "shop"), ("key", "K")], None)
                .unwrap_err()
                .0,
            code::BAD_REQUEST
        );
        assert_eq!(
            with("secret", &[("app", "blog"), ("key", "sops_mac;x")], None)
                .unwrap_err()
                .0,
            code::BAD_REQUEST
        );
        assert_eq!(
            with("clone", &[("repo", "a/b")], Some("x")).unwrap_err().0,
            code::BAD_REQUEST
        );
        assert_eq!(
            with("status", &[], Some("x")).unwrap_err().0,
            code::BAD_REQUEST
        );
        // The payload never prints.
        let mut r = req("secret", &sel);
        r.payload = Some("the-sealed-bytes".into());
        assert!(!format!("{r:?}").contains("the-sealed-bytes"));
    }

    #[test]
    fn a_bad_run_file_verb_is_refused() {
        let with = |f: &dyn Fn(&mut Table)| {
            let mut t = run_table();
            f(&mut t);
            t.check()
        };
        let pat = |regex: &str, max_len: usize| PatternSpec {
            regex: regex.into(),
            max_len,
        };
        let clone = |t: &mut Table| t.verbs.get_mut("clone").unwrap().clone();
        assert!(with(&|_| {}).is_ok());
        assert!(with(&|t| t.run_dir = "runs".into()).is_err());
        for (regex, max) in [
            ("[a-z]+$", 10),
            ("^[a-z]+", 10),
            ("^\\w+$", 10),
            ("^[a-z]+$", 0),
            ("^[a-z]+$", 1000),
            ("^[a-z+$", 10),
        ] {
            assert!(
                with(&|t| {
                    let mut v = clone(t);
                    v.patterns.insert("repo".into(), pat(regex, max));
                    t.verbs.insert("clone".into(), v);
                })
                .is_err(),
                "{regex:?} {max}"
            );
        }
        assert!(
            with(&|t| t.verbs.get_mut("clone").unwrap().unit = "ws-clone.service".into()).is_err()
        );
        assert!(with(
            &|t| t.verbs.get_mut("clone").unwrap().unit = "ws-clone@{repo}.service".into()
        )
        .is_err());
        assert!(with(&|t| t.verbs.get_mut("secret").unwrap().payload_max = Some(0)).is_err());
        assert!(
            with(&|t| t.verbs.get_mut("secret").unwrap().payload_max = Some(MAX_PAYLOAD + 1))
                .is_err()
        );
        assert!(with(&|t| {
            t.verbs
                .get_mut("secret")
                .unwrap()
                .selectors
                .insert("key".into(), vec!["K".into()]);
        })
        .is_err());
        assert!(valid_free_value("a b", 10) && !valid_free_value("-a", 10));
        assert!(!valid_free_value("a\tb", 10) && !valid_free_value("é", 10));
    }
}
