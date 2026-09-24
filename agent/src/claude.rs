//! Claude Code on this machine: found, supervised, reported.
//!
//! The box runs `claude remote-control` as a unit under the operator's own
//! login (platform/claude-rc.nix), so a session on it can be opened from
//! claude.ai/code or a phone at any time. This is the same thing on a node,
//! with the one difference the OS forces: Claude Code's login lives in the
//! user's profile (`~/.claude`), which the service — session 0, LocalSystem —
//! cannot see. So the TRAY supervises the server, in the desktop session
//! with the user's credentials, and reports to the service over loopback
//! (`POST /claude/report`, status.rs). The service puts the report on the
//! status page and a summary in every hello, and hands the tray back what
//! the box decided: whether the server should run at all (policy), and its
//! two instructions — update Claude Code, and restart the server.
//!
//! Those two are deliberately separate. An update installs a new CLI beside
//! the running one and interrupts nothing: a session keeps the binary it
//! started on and picks the new one up whenever it next starts, which is
//! upstream's own model. A restart is what moves the RUNNING server onto
//! it, and it ends every session on this machine — they cannot be picked
//! back up from claude.ai, only resumed from a console here. One
//! instruction for both would make the free act cost the expensive one.
//!
//! What is reported mirrors what the box's own snapshot reads about itself
//! (stacks/daedalus/host/claude-snapshot.sh): the server's start banner
//! (version, environment id, spawn mode, session ceiling), the sessions in
//! `~/.claude/sessions/*.json` and whether each process is alive, the
//! credential CLOCK (the plan and two dates — never a token), and the model
//! settings. The server's output goes to `logs\claude-rc.log` beside the
//! agent's own.
//!
//! None of the environment variables that disable Remote Control are set
//! (DISABLE_TELEMETRY, DO_NOT_TRACK, ANTHROPIC_BASE_URL and friends — the
//! nix module lists them); the child inherits the user's environment as is.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::state::now_rfc3339;

/// A run shorter than this counts as a failure and grows the backoff.
const QUICK_EXIT: Duration = Duration::from_secs(60);
/// The backoff ladder's ceiling.
const MAX_BACKOFF: Duration = Duration::from_secs(5 * 60);
/// The server log is rotated once when it passes this, at the next start.
const LOG_ROTATE_BYTES: u64 = 20 * 1024 * 1024;
/// Sessions reported, at most; a profile with hundreds of stale files
/// would otherwise make every hello a long one.
const MAX_SESSIONS: usize = 40;

/// What `claude remote-control` prints about itself at start, once.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Banner {
    /// "2.1.276", from `Remote Control v…`.
    pub version: Option<String>,
    /// `env_…`, what a phone connects to; minted per server start.
    pub environment_id: Option<String>,
    pub spawn_mode: Option<String>,
    pub max_sessions: Option<u32>,
}

impl Banner {
    /// Note one output line; the four banner lines set their fields, the
    /// rest are ignored. Prefixes are literal, as the box's snapshot uses.
    pub fn note(&mut self, line: &str) {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("Remote Control v") {
            self.version = Some(v.split_whitespace().next().unwrap_or(v).to_string());
        } else if let Some(v) = line.strip_prefix("Environment ID: ") {
            self.environment_id = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("Spawn mode: ") {
            self.spawn_mode = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("Max concurrent sessions: ") {
            self.max_sessions = v.trim().parse().ok();
        }
    }
}

/// One session file, as the CLI writes it, plus whether its process lives.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Session {
    pub pid: u32,
    /// The uuid the transcript is filed under.
    pub transcript_id: Option<String>,
    /// `session_…`, the id claude.ai shows for a remote session.
    pub remote_id: Option<String>,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub entrypoint: Option<String>,
    pub version: Option<String>,
    /// Milliseconds since the epoch, as the CLI writes them.
    pub started_at: Option<u64>,
    /// `idle` | `busy`, once the CLI has one.
    pub status: Option<String>,
    /// The later of the file's own clocks, milliseconds since the epoch.
    pub last_activity_at: Option<u64>,
    pub alive: bool,
}

/// The credential clock: the plan and two dates. The tokens are in the same
/// file and are the reason this struct names what it copies.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Credentials {
    pub present: bool,
    /// "file" (`.credentials.json`) or "keychain" (macOS, where the CLI
    /// keeps the login in the login keychain and the dates are not
    /// readable without a prompt).
    pub store: Option<String>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
    /// Milliseconds since the epoch, both.
    pub expires_at: Option<u64>,
    pub refresh_expires_at: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub model: Option<String>,
    pub effort_level: Option<String>,
}

/// What one `claude update` did.
///
/// Kept on the report rather than only logged, because whoever pressed the
/// button is looking at the box, not at this machine's log — and the
/// interesting outcomes are the quiet ones. "Claude is up to date!" from a
/// Homebrew install and "Updates are disabled by your administrator" from a
/// managed one are both successes that changed nothing, and neither shows up
/// in a version number.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdateResult {
    pub at: String,
    pub ok: bool,
    /// The version before and after. Equal when nothing moved, which is a
    /// normal outcome and not a failure.
    pub from: Option<String>,
    pub to: Option<String>,
    /// The last meaningful line the command printed, cut to 200 characters.
    pub detail: String,
}

/// What the tray tells the service, and what the status page shows.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Report {
    /// Where the `claude` command is; None when it was not found.
    pub path: Option<String>,
    /// How it was installed, inferred from that path: native | npm |
    /// homebrew | winget | path. It decides which verb updates it, so the
    /// page shows it beside the button that runs one.
    pub install_method: Option<String>,
    /// `claude --version`.
    pub cli_version: Option<String>,
    /// What the last `claude update` on this machine did, and when. None
    /// until one has been asked for.
    pub last_update: Option<UpdateResult>,
    /// not-installed | off | starting | running | waiting | stopped
    pub state: String,
    /// One line more, when the state has a reason.
    pub detail: Option<String>,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    /// Starts after the first, since the tray came up.
    pub restarts: u32,
    pub last_exit: Option<String>,
    pub server: Banner,
    pub sessions: Vec<Session>,
    pub credentials: Credentials,
    pub settings: Settings,
    /// The account the server runs as, and the profile it reads.
    pub user: Option<String>,
    pub home: Option<String>,
    pub workdir: Option<String>,
    /// How the directory was chosen: "named", "most recent trusted project", or the home fallback.
    pub workdir_via: Option<String>,
    pub log: Option<String>,
    pub reported_at: String,
}

/// The part of the report the OPEN status page and the hello carry: enough
/// for a card and a picker, and nothing anyone on the LAN should not see —
/// no session names, paths or ids, no environment id, no account facts.
/// The full report is behind the node token (status.rs `/claude`).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Summary {
    pub state: String,
    /// The state's reason, minus anything the server printed (a last log
    /// line can name a path).
    pub detail: Option<String>,
    pub cli_version: Option<String>,
    pub server_version: Option<String>,
    /// Sessions alive now.
    pub sessions: usize,
    pub started_at: Option<String>,
    /// Whether a login exists at all; its dates and plan are in the report.
    pub signed_in: bool,
}

impl Report {
    pub fn summary(&self) -> Summary {
        Summary {
            state: self.state.clone(),
            detail: self
                .detail
                .as_deref()
                .map(|d| d.split(" · last line:").next().unwrap_or(d).to_string()),
            cli_version: self.cli_version.clone(),
            server_version: self.server.version.clone(),
            sessions: self.sessions.iter().filter(|s| s.alive).count(),
            started_at: self.started_at.clone(),
            signed_in: self.credentials.present,
        }
    }
}

/// What the service answers a report with: the box's policy and its one
/// instruction, cleared as it goes out.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ReportAnswer {
    /// Whether the server should be running at all.
    pub wanted: bool,
    /// Update Claude Code now, once. Interrupts nothing: the new version
    /// installs beside the running one and takes effect at its next start.
    pub update: bool,
    /// Restart it now, once. Ends every session under the server.
    pub restart: bool,
    /// The directory the policy names for the server, if any.
    pub workdir: Option<String>,
}

// ── where things are ───────────────────────────────────────────────────────

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// `~/.claude`, or what CLAUDE_CONFIG_DIR says — the CLI's own rule.
pub fn claude_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(d));
    }
    home_dir().map(|h| h.join(".claude"))
}

/// The `claude` command: the native install's place first, then npm's, then
/// PATH — asked in that order because the tray's PATH is the one Explorer
/// had at logon, which predates an install made since.
pub fn find_cli() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["claude.exe", "claude.cmd", "claude.bat"]
    } else {
        &["claude"]
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(h) = home_dir() {
        dirs.push(h.join(".local").join("bin"));
    }
    if let Some(a) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(a).join("npm"));
    }
    // A LaunchAgent's PATH is the system's four directories; Homebrew and
    // the native installer both live outside it.
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] {
        dirs.push(PathBuf::from(d));
    }
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    dirs.into_iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// How Claude Code was installed here, named from where `find_cli` found it.
///
/// It decides which verb updates it, and `claude update` is only the right
/// one for the first two. For a package-manager install it is a documented
/// no-op that answers "Claude is up to date!", and the upgrade goes through
/// that manager — which is what `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE`
/// on the spawned server asks Claude Code to do for itself.
pub fn install_method(cli: &Path) -> &'static str {
    let p = cli.to_string_lossy().replace('\\', "/").to_lowercase();
    if p.contains("/.local/bin/") || p.contains("/.local/share/claude/") {
        "native"
    } else if p.contains("/npm/") || p.contains("/node_modules/") {
        "npm"
    } else if p.contains("/homebrew/") || p.contains("/cellar/") {
        "homebrew"
    } else if p.contains("/winget") || p.contains("/windowsapps/") {
        "winget"
    } else {
        "path"
    }
}

/// What a command did: its status and everything it printed.
///
/// `first_line` below is this, narrowed to the one line a version probe
/// wants — it discarded stderr and the exit code, which is exactly what an
/// update run needs to report. A refusal ("Updates are disabled by your
/// administrator") arrives on one stream or the other depending on the
/// version, so both are captured and joined.
pub struct Ran {
    pub ok: bool,
    /// stdout and stderr, in the order each thread finished reading them.
    pub output: String,
}

/// Run to completion, or kill it and give up after `timeout`.
fn run(mut cmd: Command, timeout: Duration) -> Option<Ran> {
    let mut child = hidden(&mut cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    // Both pipes drained on their own threads: a child that fills one while
    // nobody reads the other blocks forever, and `claude update` is chatty
    // on both.
    let mut out = child.stdout.take()?;
    let mut err = child.stderr.take()?;
    let (tx, rx) = mpsc::channel();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        let _ = tx2.send(s);
    });
    let deadline = Instant::now() + timeout;
    let mut text = String::new();
    for _ in 0..2 {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(s) => {
                if !s.trim().is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(s.trim());
                }
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let status = child.wait().ok()?;
    Some(Ran {
        ok: status.success(),
        output: text,
    })
}

/// The last line worth showing of an update run, cut to a status field.
fn last_meaningful(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("no output")
        .chars()
        .take(200)
        .collect()
}

/// Run a command to completion, or give up after `timeout`; the first line
/// of its stdout, trimmed. `run` above is this with both streams and the
/// exit code, which a version probe does not want and an update run does.
fn first_line(mut cmd: Command, timeout: Duration) -> Option<String> {
    let mut child = hidden(&mut cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let text = match rx.recv_timeout(timeout) {
        Ok(t) => t,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();
    text.lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// "2.1.276 (Claude Code)" → "2.1.276".
pub fn parse_version(line: &str) -> Option<String> {
    let v = line.split_whitespace().next()?;
    v.chars().next().filter(char::is_ascii_digit)?;
    Some(v.to_string())
}

pub fn cli_version(cli: &Path) -> Option<String> {
    let mut cmd = Command::new(cli);
    cmd.arg("--version");
    first_line(cmd, Duration::from_secs(20)).and_then(|l| parse_version(&l))
}

// ── the profile ────────────────────────────────────────────────────────────

fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        // SAFETY: a query handle, read once and closed.
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return false;
            };
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code).is_ok();
            let _ = CloseHandle(h);
            ok && code == STILL_ACTIVE
        }
    }
    #[cfg(unix)]
    {
        // Signal 0 delivers nothing and says whether the pid exists (EPERM
        // means it does, owned by someone else).
        // SAFETY: kill with signal 0 has no effect on the target.
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

/// The session files, alive ones first, newest first within each.
pub fn read_sessions(dir: &Path) -> Vec<Session> {
    let Ok(entries) = std::fs::read_dir(dir.join("sessions")) else {
        return Vec::new();
    };
    let mut out: Vec<Session> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter_map(|v| session_of(&v))
        .collect();
    out.sort_by(|a, b| b.alive.cmp(&a.alive).then(b.started_at.cmp(&a.started_at)));
    out.truncate(MAX_SESSIONS);
    out
}

fn session_of(v: &serde_json::Value) -> Option<Session> {
    let pid = v.get("pid")?.as_u64()? as u32;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let n = |k: &str| v.get(k).and_then(|x| x.as_u64());
    let last = [n("statusUpdatedAt"), n("updatedAt")]
        .into_iter()
        .flatten()
        .max();
    Some(Session {
        pid,
        transcript_id: s("sessionId"),
        remote_id: s("bridgeSessionId"),
        cwd: s("cwd"),
        name: s("name"),
        kind: s("kind"),
        entrypoint: s("entrypoint"),
        version: s("version"),
        started_at: n("startedAt"),
        status: s("status"),
        last_activity_at: last,
        alive: pid_alive(pid),
    })
}

/// The credential clock from `.credentials.json`: four fields by name, and
/// nothing else leaves the file.
pub fn read_credentials(dir: &Path) -> Credentials {
    let path = dir.join(".credentials.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return keychain_credentials();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Credentials {
            present: true,
            store: Some("file".into()),
            ..Default::default()
        };
    };
    let o = v.get("claudeAiOauth");
    let s = |k: &str| {
        o.and_then(|o| o.get(k))
            .and_then(|x| x.as_str())
            .map(str::to_string)
    };
    let n = |k: &str| o.and_then(|o| o.get(k)).and_then(|x| x.as_u64());
    Credentials {
        present: true,
        store: Some("file".into()),
        subscription_type: s("subscriptionType"),
        rate_limit_tier: s("rateLimitTier"),
        expires_at: n("expiresAt"),
        refresh_expires_at: n("refreshTokenExpiresAt"),
    }
}

/// macOS keeps the login in the login keychain under the service name the
/// CLI uses. Listing the item's attributes needs no access to the secret
/// and so triggers no prompt; the dates inside it would, so they stay
/// unread. Absent everywhere else.
fn keychain_credentials() -> Credentials {
    #[cfg(target_os = "macos")]
    {
        let found = std::process::Command::new("security")
            .args(["find-generic-password", "-s", "Claude Code-credentials"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if found {
            return Credentials {
                present: true,
                store: Some("keychain".into()),
                ..Default::default()
            };
        }
    }
    Credentials::default()
}

pub fn read_settings(dir: &Path) -> Settings {
    let Ok(text) = std::fs::read_to_string(dir.join("settings.json")) else {
        return Settings::default();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Settings::default();
    };
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Settings {
        model: s("model"),
        effort_level: s("effortLevel"),
    }
}

// ── where the server runs ──────────────────────────────────────────────────
//
// `claude remote-control` refuses the home directory: home-directory trust
// is never saved, so it has to run in a project directory the user has
// trusted once (the dialog on first `claude` there). The box runs its own in
// the configuration checkout; a node has no such fixed place, so the tray
// picks one: the directory the policy or the config names, or else the
// trusted project the user ran Claude in most recently — the CLI records
// both facts per project in `~/.claude.json`.

/// `~/.claude.json`, the CLI's own record of projects and trust.
fn cli_config_path() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(d).join(".claude.json"));
    }
    home_dir().map(|h| h.join(".claude.json"))
}

/// The trusted project directory used most recently, if any exists.
pub fn most_recent_trusted_project() -> Option<PathBuf> {
    let text = std::fs::read_to_string(cli_config_path()?).ok()?;
    trusted_project_in(&text, home_dir().as_deref(), Path::is_dir)
}

/// The pure half: the most recently started trusted project in the CLI's
/// config text, skipping the home directory and anything `exists` denies.
fn trusted_project_in(
    config: &str,
    home: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let v: serde_json::Value = serde_json::from_str(config).ok()?;
    v.get("projects")?
        .as_object()?
        .iter()
        .filter(|(_, p)| p.get("hasTrustDialogAccepted").and_then(|t| t.as_bool()) == Some(true))
        .map(|(dir, p)| {
            let last = ["lastStartTime", "lastSessionModified"]
                .iter()
                .find_map(|k| p.get(k).and_then(|t| t.as_str()))
                .unwrap_or_default()
                .to_string();
            (PathBuf::from(dir), last)
        })
        .filter(|(dir, _)| home != Some(dir.as_path()) && exists(dir))
        .max_by(|a, b| a.1.cmp(&b.1))
        .map(|(dir, _)| dir)
}

/// Where the server should run: the named directory when it exists, else the
/// most recent trusted project, else the home directory (which will not
/// work, and the server's own message says why).
pub fn pick_workdir(named: Option<&str>) -> (PathBuf, &'static str) {
    if let Some(d) = named.map(str::trim).filter(|d| !d.is_empty()) {
        let p = PathBuf::from(d);
        if p.is_dir() {
            return (p, "named");
        }
    }
    if let Some(p) = most_recent_trusted_project() {
        return (p, "most recent trusted project");
    }
    (
        home_dir().unwrap_or_else(|| PathBuf::from(".")),
        "home (no trusted project found)",
    )
}

// ── the supervisor ─────────────────────────────────────────────────────────

struct Running {
    child: Child,
    since: Instant,
    started_at: String,
    banner: Arc<Mutex<Banner>>,
}

/// Keeps one `claude remote-control` running while it is wanted.
///
/// Driven by `tick` from the tray's loop: it reaps an exit, waits out the
/// backoff, and starts the next one. Nothing blocks — the tray's message
/// pump is on the same thread.
pub struct Supervisor {
    cli: Option<PathBuf>,
    cli_version: Option<String>,
    /// The directory the policy or the config names; None means pick one.
    named_workdir: Option<String>,
    /// What the running (or next) server uses, and how it was chosen.
    workdir: PathBuf,
    workdir_via: &'static str,
    log_path: PathBuf,
    wanted: bool,
    running: Option<Running>,
    /// Kept from the last run, so the page still names the environment a
    /// moment after an exit.
    last_banner: Banner,
    restarts: u32,
    failures: u32,
    next_start: Option<Instant>,
    last_exit: Option<String>,
    recent_lines: Arc<Mutex<VecDeque<String>>>,
    /// What the last `claude update` did, kept for the report.
    last_update: Option<UpdateResult>,
    /// An update is running on its own thread right now.
    updating: bool,
    /// Where that thread leaves its result for `tick` to collect.
    update_slot: Arc<Mutex<Option<UpdateResult>>>,
}

impl Supervisor {
    pub fn new(named_workdir: Option<String>, log_path: PathBuf, wanted: bool) -> Self {
        let cli = find_cli();
        let cli_version = cli.as_deref().and_then(cli_version);
        let (workdir, workdir_via) = pick_workdir(named_workdir.as_deref());
        Self {
            cli,
            cli_version,
            named_workdir,
            workdir,
            workdir_via,
            log_path,
            wanted,
            running: None,
            last_banner: Banner::default(),
            restarts: 0,
            failures: 0,
            next_start: None,
            last_exit: None,
            recent_lines: Arc::new(Mutex::new(VecDeque::new())),
            last_update: None,
            updating: false,
            update_slot: Arc::new(Mutex::new(None)),
        }
    }

    pub fn wanted(&self) -> bool {
        self.wanted
    }

    /// Look for the command again — for a machine where Claude Code was
    /// installed after the tray came up.
    pub fn rescan(&mut self) {
        if self.cli.is_none() {
            self.cli = find_cli();
            self.cli_version = self.cli.as_deref().and_then(cli_version);
        }
    }

    pub fn set_wanted(&mut self, wanted: bool) {
        if wanted == self.wanted {
            return;
        }
        self.wanted = wanted;
        if !wanted {
            self.stop("not wanted");
        } else {
            self.failures = 0;
            self.next_start = Some(Instant::now());
        }
    }

    /// The directory the box (or the config) names. A change restarts the
    /// server there; None goes back to picking the most recent trusted
    /// project.
    pub fn set_named_workdir(&mut self, named: Option<String>) {
        let named = named
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if named == self.named_workdir {
            return;
        }
        self.named_workdir = named;
        let (dir, via) = pick_workdir(self.named_workdir.as_deref());
        if dir != self.workdir {
            self.workdir = dir;
            self.workdir_via = via;
            if self.running.is_some() {
                self.restart();
            }
        }
    }

    /// Stop and start again now, forgetting any backoff.
    pub fn restart(&mut self) {
        self.stop("restart asked");
        self.failures = 0;
        self.next_start = Some(Instant::now());
    }

    /// Update Claude Code on this machine, and record what happened.
    ///
    /// Nothing is stopped. The new version installs beside the running one
    /// and takes effect at its next start, which is upstream's own model —
    /// so a session mid-turn is untouched and the server keeps the binary it
    /// has until `restart` moves it.
    ///
    /// `claude update` for every install: it is the supported verb for a
    /// native or npm one, and for a package-manager one it is a documented
    /// no-op that reports "Claude is up to date!" rather than doing
    /// something surprising. Those upgrade themselves through
    /// CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE, which `start` sets on the
    /// server. Run as the tray, i.e. the logged-in user, which is right for
    /// a per-user install and is all the privilege there is here — a
    /// machine-wide install under an administrator's path is the case this
    /// cannot serve, and the report's install_method is what says so.
    ///
    /// Ten minutes, because this downloads ~80 MB over whatever line the
    /// machine has. Slow is not stuck; a hung process is killed at the end
    /// of it and reported as one.
    /// ON ITS OWN THREAD, and that is not an optimisation. This is called
    /// from the tray's tick, which runs every five seconds and is the only
    /// thing that reports to the service, restarts the server and drains the
    /// menu. Running an ~80 MB download inline would freeze all of it for up
    /// to ten minutes — the box would see the tray stop reporting and say
    /// "nobody logged on", which is the opposite of what just happened.
    /// `tick` collects the result through the slot below.
    pub fn update_claude(&mut self) {
        if self.updating {
            tracing::info!("a claude update is already running; ignoring the request");
            return;
        }
        let Some(cli) = self.cli.clone() else {
            self.last_update = Some(UpdateResult {
                at: now_rfc3339(),
                ok: false,
                from: None,
                to: None,
                detail: "no `claude` command on this machine to update".into(),
            });
            return;
        };
        let before = self.cli_version.clone();
        let slot = Arc::clone(&self.update_slot);
        self.updating = true;
        std::thread::spawn(move || {
            let mut cmd = Command::new(&cli);
            cmd.arg("update");
            let ran = run(cmd, Duration::from_secs(600));
            // Re-probed either way: an update that reported failure may
            // still have moved the binary, and the version on disk is the
            // fact — not the command's account of itself.
            let after = cli_version(&cli);
            let result = match ran {
                Some(r) => UpdateResult {
                    at: now_rfc3339(),
                    ok: r.ok,
                    from: before,
                    to: after,
                    detail: last_meaningful(&r.output),
                },
                None => UpdateResult {
                    at: now_rfc3339(),
                    ok: false,
                    from: before,
                    to: after,
                    detail: "`claude update` did not finish within ten minutes and was killed"
                        .into(),
                },
            };
            tracing::info!(detail = %result.detail, ok = result.ok, "claude update finished");
            if let Ok(mut s) = slot.lock() {
                *s = Some(result);
            }
        });
    }

    /// Take a finished update off the slot, if one landed since the last
    /// tick. Called from `tick`; cheap and lock-free in the common case.
    fn collect_update(&mut self) {
        if !self.updating {
            return;
        }
        let done = self.update_slot.lock().ok().and_then(|mut s| s.take());
        if let Some(r) = done {
            self.cli_version = r.to.clone();
            self.last_update = Some(r);
            self.updating = false;
        }
    }

    /// Advance: reap, wait, start. Cheap; call it often.
    pub fn tick(&mut self) {
        self.collect_update();
        if let Some(r) = self.running.as_mut() {
            match r.child.try_wait() {
                Ok(Some(status)) => {
                    let ran = r.since.elapsed();
                    self.last_banner = r.banner.lock().map(|b| b.clone()).unwrap_or_default();
                    self.running = None;
                    let code = status
                        .code()
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "signal".into());
                    self.last_exit = Some(format!(
                        "exit {code} after {} at {}",
                        short_duration(ran),
                        now_rfc3339()
                    ));
                    if ran < QUICK_EXIT {
                        self.failures = self.failures.saturating_add(1);
                    } else {
                        self.failures = 0;
                    }
                    if self.wanted {
                        self.next_start = Some(Instant::now() + self.backoff());
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    self.last_exit = Some(format!("lost: {e}"));
                    self.running = None;
                    if self.wanted {
                        self.next_start = Some(Instant::now() + self.backoff());
                    }
                }
            }
        }
        if self.running.is_none() && self.wanted {
            if let Some(at) = self.next_start {
                if Instant::now() >= at {
                    self.next_start = None;
                    self.start();
                }
            } else if self.restarts == 0 && self.last_exit.is_none() {
                // First tick: start at once.
                self.start();
            }
        }
    }

    fn backoff(&self) -> Duration {
        if self.failures == 0 {
            return Duration::from_secs(2);
        }
        let secs = 5u64.saturating_mul(1u64 << self.failures.min(10));
        Duration::from_secs(secs).min(MAX_BACKOFF)
    }

    fn start(&mut self) {
        if self.cli.is_none() {
            self.rescan();
        }
        let Some(cli) = self.cli.clone() else {
            // Look again in a minute, not on every tick.
            self.next_start = Some(Instant::now() + Duration::from_secs(60));
            return;
        };
        // A trust accepted since the last look is honoured on the next start.
        let (dir, via) = pick_workdir(self.named_workdir.as_deref());
        self.workdir = dir;
        self.workdir_via = via;
        let log = match open_log(&self.log_path) {
            Ok(f) => f,
            Err(e) => {
                self.last_exit = Some(format!("log not opened: {e}"));
                self.next_start = Some(Instant::now() + MAX_BACKOFF);
                return;
            }
        };
        let log = Arc::new(Mutex::new(log));
        {
            let mut f = log.lock().unwrap_or_else(|p| p.into_inner());
            let _ = writeln!(
                f,
                "── {} daedalus-agent-tray starting `claude remote-control --verbose` in {} ──",
                now_rfc3339(),
                self.workdir.display()
            );
        }
        let mut cmd = Command::new(&cli);
        cmd.arg("remote-control")
            .arg("--verbose")
            .current_dir(&self.workdir)
            // Let Claude Code upgrade a package-manager install by itself.
            // A native or npm install auto-updates already and `claude
            // update` drives it on demand; a Homebrew or WinGet one does
            // neither, and this is upstream's own mechanism for it — the
            // server runs `brew upgrade` / `winget upgrade` in the
            // background when a release lands. Set here rather than
            // globally because this is the process that acts on it, and
            // because it must not reach anything else the tray spawns.
            //
            // Known limit, stated so a failure is not a mystery: on WinGet
            // the upgrade can fail while Claude Code is running, because
            // Windows locks the executable. It then shows the manual
            // command and nothing breaks.
            .env("CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            // Its own process group, so a stop can reach the sessions it
            // spawned and not only the server.
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(target_os = "macos")]
        {
            // The LaunchAgent's PATH is the system's; the server spawns git
            // and shells from wherever the user installed them.
            let path = std::env::var("PATH").unwrap_or_default();
            let local = home_dir().map(|h| h.join(".local/bin").display().to_string());
            cmd.env(
                "PATH",
                format!(
                    "{}:/opt/homebrew/bin:/usr/local/bin:{path}",
                    local.unwrap_or_default()
                ),
            );
        }
        let mut child = match hidden(&mut cmd).spawn() {
            Ok(c) => c,
            Err(e) => {
                self.last_exit = Some(format!("not started: {e} at {}", now_rfc3339()));
                self.failures = self.failures.saturating_add(1);
                self.next_start = Some(Instant::now() + self.backoff());
                return;
            }
        };
        let banner = Arc::new(Mutex::new(Banner::default()));
        for pipe in [
            child
                .stdout
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|p| Box::new(p) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let log = Arc::clone(&log);
            let banner = Arc::clone(&banner);
            let recent = Arc::clone(&self.recent_lines);
            std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    banner.lock().unwrap_or_else(|p| p.into_inner()).note(&line);
                    if let Ok(mut f) = log.lock() {
                        let _ = writeln!(f, "{line}");
                    }
                    if let Ok(mut r) = recent.lock() {
                        if r.len() >= 20 {
                            r.pop_front();
                        }
                        r.push_back(line);
                    }
                }
            });
        }
        if self.last_exit.is_some() || self.restarts > 0 {
            self.restarts = self.restarts.saturating_add(1);
        }
        self.running = Some(Running {
            child,
            since: Instant::now(),
            started_at: now_rfc3339(),
            banner,
        });
    }

    /// End the server and every session under it.
    pub fn stop(&mut self, why: &str) {
        let Some(mut r) = self.running.take() else {
            return;
        };
        self.last_banner = r.banner.lock().map(|b| b.clone()).unwrap_or_default();
        let pid = r.child.id();
        #[cfg(windows)]
        {
            // The whole tree: a `.cmd` launcher's node, and the sessions the
            // server spawned. `kill` alone would orphan them.
            let mut cmd = Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
            let _ = hidden(&mut cmd)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(unix)]
        {
            // SAFETY: a signal to the group the child leads; nothing else is
            // in it.
            unsafe {
                let _ = libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
            }
            // A moment to leave on its own before the hard kill below.
            for _ in 0..20 {
                if matches!(r.child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let _ = r.child.kill();
        let _ = r.child.wait();
        self.last_exit = Some(format!("stopped ({why}) at {}", now_rfc3339()));
        self.next_start = None;
        let _ = pid;
    }

    /// The current picture, with the profile read fresh.
    pub fn report(&self) -> Report {
        let dir = claude_dir();
        let (sessions, credentials, settings) = match dir.as_deref() {
            Some(d) => (read_sessions(d), read_credentials(d), read_settings(d)),
            None => (Vec::new(), Credentials::default(), Settings::default()),
        };
        let (state, detail) = self.state();
        let server = match &self.running {
            Some(r) => r.banner.lock().map(|b| b.clone()).unwrap_or_default(),
            None => self.last_banner.clone(),
        };
        Report {
            path: self.cli.as_ref().map(|p| p.display().to_string()),
            install_method: self.cli.as_deref().map(|p| install_method(p).to_string()),
            cli_version: self.cli_version.clone(),
            last_update: self.last_update.clone(),
            state,
            detail,
            pid: self.running.as_ref().map(|r| r.child.id()),
            started_at: self.running.as_ref().map(|r| r.started_at.clone()),
            restarts: self.restarts,
            last_exit: self.last_exit.clone(),
            server,
            sessions,
            credentials,
            settings,
            user: std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .ok(),
            home: dir.map(|d| d.display().to_string()),
            workdir: Some(self.workdir.display().to_string()),
            workdir_via: Some(self.workdir_via.to_string()),
            log: Some(self.log_path.display().to_string()),
            reported_at: now_rfc3339(),
        }
    }

    fn state(&self) -> (String, Option<String>) {
        if self.cli.is_none() {
            return (
                "not-installed".into(),
                Some("no `claude` command in ~/.local/bin, npm's bin, Homebrew's or PATH".into()),
            );
        }
        if !self.wanted {
            return (
                "off".into(),
                Some("the box's policy for this machine".into()),
            );
        }
        if let Some(r) = &self.running {
            let has_banner = r
                .banner
                .lock()
                .map(|b| b.environment_id.is_some())
                .unwrap_or(false);
            if has_banner || r.since.elapsed() > Duration::from_secs(30) {
                return ("running".into(), None);
            }
            return ("starting".into(), None);
        }
        if let Some(at) = self.next_start {
            let left = at.saturating_duration_since(Instant::now());
            let last = self
                .recent_lines
                .lock()
                .ok()
                .and_then(|r| r.back().cloned())
                .unwrap_or_default();
            let detail = if last.is_empty() {
                format!("retrying in {}", short_duration(left))
            } else {
                format!("retrying in {} · last line: {last}", short_duration(left))
            };
            return ("waiting".into(), Some(detail));
        }
        ("stopped".into(), self.last_exit.clone())
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop("tray leaving");
    }
}

fn open_log(path: &Path) -> std::io::Result<File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(path).is_ok_and(|m| m.len() > LOG_ROTATE_BYTES) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    OpenOptions::new().create(true).append(true).open(path)
}

fn short_duration(d: Duration) -> String {
    let s = d.as_secs();
    if s < 60 {
        format!("{s} s")
    } else if s < 3600 {
        format!("{} min", s / 60)
    } else {
        format!("{} h {} min", s / 3600, (s % 3600) / 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The path find_cli returned is the whole of what names the install
    // method, so these are the shapes it actually returns on each OS.
    #[test]
    fn the_install_method_is_read_off_the_path() {
        let m = |p: &str| install_method(Path::new(p));
        assert_eq!(m("/home/u/.local/bin/claude"), "native");
        assert_eq!(m("C:\\Users\\u\\.local\\bin\\claude.exe"), "native");
        assert_eq!(m("/home/u/.local/share/claude/versions/2.1.281"), "native");
        assert_eq!(m("C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd"), "npm");
        assert_eq!(
            m("/usr/lib/node_modules/@anthropic-ai/claude-code/claude"),
            "npm"
        );
        assert_eq!(m("/opt/homebrew/bin/claude"), "homebrew");
        // Anything else is still updatable by `claude update`; it just has
        // no name, and the page says nothing rather than guessing.
        assert_eq!(m("/usr/local/bin/claude"), "path");
    }

    // Every branch of the update record has to produce something a person
    // can read, including the one where the command said nothing at all.
    #[test]
    fn the_last_meaningful_line_is_what_gets_reported() {
        assert_eq!(
            last_meaningful(
                "Checking for updates...\nSuccessfully updated from 2.1.276 to version 2.1.281\n\n"
            ),
            "Successfully updated from 2.1.276 to version 2.1.281"
        );
        assert_eq!(
            last_meaningful("Claude is up to date!"),
            "Claude is up to date!"
        );
        assert_eq!(last_meaningful("   \n\n  "), "no output");
        assert_eq!(last_meaningful(""), "no output");
        assert_eq!(last_meaningful(&"x".repeat(400)).len(), 200);
    }

    #[test]
    fn banner_lines_set_their_fields() {
        let mut b = Banner::default();
        for l in [
            "Remote Control v2.1.276",
            "Spawn mode: same-dir",
            "Max concurrent sessions: 4",
            "Environment ID: env_01ABC",
            "[12:00:01] some event",
        ] {
            b.note(l);
        }
        assert_eq!(b.version.as_deref(), Some("2.1.276"));
        assert_eq!(b.spawn_mode.as_deref(), Some("same-dir"));
        assert_eq!(b.max_sessions, Some(4));
        assert_eq!(b.environment_id.as_deref(), Some("env_01ABC"));
    }

    #[test]
    fn version_line() {
        assert_eq!(
            parse_version("2.1.276 (Claude Code)").as_deref(),
            Some("2.1.276")
        );
        assert_eq!(parse_version("Claude Code 2.1.276"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn profile_readers_tolerate_absence_and_copy_by_name() {
        let dir = std::env::temp_dir().join(format!("daedalus-claude-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sessions")).unwrap();
        assert!(!read_credentials(&dir).present);
        assert!(read_sessions(&dir).is_empty());

        std::fs::write(
            dir.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"secret","refreshToken":"secret","subscriptionType":"max","rateLimitTier":"t","expiresAt":1,"refreshTokenExpiresAt":2}}"#,
        )
        .unwrap();
        let c = read_credentials(&dir);
        assert!(c.present);
        assert_eq!(c.subscription_type.as_deref(), Some("max"));
        assert_eq!(c.refresh_expires_at, Some(2));
        let json = serde_json::to_string(&c).unwrap();
        assert!(!json.contains("secret"));

        std::fs::write(
            dir.join("settings.json"),
            r#"{"model":"opus","effortLevel":"high"}"#,
        )
        .unwrap();
        assert_eq!(read_settings(&dir).model.as_deref(), Some("opus"));

        let me = std::process::id();
        std::fs::write(
            dir.join("sessions").join("a.json"),
            format!(
                r#"{{"pid":{me},"sessionId":"u","cwd":"/x","name":"n","kind":"interactive","startedAt":5,"updatedAt":6,"status":"idle","statusUpdatedAt":7,"bridgeSessionId":"session_1"}}"#
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("sessions").join("b.json"),
            r#"{"pid":4000000000,"sessionId":"v","startedAt":9}"#,
        )
        .unwrap();
        let s = read_sessions(&dir);
        assert_eq!(s.len(), 2);
        assert!(s[0].alive, "own pid is alive and sorts first");
        assert_eq!(s[0].remote_id.as_deref(), Some("session_1"));
        assert_eq!(s[0].last_activity_at, Some(7));
        assert!(!s[1].alive);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn picks_the_latest_trusted_project_and_never_home() {
        let cfg = r#"{"projects":{
            "/home/u":{"hasTrustDialogAccepted":true,"lastStartTime":"2026-09-22T10:00:00Z"},
            "/home/u/old":{"hasTrustDialogAccepted":true,"lastStartTime":"2026-09-01T00:00:00Z"},
            "/home/u/new":{"hasTrustDialogAccepted":true,"lastStartTime":"2026-09-20T00:00:00Z"},
            "/home/u/gone":{"hasTrustDialogAccepted":true,"lastStartTime":"2026-09-21T00:00:00Z"},
            "/home/u/untrusted":{"hasTrustDialogAccepted":false,"lastStartTime":"2026-09-22T00:00:00Z"}
        }}"#;
        let exists = |p: &Path| p != Path::new("/home/u/gone");
        assert_eq!(
            trusted_project_in(cfg, Some(Path::new("/home/u")), exists),
            Some(PathBuf::from("/home/u/new"))
        );
        assert_eq!(trusted_project_in("{}", None, |_| true), None);
        assert_eq!(trusted_project_in("not json", None, |_| true), None);
    }

    #[test]
    fn supervisor_without_a_cli_reports_it() {
        // No `claude` on the test machine's PATH is the common case; when
        // there is one, the state is whatever it is and this test says so.
        let sup = Supervisor::new(
            Some(std::env::temp_dir().display().to_string()),
            std::env::temp_dir().join("daedalus-claude-test.log"),
            false,
        );
        let r = sup.report();
        assert!(r.state == "not-installed" || r.state == "off");
        assert_eq!(
            r.summary().sessions,
            r.sessions.iter().filter(|s| s.alive).count()
        );
    }
}
