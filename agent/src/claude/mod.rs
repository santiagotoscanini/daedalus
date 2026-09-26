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
//!
//! Where each part lives: this file holds the report's types; `cli` finds
//! the `claude` command and runs it (version probe, `claude update`),
//! `profile` reads `~/.claude` (sessions, credential clock, settings),
//! `workdir` picks the directory the server runs in, and `supervisor`
//! keeps the server running.

mod cli;
mod profile;
mod supervisor;
mod workdir;

pub use cli::{cli_version, find_cli, install_method, parse_version, Ran};
pub use profile::{claude_dir, home_dir, read_credentials, read_sessions, read_settings};
pub use supervisor::Supervisor;
pub use workdir::{most_recent_trusted_project, pick_workdir};

use serde::{Deserialize, Serialize};

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
