//! Claude Code on this machine: found, supervised, reported.
//!
//! The box's controller runs `claude remote-control` as a transient user
//! unit of the operator (`unit`, nix/stacks/daedalus/controller.nix), so a
//! session on it can be opened from claude.ai/code or a phone at any time.
//! This is the same thing on a node, with the one difference the OS forces:
//! Claude Code's login lives in the user's profile (`~/.claude`), and the
//! service is not that user — it is LocalSystem in session 0 on Windows,
//! root on macOS. So the SESSION (session.rs, which the tray runs)
//! supervises the server, in the desktop session with the user's
//! credentials, and reports to the service over its local socket
//! (`claude.report`, local.rs). The service keeps the full
//! report for the `claude` method and the link, puts a summary on the status page,
//! and hands the session back what the box decided: whether the
//! server should run at all and where (policy), and its two instructions —
//! update Claude Code, and restart the server.
//!
//! Those two are deliberately separate. An update installs a new CLI beside
//! the running one and interrupts nothing: a session keeps the binary it
//! started on and picks the new one up whenever it next starts, which is
//! upstream's own model. A restart is what moves the RUNNING server onto
//! it, and it ends every session under it — which the agent then resumes by
//! itself once the server is back (`recovery`), so the cost is a minute's
//! interruption, not the sessions. One instruction for both would still
//! make the free act cost the expensive one.
//!
//! What is reported: the server's start banner (version, environment id,
//! spawn mode, session ceiling), the sessions in `~/.claude/sessions/*.json`
//! and whether each process is alive, the sessions the last recovery
//! resumed, the credential CLOCK (the plan and two dates — never a token),
//! and the model settings. The server's output goes to `claude-rc.log` in
//! `paths::user_log_dir`.
//!
//! None of the environment variables that disable Remote Control are set
//! (DISABLE_TELEMETRY, DO_NOT_TRACK, ANTHROPIC_BASE_URL and friends —
//! nix/stacks/daedalus/controller.nix lists them); a job gets the user's
//! environment as the OS gives it one, plus
//! `CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE`, HOME, PATH and
//! CLAUDE_CONFIG_DIR (jobs/ `job_env`, `os::jobs::server_env`).
//!
//! On every OS the server and each resumed session are jobs of the OS, not
//! children of the agent (jobs/): a systemd user unit on Linux and the
//! controller, a launchd job on macOS, a detached process on Windows. An
//! agent update or restart — or quitting the tray — never ends a Claude
//! session, and the next start re-attaches.
//!
//! Where each part lives: this file holds the report's types; `cli` finds
//! the `claude` command and probes its version (exec.rs runs it, as it
//! runs `claude update`), `profile` reads `~/.claude` (sessions, credential
//! clock, settings), `workdir` picks the directory the server runs in,
//! jobs/ is what a job is on each OS (the calls are `os::jobs`), and
//! `supervisor` keeps the server running. The sessions beside the server:
//! `roster` reads every one this machine could still be asked about,
//! `sessions` holds the three verbs on them (resume, stop, remove) and the
//! thread that runs them, `recovery` keeps the sessions to resume after the
//! server restarts, `gcroot` keeps a nix-installed `claude` from the
//! garbage collector while a job runs it, and `redact` makes the one line
//! of conversation the roster carries safe to carry. `logs` rotates the
//! logs the jobs append to while they are open.

mod cli;
pub mod gcroot;

pub mod logs;
mod profile;
pub mod recovery;
pub mod redact;
pub mod roster;
pub mod sessions;
mod supervisor;
mod workdir;

pub use recovery::Recovery;
pub use roster::Roster;
pub use sessions::Sessions;
pub use supervisor::Supervisor;

/// The three verbs on one session (sessions.rs).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionAction {
    /// `claude --resume <uuid>` in a job of its own.
    Resume,
    /// End a session this agent resumed, or a running background agent.
    Stop,
    /// `claude rm <short id>`: a background agent's record.
    Remove,
}

impl SessionAction {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionAction::Resume => "resume",
            SessionAction::Stop => "stop",
            SessionAction::Remove => "remove",
        }
    }
}

/// How a verb request stands.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionState {
    Running,
    Done,
    /// Not done, and nothing changed: the request was not one to carry out.
    Refused,
    /// Tried, and it did not work.
    Failed,
}

/// One verb request, as the service hands it to the session: minted where
/// it was accepted (`request`, sixteen hex characters), checked there and
/// again by the session before anything runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRequest {
    pub request: String,
    pub action: SessionAction,
    /// The selector: a session uuid, or a background agent's short id.
    pub id: String,
}

use serde::{Deserialize, Serialize};

/// What `claude remote-control` prints about itself at start, once.
#[cfg_attr(test, derive(ts_rs::TS))]
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
    /// rest are ignored. Prefixes are literal.
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
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
    /// What the login may do (`user:inference`, …), from the same file.
    pub scopes: Vec<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
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

/// What the session tells the service, and what the status
/// page shows.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
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
    /// off (not wanted, whatever else is true) | not-installed (wanted, no
    /// `claude`) | starting | running | waiting | stopped
    pub state: String,
    /// One line more, when the state has a reason.
    pub detail: Option<String>,
    /// What the server printed last, while it waits to be started again
    /// (`waiting`): its own words, which can name a path, so the summary
    /// leaves them out. Absent from the wire when there is none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_line: Option<String>,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    /// Starts after the first, since the session came up.
    pub restarts: u32,
    pub last_exit: Option<String>,
    pub server: Banner,
    pub sessions: Vec<Session>,
    /// What the last automatic recovery did, one row per session it tried
    /// (recovery.rs); empty until one ran.
    pub recovered: Vec<Recovered>,
    pub credentials: Credentials,
    pub settings: Settings,
    /// The account the server runs as, and the profile it reads.
    pub user: Option<String>,
    pub home: Option<String>,
    pub workdir: Option<String>,
    /// How the directory was chosen: "named", "most recent trusted project", or the home fallback.
    pub workdir_via: Option<String>,
    pub log: Option<String>,
    /// The server's job: a unit's name, a launchd label's last part, a
    /// detached process's record (jobs/).
    pub job: Option<String>,
    pub reported_at: String,
}

/// One session the automatic recovery tried to resume, and how it went.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recovered {
    pub id: String,
    pub result: ActionState,
    /// What was done, or why not, in the agent's sentence.
    pub detail: String,
    pub at: String,
}

/// The part of the report the status page and the controller's
/// `nodes.list` carry: enough for a card and a picker — no session names,
/// paths or ids, no environment id, no account facts. The full report is
/// `/claude` on loopback and the link's `claude` push.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Summary {
    pub state: String,
    /// The state's reason (never the server's own words: `last_line`).
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
            detail: self.detail.clone(),
            cli_version: self.cli_version.clone(),
            server_version: self.server.version.clone(),
            sessions: self.sessions.iter().filter(|s| s.alive).count(),
            started_at: self.started_at.clone(),
            signed_in: self.credentials.present,
        }
    }
}

/// What the service answers a report with: the session's part of the box's
/// policy and its two instructions, each cleared as it goes out.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ReportAnswer {
    /// Whether the server should be running at all.
    pub wanted: bool,
    /// Update Claude Code now, once. Interrupts nothing (see the module doc).
    pub update: bool,
    /// Restart it now, once. Ends every session under the server.
    pub restart: bool,
    /// The directory the policy names for the server, if any.
    pub workdir: Option<String>,
    /// Verb requests for the sessions, each handed out once (sessions.rs).
    pub sessions: Vec<SessionRequest>,
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
