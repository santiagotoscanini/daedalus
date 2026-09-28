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
//! **Running a verb** is `systemctl start <unit>`: the work is the unit's,
//! so it survives a switch restarting its caller, this helper or the
//! controller. While it runs, the unit's own journal lines stream back as
//! progress; when the start job ends, `systemctl start`'s own exit says
//! how: `failed` when the job failed, else `done` — or `refused` when the
//! unit's last line starts with `REFUSED_PREFIX` (the rest is the reason;
//! the unit exits 0, so a refusal is not a failed unit). The journal, not
//! the exit status, carries the refusal because systemd forgets a
//! oneshot's exit status once it is inactive (measured: `ExecMainStatus=0`
//! after an exit 3 listed in `SuccessExitStatus`). A unit already running
//! is `refused`, never joined. `status` is built in and read-only: every
//! verb, its unit and that unit's state.
//!
//! **Framing.** One JSON object per line. In: `Request`, at most
//! `MAX_REQUEST` bytes, within `REQUEST_DEADLINE`. Out: `Line` — any number
//! of `progress`, then exactly one `result` or `error`.
//!
//! ```text
//! → {"verb":"reboot","id":"5f0c9d2e7a1b3c4d","selectors":{}}
//! ← {"t":"progress","line":"rebooting"}
//! ← {"t":"result","outcome":"done","detail":"rebooting"}
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Read};
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub mod relay;

#[cfg(target_os = "linux")]
pub mod helper;

/// The longest request line read.
pub const MAX_REQUEST: usize = 4096;
/// The longest answer line either side accepts (a `status` is the largest).
pub const MAX_ANSWER: usize = 1 << 20;
/// A progress line is cut to this many characters.
pub const MAX_PROGRESS: usize = 2048;
/// How long a connection has to send its request.
pub const REQUEST_DEADLINE: Duration = Duration::from_secs(10);
/// How a verb's unit says no: its last line starts with this, the reason
/// after it (module doc).
pub const REFUSED_PREFIX: &str = "refused: ";
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
    pub verbs: BTreeMap<String, VerbSpec>,
}

/// One verb: the unit it starts and what it may be told.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerbSpec {
    /// A `.service` name; `{selector}` marks where a selector's value goes.
    pub unit: String,
    pub description: String,
    /// How long the helper waits for the start job before it reports
    /// `failed` (the unit goes on; its own TimeoutStartSec is the real one).
    pub timeout_secs: u64,
    /// Selector → the values it may take.
    #[serde(default)]
    pub selectors: BTreeMap<String, Vec<String>>,
}

/// One request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub verb: String,
    /// The caller's run id, for the logs on both sides.
    pub id: String,
    #[serde(default)]
    pub selectors: BTreeMap<String, String>,
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
    /// The unit's `ActiveState`; null for a template (no one instance) or
    /// when systemd could not be asked.
    pub active_state: Option<String>,
    /// Its `Result` from the last run.
    pub result: Option<String>,
}

/// One line the helper writes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Line {
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
    },
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

/// One table entry, by the rules the evaluation asserts.
fn check_verb(verb: &str, spec: &VerbSpec) -> Result<(), String> {
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
    if named != declared {
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
    Ok(())
}

impl Table {
    /// Every rule the evaluation asserts, again: a table this refuses
    /// makes the helper answer nothing but `internal`.
    pub fn check(&self) -> Result<(), String> {
        for (what, p) in [
            ("systemctl", &self.systemctl),
            ("journalctl", &self.journalctl),
        ] {
            if !p.starts_with('/') {
                return Err(format!("{what} must be an absolute path, not {p:?}"));
            }
        }
        for (verb, spec) in &self.verbs {
            check_verb(verb, spec).map_err(|why| format!("verb {verb:?}: {why}"))?;
        }
        Ok(())
    }

    /// A request, against the table: the unit it starts, or why not.
    pub fn resolve(&self, req: &Request) -> Result<Resolved, Refusal> {
        if !valid_id(&req.id) {
            return Err((
                code::BAD_REQUEST,
                "an id is 1 to 64 of [A-Za-z0-9_-]".into(),
            ));
        }
        if req.verb == STATUS_VERB {
            if !req.selectors.is_empty() {
                return Err((code::BAD_REQUEST, "`status` takes no selectors".into()));
            }
            return Ok(Resolved::Status);
        }
        let spec = self.verbs.get(&req.verb).ok_or_else(|| {
            (
                code::UNKNOWN_VERB,
                format!(
                    "no verb {:?}; this helper knows {}",
                    req.verb.chars().take(40).collect::<String>(),
                    self.known().join(", ")
                ),
            )
        })?;
        for (k, v) in &req.selectors {
            let Some(allowed) = spec.selectors.get(k) else {
                return Err((
                    code::BAD_REQUEST,
                    format!(
                        "`{}` takes no selector {:?}",
                        req.verb,
                        k.chars().take(40).collect::<String>()
                    ),
                ));
            };
            if !allowed.contains(v) {
                return Err((
                    code::BAD_REQUEST,
                    format!("`{}`: {k} is not one of its values", req.verb),
                ));
            }
        }
        if let Some(missing) = spec
            .selectors
            .keys()
            .find(|k| !req.selectors.contains_key(*k))
        {
            return Err((
                code::BAD_REQUEST,
                format!("`{}` needs the selector {missing}", req.verb),
            ));
        }
        Ok(Resolved::Run {
            verb: req.verb.clone(),
            unit: expand(&spec.unit, &req.selectors),
            timeout: Duration::from_secs(spec.timeout_secs),
        })
    }

    /// Every verb this table answers, `status` first.
    pub fn known(&self) -> Vec<String> {
        std::iter::once(STATUS_VERB.to_string())
            .chain(self.verbs.keys().cloned())
            .collect()
    }
}

/// One line of at most `max` bytes, without its newline; None at the end
/// of the stream. A longer line is an error, and so is one that is not
/// UTF-8.
pub fn read_line<R: BufRead>(r: &mut R, max: usize) -> std::io::Result<Option<String>> {
    let mut buf = Vec::new();
    let n = r.take(max as u64 + 1).read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
    } else if buf.len() > max {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("a line is at most {max} bytes"),
        ));
    }
    String::from_utf8(buf).map(Some).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "a line that is not UTF-8")
    })
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
        let t = table();
        t.check().unwrap();
        assert_eq!(
            t.resolve(&req("reboot", &[])).unwrap(),
            Resolved::Run {
                verb: "reboot".into(),
                unit: "daedalus-power.service".into(),
                timeout: Duration::from_secs(90)
            }
        );
        assert_eq!(
            t.resolve(&req("deploy", &[("app", "blog")])).unwrap(),
            Resolved::Run {
                verb: "deploy".into(),
                unit: "app-blog-deploy.service".into(),
                timeout: Duration::from_secs(600)
            }
        );
        assert_eq!(t.resolve(&req("status", &[])).unwrap(), Resolved::Status);
    }

    #[test]
    fn what_a_caller_cannot_say() {
        let t = table();
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
        let mut r = std::io::Cursor::new(b"abc\ndef".to_vec());
        assert_eq!(read_line(&mut r, 8).unwrap().as_deref(), Some("abc"));
        assert_eq!(read_line(&mut r, 8).unwrap().as_deref(), Some("def"));
        assert_eq!(read_line(&mut r, 8).unwrap(), None);
        let mut long = std::io::Cursor::new(vec![b'x'; 20]);
        assert!(read_line(&mut long, 8).is_err());
        assert_eq!(progress_text("\x1b[31mred\x1b[0m\tok"), "[31mred[0m\tok");
        assert_eq!(progress_text(&"y".repeat(5000)).len(), MAX_PROGRESS);
    }
}
