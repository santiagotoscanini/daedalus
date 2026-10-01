//! `daedalus-agent root-helper --table <file>`: one connection's root
//! process, started by `daedalus-root@.service` with the connection on its
//! stdin (root/mod.rs has the design). It answers on that socket and logs
//! to stderr, the instance's journal. It exits 0 whenever it answered,
//! whatever the answer, so a refusal never leaves a failed unit.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use super::{
    code, peer_allowed, progress_text, read_line, Line, Outcome, Request, Resolved, RunFile, Table,
    VerbState, MAX_REQUEST, REFUSED_PREFIX, REQUEST_DEADLINE,
};

/// A write the controller does not take within this long ends the run
/// (the unit goes on).
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// After the start job ends, how long journald gets to hand over the
/// unit's last lines.
const JOURNAL_SETTLE: Duration = Duration::from_millis(400);
/// A `systemctl show` or a cursor read answers within this long.
const QUICK: Duration = Duration::from_secs(10);

pub fn main(args: &[String]) -> Result<()> {
    let path = match args {
        [flag, p] if flag == "--table" => p,
        // The build's check (controller.nix): the rules every start applies,
        // run once on the rendered table, so a table the helper would refuse
        // never reaches a box.
        [flag, p] if flag == "--check-table" => return check_table(p),
        _ => bail!(
            "usage: daedalus-agent root-helper --table FILE (systemd starts it, one per connection)\n       \
             daedalus-agent root-helper --check-table FILE"
        ),
    };
    // SAFETY: systemd hands the accepted connection over as fd 0
    // (StandardInput=socket); nothing else in this process owns it.
    let sock = unsafe { UnixStream::from_raw_fd(0) };
    serve(sock, path)
}

/// The table at `path`, parsed and held to `Table::check`: Ok, or the
/// reason the helper would answer every request with `internal`.
fn check_table(path: &str) -> Result<()> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {path}"))?;
    let table: Table =
        serde_json::from_slice(&bytes).with_context(|| format!("{path} is not a verb table"))?;
    table
        .check()
        .map(drop)
        .map_err(|why| anyhow::anyhow!("{path} would be refused: {why}"))
}

/// One connection, answered, then closed so the peer reads the answer: a
/// unix socket closed with unread input resets, and the peer's read of the
/// answer fails — so the write side is shut and what is left of the input
/// (a request never read, after a refusal) is read away first.
fn serve(sock: UnixStream, path: &str) -> Result<()> {
    let end = sock.try_clone().context("the connection")?;
    let answered = answer(sock, path);
    let _ = end.shutdown(std::net::Shutdown::Write);
    let _ = end.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = std::io::copy(
        &mut std::io::Read::take(&end, MAX_REQUEST as u64 * 4),
        &mut std::io::sink(),
    );
    answered
}

fn answer(sock: UnixStream, path: &str) -> Result<()> {
    let peer = peer_uid(&sock);
    let mut out = sock.try_clone().context("the connection")?;
    let _ = out.set_write_timeout(Some(WRITE_TIMEOUT));
    // The request, all of it, within REQUEST_DEADLINE of the connection.
    let deadline = crate::deadline::Deadline::after(REQUEST_DEADLINE);

    let table = std::fs::read(path)
        .map_err(anyhow::Error::from)
        .and_then(|b| serde_json::from_slice::<Table>(&b).map_err(anyhow::Error::from))
        .and_then(|t| t.check().map_err(anyhow::Error::msg));
    let checked = match table {
        Ok(t) => t,
        Err(e) => {
            eprintln!("root helper: the table {path} is unusable: {e:#}");
            send(
                &mut out,
                &error(
                    code::INTERNAL,
                    "the helper's verb table is unusable; see its journal",
                ),
            );
            return Ok(());
        }
    };
    let table = &checked.table;

    if !peer_allowed(peer, table.allow_uid) {
        let who = peer.map_or("a peer without credentials".into(), |u| format!("uid {u}"));
        eprintln!("root helper: refused {who}");
        send(
            &mut out,
            &error(
                code::FORBIDDEN,
                format!("{who} may not ask the root helper"),
            ),
        );
        return Ok(());
    }

    let mut reader = crate::jsonl::LineReader::new(sock, MAX_REQUEST);
    let req = match read_line(&mut reader, deadline, |s, d| s.set_read_timeout(Some(d))) {
        Ok(Some(l)) => serde_json::from_str::<Request>(&l).map_err(|e| e.to_string()),
        Ok(None) => Err("no request".into()),
        Err(e) => Err(e.to_string()),
    };
    let req = match req {
        Ok(r) => r,
        Err(e) => {
            send(
                &mut out,
                &error(code::BAD_REQUEST, format!("not a request: {e}")),
            );
            return Ok(());
        }
    };
    let resolved = match checked.resolve(&req) {
        Ok(r) => r,
        Err((c, msg)) => {
            eprintln!(
                "root helper: refused {:?} (id {:?}): {msg}",
                req.verb, req.id
            );
            send(&mut out, &error(c, msg));
            return Ok(());
        }
    };
    match resolved {
        Resolved::Status => {
            let verbs = status(table);
            send(
                &mut out,
                &Line::Result {
                    outcome: Outcome::Done,
                    detail: format!("{} verbs", verbs.len()),
                    verbs: Some(verbs),
                },
            );
        }
        Resolved::Run {
            verb,
            unit,
            timeout,
            lock,
            run_file,
        } => {
            eprintln!("root helper: {verb} (id {}) starts {unit}", req.id);
            let (outcome, detail) = run(table, &unit, timeout, &lock, run_file.as_ref(), &mut out);
            eprintln!("root helper: {verb} (id {}) {outcome:?}: {detail}", req.id);
            send(
                &mut out,
                &Line::Result {
                    outcome,
                    detail,
                    verbs: None,
                },
            );
        }
    }
    Ok(())
}

fn error(code: &str, msg: impl Into<String>) -> Line {
    Line::Error {
        code: code.into(),
        msg: msg.into(),
    }
}

/// One line to the controller; false once it stopped taking them.
fn send(out: &mut UnixStream, line: &Line) -> bool {
    let Ok(mut text) = serde_json::to_string(line) else {
        return false;
    };
    text.push('\n');
    out.write_all(text.as_bytes())
        .and_then(|()| out.flush())
        .is_ok()
}

/// The uid on the other end, as the kernel states it.
fn peer_uid(s: &UnixStream) -> Option<u32> {
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: SO_PEERCRED fills a ucred of the stated size on this socket.
    let rc = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    (rc == 0 && len as usize == std::mem::size_of::<libc::ucred>()).then_some(cred.uid)
}

/// `systemctl show` of a few properties, as a map; empty when it failed.
fn show(table: &Table, unit: &str, props: &[&str]) -> BTreeMap<String, String> {
    let mut cmd = Command::new(&table.systemctl);
    cmd.arg("show").arg(unit);
    for p in props {
        cmd.arg("-p").arg(p);
    }
    crate::exec::stdout_or(cmd, QUICK, crate::exec::Text::Lossy)
        .map(|s| parse_show(&s))
        .unwrap_or_default()
}

/// `Key=value` lines.
fn parse_show(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn status(table: &Table) -> Vec<VerbState> {
    table
        .verbs
        .iter()
        .map(|(verb, spec)| {
            let props = if spec.unit.contains('{') || spec.run_file() {
                BTreeMap::new()
            } else {
                show(table, &spec.unit, &["ActiveState", "Result"])
            };
            VerbState {
                verb: verb.clone(),
                unit: spec.unit.clone(),
                description: spec.description.clone(),
                selectors: spec.selectors.clone(),
                patterns: spec
                    .patterns
                    .iter()
                    .map(|(k, p)| (k.clone(), p.regex.clone()))
                    .collect(),
                payload_max: spec.payload_max,
                active_state: props.get("ActiveState").cloned(),
                result: props.get("Result").cloned(),
            }
        })
        .collect()
}

/// A unit that is somewhere between started and stopped.
fn busy(active_state: &str) -> bool {
    matches!(
        active_state,
        "activating" | "deactivating" | "reloading" | "refreshing"
    )
}

/// The journal's tail, as a cursor to follow from.
fn journal_cursor(table: &Table) -> Option<String> {
    let mut cmd = Command::new(&table.journalctl);
    cmd.args(["-q", "-n", "0", "--show-cursor"]);
    let text = crate::exec::stdout_or(cmd, QUICK, crate::exec::Text::Lossy).ok()?;
    text.lines()
        .find_map(|l| l.strip_prefix("-- cursor: "))
        .map(str::to_string)
}

/// One journal entry: its cursor, the unit invocation that wrote it, and its
/// message.
type Entry = (String, Option<String>, String);

/// One `-o json` line as an `Entry`; a message that is not UTF-8 arrives as
/// an array of bytes.
fn entry(line: &str) -> Option<Entry> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let cursor = v.get("__CURSOR")?.as_str()?.to_string();
    let invocation = v
        .get("_SYSTEMD_INVOCATION_ID")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let message = match v.get("MESSAGE")? {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(b) => {
            let bytes: Vec<u8> = b
                .iter()
                .filter_map(|x| x.as_u64().map(|n| n as u8))
                .collect();
            String::from_utf8_lossy(&bytes).into_owned()
        }
        _ => return None,
    };
    Some((cursor, invocation, message))
}

/// `journalctl` over the unit's own lines after `cursor`, following or not.
fn journal(table: &Table, unit: &str, cursor: Option<&str>, follow: bool) -> Command {
    let mut cmd = Command::new(&table.journalctl);
    cmd.args(["-q", "--no-pager", "-o", "json"]);
    if follow {
        cmd.arg("-f");
    }
    match cursor {
        Some(c) => cmd.arg(format!("--after-cursor={c}")),
        None => cmd.arg("--since=now"),
    };
    cmd.arg(format!("_SYSTEMD_UNIT={unit}"));
    cmd.stdin(Stdio::null()).stderr(Stdio::null());
    cmd
}

fn kill(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// The unit's lines on their way out: the last cursor (where a catch-up
/// read starts), the last non-blank line (a refusal's reason), and the
/// invocation this run follows: the first entry's. A run of the same unit
/// that starts right after this one ends writes under another invocation,
/// and its lines are not this run's.
struct Relay<'a> {
    out: &'a mut UnixStream,
    last_cursor: Option<String>,
    invocation: Option<String>,
    last_line: String,
    /// The controller still takes lines. When it goes, the unit does not
    /// care and neither does the outcome: they are only no one's to read.
    listening: bool,
}

impl Relay<'_> {
    fn take(&mut self, (cursor, invocation, message): Entry) {
        self.last_cursor = Some(cursor);
        match (&self.invocation, invocation) {
            (Some(mine), Some(theirs)) if *mine != theirs => return,
            (None, Some(first)) => self.invocation = Some(first),
            _ => {}
        }
        let text = progress_text(&message);
        if self.listening && !send(self.out, &Line::Progress { line: text.clone() }) {
            self.listening = false;
        }
        if !text.trim().is_empty() {
            self.last_line = text;
        }
    }
}

/// Run a verb (root/mod.rs, "Running a verb"): hold its lock, or refuse;
/// for one with a run file ("The run file"), refuse while another instance
/// of its template runs and write the file; start the unit; and take away
/// what the unit left of the file once it is done.
fn run(
    table: &Table,
    unit: &str,
    timeout: Duration,
    lock: &Path,
    run_file: Option<&RunFile>,
    out: &mut UnixStream,
) -> (Outcome, String) {
    // Held until this run's answer: two connections at once (each its own
    // helper process) cannot both find the unit idle and both start it.
    let _held = match hold(lock) {
        Ok(Some(f)) => f,
        Ok(None) => {
            let what = run_file.map_or(unit.to_string(), |rf| format!("{}…", rf.template));
            return (
                Outcome::Refused,
                format!("another {what} run is under way; wait for it to finish"),
            );
        }
        Err(e) => {
            return (
                Outcome::Failed,
                format!("the run directory could not be locked: {e}"),
            )
        }
    };
    let Some(rf) = run_file else {
        return run_unit(table, unit, timeout, out);
    };
    match template_busy(table, &rf.template) {
        Ok(None) => {}
        Ok(Some(other)) => {
            return (
                Outcome::Refused,
                format!("{other} is still running; wait for it to finish"),
            )
        }
        Err(e) => return (Outcome::Failed, e),
    }
    if let Err(e) = write_run_file(rf) {
        return (
            Outcome::Failed,
            format!(
                "the run file {} could not be written: {e}",
                rf.path.display()
            ),
        );
    }
    let answer = run_unit(table, unit, timeout, out);
    // Still running (the wait ran out): the unit reads and removes its own.
    let running = show(table, unit, &["ActiveState"])
        .get("ActiveState")
        .is_some_and(|s| busy(s));
    if !running {
        let _ = std::fs::remove_file(&rf.path);
    }
    answer
}

/// Another instance of `template` (`x@`) between started and stopped: its
/// name, or None; an error when systemd could not be asked.
fn template_busy(table: &Table, template: &str) -> Result<Option<String>, String> {
    let mut cmd = Command::new(&table.systemctl);
    cmd.args([
        "list-units",
        "--all",
        "--plain",
        "--no-legend",
        "--no-pager",
        "--state=activating,deactivating,reloading,refreshing",
    ])
    .arg(format!("{template}*.service"));
    let text = crate::exec::stdout_or(cmd, QUICK, crate::exec::Text::Lossy)
        .map_err(|e| format!("systemd could not list {template}*: {e}"))?;
    Ok(text
        .lines()
        .find_map(|l| l.split_whitespace().next())
        .map(str::to_string))
}

/// The run directory `file` is in, when it is this process's own and nobody
/// else's: a real directory (not a link) of this uid, 0700. Nix makes it
/// (tmpfiles); the helper never does, since its sandbox can write only
/// inside it.
fn run_dir(file: &Path) -> std::io::Result<&Path> {
    use std::io::{Error, ErrorKind};
    use std::os::unix::fs::MetadataExt;
    let dir = file.parent().ok_or_else(|| {
        Error::new(
            ErrorKind::InvalidInput,
            "a path in the run directory names none",
        )
    })?;
    let m = std::fs::symlink_metadata(dir)?;
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    if !m.file_type().is_dir() || m.uid() != me || m.mode() & 0o077 != 0 {
        return Err(Error::other(format!(
            "{} must be a directory of uid {me}'s, 0700",
            dir.display()
        )));
    }
    Ok(dir)
}

/// A verb's lock (root/mod.rs, "Running a verb"), taken without waiting:
/// the open file while it is held, None while another helper holds it.
fn hold(path: &Path) -> std::io::Result<Option<std::fs::File>> {
    use std::os::unix::fs::OpenOptionsExt;
    run_dir(path)?;
    let f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    // SAFETY: a valid fd, owned by `f`, which outlives the call.
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(f));
    }
    let e = std::io::Error::last_os_error();
    if e.kind() == std::io::ErrorKind::WouldBlock {
        Ok(None)
    } else {
        Err(e)
    }
}

/// The run file: created exclusively, 0600, never through a link, in the
/// run directory (`run_dir`).
fn write_run_file(rf: &RunFile) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    run_dir(&rf.path)?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&rf.path)?;
    f.write_all(&rf.body)?;
    f.sync_all()
}

/// Start the unit, stream its lines, and say how it ended.
fn run_unit(
    table: &Table,
    unit: &str,
    timeout: Duration,
    out: &mut UnixStream,
) -> (Outcome, String) {
    let before = show(table, unit, &["ActiveState", "LoadState"]);
    match before.get("LoadState").map(String::as_str) {
        Some("loaded") => {}
        other => {
            return (
                Outcome::Failed,
                format!(
                    "{unit} is not a loaded unit on this box ({})",
                    other.unwrap_or("systemd did not answer")
                ),
            )
        }
    }
    if let Some(s) = before.get("ActiveState").filter(|s| busy(s)) {
        return (
            Outcome::Refused,
            format!("{unit} is already running ({s}); wait for it to finish"),
        );
    }

    let cursor = journal_cursor(table);
    let (tx, rx) = mpsc::channel::<Entry>();
    let mut follower = journal(table, unit, cursor.as_deref(), true)
        .stdout(Stdio::piped())
        .spawn()
        .ok();
    if let Some(stdout) = follower.as_mut().and_then(|f| f.stdout.take()) {
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                if let Some(e) = entry(&line) {
                    if tx.send(e).is_err() {
                        return;
                    }
                }
            }
        });
    }

    let mut start = match Command::new(&table.systemctl)
        .arg("start")
        .arg(unit)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            if let Some(f) = follower.as_mut() {
                kill(f);
            }
            return (Outcome::Failed, format!("systemctl could not be run: {e}"));
        }
    };

    let deadline = Instant::now() + timeout;
    let mut relay = Relay {
        out,
        last_cursor: cursor.clone(),
        invocation: None,
        last_line: String::new(),
        listening: true,
    };
    let exit = loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(e) => {
                relay.take(e);
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {}
        }
        match start.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => break None,
            Ok(None) => {}
            Err(_) => break None,
        }
    };
    let start_err = if exit.is_none() {
        // Only the client goes: the job is systemd's and runs on.
        kill(&mut start);
        String::new()
    } else {
        let mut s = String::new();
        if let Some(mut e) = start.stderr.take() {
            let _ = std::io::Read::read_to_string(&mut e, &mut s);
        }
        s.lines().next().unwrap_or_default().to_string()
    };

    std::thread::sleep(JOURNAL_SETTLE);
    while let Ok(e) = rx.try_recv() {
        relay.take(e);
    }
    if let Some(f) = follower.as_mut() {
        kill(f);
    }
    while let Ok(e) = rx.try_recv() {
        relay.take(e);
    }
    // What the follower had not handed over when it was stopped.
    let after_cursor = relay.last_cursor.clone();
    // Bounded like every other shell-out (exec.rs): a deadline, capped
    // output (audit D15e).
    if let Ok(text) = crate::exec::stdout_or(
        journal(table, unit, after_cursor.as_deref(), false),
        QUICK,
        crate::exec::Text::Lossy,
    ) {
        for line in text.lines() {
            if let Some(e) = entry(line) {
                relay.take(e);
            }
        }
    }

    if exit.is_none() {
        return (
            Outcome::Failed,
            format!(
                "{unit} gave no result within {} s; it goes on (journalctl -u {unit})",
                timeout.as_secs()
            ),
        );
    }
    let job_ok = exit.is_some_and(|s| s.success());
    let result = if job_ok {
        String::new()
    } else {
        show(table, unit, &["Result"])
            .remove("Result")
            .unwrap_or_default()
    };
    outcome_of(job_ok, &result, &relay.last_line, &start_err)
}

/// The outcome from whether the start job succeeded and the unit's last
/// line (module doc); `result` is the unit's `Result`, read only after a
/// failure, for a detail when the unit printed nothing.
fn outcome_of(job_ok: bool, result: &str, last_line: &str, start_err: &str) -> (Outcome, String) {
    if job_ok {
        return match last_line.strip_prefix(REFUSED_PREFIX) {
            Some(reason) if !reason.trim().is_empty() => (Outcome::Refused, reason.to_string()),
            Some(_) => (Outcome::Refused, "refused, without a reason".into()),
            None => (Outcome::Done, last_line.to_string()),
        };
    }
    let detail = if !last_line.is_empty() {
        last_line.to_string()
    } else if !start_err.is_empty() {
        start_err.to_string()
    } else {
        format!("the unit failed (Result={result})")
    };
    (Outcome::Failed, detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_job_and_the_last_line_say_how_it_ended() {
        assert_eq!(
            outcome_of(true, "", "rebooting", ""),
            (Outcome::Done, "rebooting".into())
        );
        assert_eq!(
            outcome_of(true, "", "refused: an apply is running", ""),
            (Outcome::Refused, "an apply is running".into())
        );
        assert_eq!(
            outcome_of(true, "", "refused: ", ""),
            (Outcome::Refused, "refused, without a reason".into())
        );
        // Only the last line counts, and only as a prefix.
        assert_eq!(
            outcome_of(true, "", "nothing was refused: all good", "").0,
            Outcome::Done
        );
        assert_eq!(
            outcome_of(false, "exit-code", "", "Job for x.service failed"),
            (Outcome::Failed, "Job for x.service failed".into())
        );
        assert_eq!(
            outcome_of(false, "exit-code", "the agent broke", "Job failed"),
            (Outcome::Failed, "the agent broke".into())
        );
        assert_eq!(
            outcome_of(false, "timeout", "", ""),
            (Outcome::Failed, "the unit failed (Result=timeout)".into())
        );
        assert!(busy("activating") && !busy("inactive") && !busy("failed"));
    }

    #[test]
    fn journal_entries_and_show_lines() {
        assert_eq!(
            entry(r#"{"__CURSOR":"s=1","MESSAGE":"rebooting","_PID":"2"}"#),
            Some(("s=1".into(), None, "rebooting".into()))
        );
        assert_eq!(
            entry(r#"{"__CURSOR":"s=2","_SYSTEMD_INVOCATION_ID":"i1","MESSAGE":[104,105,255]}"#),
            Some(("s=2".into(), Some("i1".into()), "hi\u{fffd}".into()))
        );
        assert_eq!(entry(r#"{"MESSAGE":"no cursor"}"#), None);
        let m = parse_show("ActiveState=inactive\nResult=success\nLoadState=loaded\n");
        assert_eq!(m["LoadState"], "loaded");
        assert_eq!(m.len(), 3);
    }

    #[test]
    fn the_build_check_holds_a_table_to_the_start_rules() {
        let dir = std::env::temp_dir().join(format!("daedalus-check-table-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, verbs: serde_json::Value| {
            let p = dir.join(name);
            let t = serde_json::json!({
                "allow_uid": 1000,
                "systemctl": "/bin/systemctl",
                "journalctl": "/bin/journalctl",
                "run_dir": "/run/daedalus-root-runs",
                "verbs": verbs,
            });
            std::fs::write(&p, t.to_string()).unwrap();
            p.display().to_string()
        };
        let good = write(
            "good.json",
            serde_json::json!({"reboot": {"unit": "power.service", "description": "d", "timeout_secs": 90}}),
        );
        assert!(main(&["--check-table".into(), good]).is_ok());
        // `status` is the helper's own verb: a table naming it is refused.
        let bad = write(
            "bad.json",
            serde_json::json!({"status": {"unit": "power.service", "description": "d", "timeout_secs": 90}}),
        );
        let err = main(&["--check-table".into(), bad])
            .unwrap_err()
            .to_string();
        assert!(err.contains("would be refused"), "{err}");
        let garbage = dir.join("garbage.json");
        std::fs::write(&garbage, "{").unwrap();
        assert!(main(&["--check-table".into(), garbage.display().to_string()]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A table whose tools are shell scripts standing in for systemd: the
    /// unit is loaded and reads idle, `start` succeeds (after two seconds
    /// while `slow` exists), and the journal has one line for the run,
    /// `message`.
    fn fake(dir: &std::path::Path, allow_uid: u32, message: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let runs = dir.join("runs");
        std::fs::create_dir_all(&runs).unwrap();
        std::fs::set_permissions(&runs, std::fs::Permissions::from_mode(0o700)).unwrap();
        let script = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p.display().to_string()
        };
        let systemctl = script(
            "systemctl",
            &format!(
                "case \"$1\" in\n show) printf 'ActiveState=inactive\\nLoadState=loaded\\nResult=success\\n';;\n start) [ \"$2\" = fake.service ] || exit 5; if [ -e {}/slow ]; then sleep 2; fi;;\n esac",
                dir.display()
            ),
        );
        let entry = serde_json::json!({"__CURSOR": "c1", "MESSAGE": message}).to_string();
        let journalctl = script(
            "journalctl",
            &format!(
                "for a in \"$@\"; do case \"$a\" in\n --show-cursor) echo '-- cursor: c0'; exit 0;;\n -f) echo '{entry}'; exec sleep 30;;\n esac; done"
            ),
        );
        let table = serde_json::json!({
            "allow_uid": allow_uid,
            "systemctl": systemctl,
            "journalctl": journalctl,
            "run_dir": runs.display().to_string(),
            "verbs": {"reboot": {"unit": "fake.service", "description": "a fake", "timeout_secs": 20}}
        });
        let path = dir.join("table.json");
        std::fs::write(&path, table.to_string()).unwrap();
        path.display().to_string()
    }

    #[test]
    fn a_run_keeps_to_its_own_invocation() {
        let (mut out, peer) = UnixStream::pair().unwrap();
        let mut r = Relay {
            out: &mut out,
            last_cursor: None,
            invocation: None,
            last_line: String::new(),
            listening: true,
        };
        r.take(("c1".into(), Some("mine".into()), "rebooting".into()));
        // The next run of the same unit, caught in the settle window.
        r.take(("c2".into(), Some("next".into()), "refused: not mine".into()));
        assert_eq!(r.last_line, "rebooting");
        assert_eq!(r.last_cursor.as_deref(), Some("c2"));
        drop(peer);
    }

    /// One whole connection over a socket pair: the lines the peer reads.
    fn converse(table: &str, request: &str) -> Vec<Line> {
        let (mut client, server) = UnixStream::pair().unwrap();
        client.write_all(request.as_bytes()).unwrap();
        serve(server, table).unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut client, &mut text).unwrap();
        text.lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("daedalus-root-{name}-{}", std::process::id()))
    }

    #[test]
    fn a_peer_the_table_does_not_list_gets_one_refusal() {
        let me = unsafe { libc::geteuid() };
        let dir = scratch("peer");
        let table = fake(&dir, me.wrapping_add(1), "rebooting");
        let lines = converse(&table, "{\"verb\":\"reboot\",\"id\":\"r1\"}\n");
        assert!(
            matches!(&lines[..], [Line::Error { code, .. }] if code == "forbidden"),
            "{lines:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_run_streams_the_units_lines_then_its_outcome() {
        let me = unsafe { libc::geteuid() };
        let dir = scratch("run");
        let table = fake(&dir, me, "refused: the reason");
        let lines = converse(&table, "{\"verb\":\"reboot\",\"id\":\"r2\"}\n");
        assert_eq!(
            lines,
            [
                Line::Progress {
                    line: "refused: the reason".into()
                },
                Line::Result {
                    outcome: Outcome::Refused,
                    detail: "the reason".into(),
                    verbs: None
                }
            ]
        );
        // An unknown verb and a bad line are answered, never run.
        let lines = converse(&table, "{\"verb\":\"poweroff\",\"id\":\"r3\"}\n");
        assert!(matches!(&lines[..], [Line::Error { code, .. }] if code == "unknown_verb"));
        let lines = converse(&table, "not json\n");
        assert!(matches!(&lines[..], [Line::Error { code, .. }] if code == "bad_request"));
        // status: the table's verbs and their units' state.
        let lines = converse(&table, "{\"verb\":\"status\",\"id\":\"r4\"}\n");
        match &lines[..] {
            [Line::Result {
                outcome: Outcome::Done,
                verbs: Some(v),
                ..
            }] => {
                assert_eq!(v.len(), 1);
                assert_eq!(v[0].verb, "reboot");
                assert_eq!(v[0].active_state.as_deref(), Some("inactive"));
            }
            other => panic!("{other:?}"),
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_second_request_for_a_unit_being_started_is_refused_not_joined() {
        let me = unsafe { libc::geteuid() };
        let dir = scratch("twice");
        let _ = std::fs::remove_dir_all(&dir);
        let table = fake(&dir, me, "rebooting");
        // The unit reads idle to both (`show`), and its start takes a while:
        // only the lock tells the second request the first is under way.
        std::fs::write(dir.join("slow"), "").unwrap();
        let first = {
            let table = table.clone();
            std::thread::spawn(move || converse(&table, "{\"verb\":\"reboot\",\"id\":\"a1\"}\n"))
        };
        std::thread::sleep(Duration::from_millis(700));
        let second = converse(&table, "{\"verb\":\"reboot\",\"id\":\"a2\"}\n");
        assert!(
            matches!(second.last(), Some(Line::Result { outcome: Outcome::Refused, detail, .. }) if detail.contains("under way")),
            "{second:?}"
        );
        let first = first.join().unwrap();
        assert!(
            matches!(
                first.last(),
                Some(Line::Result {
                    outcome: Outcome::Done,
                    ..
                })
            ),
            "{first:?}"
        );
        // Released with the answer: the next request runs.
        std::fs::remove_file(dir.join("slow")).unwrap();
        let next = converse(&table, "{\"verb\":\"reboot\",\"id\":\"a3\"}\n");
        assert!(
            matches!(
                next.last(),
                Some(Line::Result {
                    outcome: Outcome::Done,
                    ..
                })
            ),
            "{next:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A run-file verb over fake tools: `start` keeps a copy of the run file
    /// the unit would read, so the test sees what reached it; `list-units`
    /// names a running instance when `busy` exists.
    fn fake_run(dir: &std::path::Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let runs = dir.join("runs");
        std::fs::create_dir_all(&runs).unwrap();
        std::fs::set_permissions(&runs, std::fs::Permissions::from_mode(0o700)).unwrap();
        let script = |name: &str, body: &str| {
            let p = dir.join(name);
            std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p.display().to_string()
        };
        let systemctl = script(
            "systemctl",
            &format!(
                "case \"$1\" in\n list-units) if [ -e {d}/busy ]; then echo 'ws-clone@other.service loaded activating start x'; fi;;\n show) printf 'ActiveState=inactive\\nLoadState=loaded\\nResult=success\\n';;\n start) id=${{2#ws-clone@}}; id=${{id%.service}}; cp {r}/$id.json {d}/seen.json; stat -c %a {r}/$id.json > {d}/mode;;\n esac",
                d = dir.display(),
                r = runs.display()
            ),
        );
        let entry = serde_json::json!({"__CURSOR": "c1", "MESSAGE": "cloned"}).to_string();
        let journalctl = script(
            "journalctl",
            &format!(
                "for a in \"$@\"; do case \"$a\" in\n --show-cursor) echo '-- cursor: c0'; exit 0;;\n -f) echo '{entry}'; exec sleep 30;;\n esac; done"
            ),
        );
        let table = serde_json::json!({
            "allow_uid": unsafe { libc::geteuid() },
            "systemctl": systemctl,
            "journalctl": journalctl,
            "run_dir": runs.display().to_string(),
            "verbs": {"clone": {"unit": "ws-clone@.service", "description": "a fake", "timeout_secs": 20,
                      "patterns": {"repo": {"regex": "^[a-z]+/[a-z]+$", "max_len": 40}},
                      "payload_max": 64}}
        });
        let path = dir.join("table.json");
        std::fs::write(&path, table.to_string()).unwrap();
        path.display().to_string()
    }

    #[test]
    fn a_run_file_reaches_the_unit_and_is_gone_after() {
        let dir = scratch("runfile");
        let _ = std::fs::remove_dir_all(&dir);
        let table = fake_run(&dir);
        let lines = converse(
            &table,
            "{\"verb\":\"clone\",\"id\":\"r9\",\"selectors\":{\"repo\":\"octo/hello\"},\"payload\":\"sealed\"}\n",
        );
        assert_eq!(
            lines.last(),
            Some(&Line::Result {
                outcome: Outcome::Done,
                detail: "cloned".into(),
                verbs: None
            }),
            "{lines:?}"
        );
        let seen: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("seen.json")).unwrap()).unwrap();
        assert_eq!(seen["selectors"]["repo"], "octo/hello");
        assert_eq!(seen["payload"], "sealed");
        assert_eq!(
            std::fs::read_to_string(dir.join("mode")).unwrap().trim(),
            "600"
        );
        assert!(
            !dir.join("runs/r9.json").exists(),
            "the run file is left behind"
        );

        // The same id again finds no file in the way, and a stale one is
        // never written through: a planted link at the next name refuses.
        std::os::unix::fs::symlink("/etc/passwd", dir.join("runs/r10.json")).unwrap();
        let lines = converse(
            &table,
            "{\"verb\":\"clone\",\"id\":\"r10\",\"selectors\":{\"repo\":\"octo/hello\"}}\n",
        );
        assert!(
            matches!(lines.last(), Some(Line::Result { outcome: Outcome::Failed, detail, .. }) if detail.contains("run file")),
            "{lines:?}"
        );

        // Another instance still running refuses the next.
        std::fs::write(dir.join("busy"), "").unwrap();
        let lines = converse(
            &table,
            "{\"verb\":\"clone\",\"id\":\"r11\",\"selectors\":{\"repo\":\"octo/hello\"}}\n",
        );
        assert!(
            matches!(lines.last(), Some(Line::Result { outcome: Outcome::Refused, detail, .. }) if detail.contains("ws-clone@other")),
            "{lines:?}"
        );
        assert!(!dir.join("runs/r11.json").exists());
        std::fs::remove_file(dir.join("busy")).unwrap();

        // Another helper between its check and its start holds the
        // template's lock: this one refuses rather than racing it.
        let held = std::fs::File::open(dir.join("runs/ws-clone@.lock")).unwrap();
        // SAFETY: a valid fd, owned by `held`.
        assert_eq!(
            unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let lines = converse(
            &table,
            "{\"verb\":\"clone\",\"id\":\"r12\",\"selectors\":{\"repo\":\"octo/hello\"}}\n",
        );
        assert!(
            matches!(lines.last(), Some(Line::Result { outcome: Outcome::Refused, detail, .. }) if detail.contains("under way")),
            "{lines:?}"
        );
        assert!(!dir.join("runs/r12.json").exists());
        drop(held);
        let _ = std::fs::remove_dir_all(dir);
    }
}
