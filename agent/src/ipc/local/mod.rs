//! The agent's local door: one socket on the machine for the tray, the
//! session and the verbs (`daedalus-agent status`, `claude restart`) — a
//! unix socket on macOS and Linux, a named pipe on Windows — that knows who
//! is calling. The kernel names the peer and the service decides; nothing
//! listens on TCP for them, so loopback is no longer a credential.
//!
//! **Where.** `paths::local_socket()`: `<data_dir>/run/agent.sock` on
//! macOS and Linux, in a directory the service makes 0711 (root's on a
//! node, the operator's on the controller) with the socket 0666 — the file
//! modes let every local user reach it and the peer check below is the
//! gate; `\\.\pipe\daedalus-agent` on Windows, whose DACL grants SYSTEM and
//! the interactive users read and write-data (never the right to create a
//! second instance of the pipe) and which refuses remote clients. A
//! development run (`DAEDALUS_AGENT_DATA_DIR`) gets a pipe of its own, as
//! it gets its own Claude unit.
//!
//! **Who** (door.rs `peer_allowed`, the OS's `local_allowed`): on macOS and
//! Linux, root, the agent's own uid, and the user the machine runs Claude
//! for — on Linux the session user `install` recorded (`session.json`), on
//! macOS the user at the console (the owner of `/dev/console`); on Windows,
//! SYSTEM and the users logged on interactively (each session's token),
//! read from the client's process token. Anyone else gets one `forbidden`
//! error and a closed connection. The client checks the other end too
//! (door.rs `server_trusted`): root or SYSTEM, or its own user (a
//! development run), so a pipe squatted while the service is down cannot
//! hand the session orders.
//!
//! **Protocol.** The agent's one envelope (rpc.rs), one request per
//! connection, at most `MAX_LINE` bytes a line: `{"id":1,"m":"<method>","p":…}`
//! → `{"id":1,"ok":…}` or `{"id":1,"err":{"code","msg"}}`, then the service
//! closes. The whole exchange has `DEADLINE`; at most `MAX_CONNECTIONS` are
//! served at once. Both ends are this binary, so the envelope moves with it.
//!
//! | method           | takes            | answers                                        |
//! |------------------|------------------|------------------------------------------------|
//! | `status`         | —                | the status document (status.rs)                 |
//! | `claude`         | —                | the session's full report, or null             |
//! | `claude.report`  | a `Report`       | the `ReportAnswer` (the session's poll)        |
//! | `claude.roster`  | a `Roster`       | null                                           |
//! | `claude.restart` | —                | a sentence; the session restarts the server    |
//! | `claude.update`  | —                | a sentence; refused where nix pins Claude      |
//! | `update.check`   | —                | a sentence; the updater looks now              |
//! | `link.reload`    | —                | a sentence; the link reads config.toml again   |
//! | `enroll.begin`   | `{app_url}`      | a log-in begun: key, fingerprint, challenge    |
//! | `enroll.finish`  | `{code}`         | a sentence; redeemed, tunnel up (root alone)   |
//! | `enroll.leave`   | —                | a sentence; logged out                         |
//! | `settings.get`   | —                | the settings, and whether this peer may change them |
//! | `settings.set`   | `{key, value}`   | `{sent}`, `{unchanged}` or `{confirm_url}` (the operator) |
//!
//! The report and the roster are the session's to post; any peer the gate
//! lets through may, since each of those is a user the machine runs Claude
//! for (or root). Nothing on this socket names the controller a machine
//! trusts: pairing is `pair` run as an administrator (pair.rs) — the tray
//! runs it elevated, behind the OS's own prompt — which writes config.toml
//! itself and asks `link.reload`, harmless to anyone (it reads a file only
//! root or SYSTEM can write, and changes nothing unless the keys did). A
//! pairing method here would let any user the socket serves hand a fresh
//! machine, and with it the service's privileges, to a controller of their
//! own. A log-in's last step does name it (`enroll.finish`, macOS and Linux,
//! enroll.rs), which is why it is root's alone: the tray runs it behind the
//! administrator prompt.
//!
//! A machine's own settings (settings.rs) are read by any peer the gate
//! admits, and changed only by the operator — the user santree's socket
//! serves (`os::operator_allowed`) — on macOS and Linux; on Windows, by
//! the users the socket admits, for the two settings there. Changing one
//! asks the box; santree ON sends nothing and answers the page where an
//! admin confirms it, which the caller opens.

mod client;
mod server;

pub use client::{call, call_at, call_within, CallError};
pub use server::{policy, refusal, serve, service_policy, Door, BIND_RETRY};

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::claude::{Report, Roster};
use crate::ipc::rpc::methods;

/// The whole exchange, from connect to the answer: room for the slowest
/// method, a log-in's redeem at the app (enroll.rs `REDEEM_TIMEOUT`).
pub const DEADLINE: Duration = Duration::from_secs(15);
/// A client's whole exchange: short, since the session asks every poll
/// and a tray's clicks wait behind it.
pub const CLIENT_DEADLINE: Duration = Duration::from_secs(2);
/// Connections served at once.
pub const MAX_CONNECTIONS: usize = 16;

methods! {
    /// The local socket's methods (module doc's table): a unit variant takes
    /// no parameters. The service reads a request as this, and a client
    /// writes one (`call`).
    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub enum LocalRequest {
        "status" => Status,
        "claude" => Claude,
        "claude.report" => ClaudeReport(Box<Report>),
        "claude.roster" => ClaudeRoster(Box<Roster>),
        "claude.restart" => ClaudeRestart,
        "claude.update" => ClaudeUpdate,
        "update.check" => UpdateCheck,
        "link.reload" => LinkReload,
        "enroll.begin" => EnrollBegin(BeginParams),
        "enroll.finish" => EnrollFinish(FinishParams),
        "enroll.leave" => EnrollLeave,
        "settings.get" => SettingsGet,
        "settings.set" => SettingsSet(SetParams),
    }
}

/// `enroll.begin`'s parameters: the app the operator named.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BeginParams {
    pub app_url: String,
}

/// `enroll.finish`'s parameters: the code the loopback took.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinishParams {
    pub code: String,
}

/// One method for the service's shared state (module doc's table), asked

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetParams {
    pub key: crate::node::settings::Key,
    pub value: bool,
}

/// `settings.set`'s answer: exactly one of the three is present.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct SetAnswer {
    /// Recorded; the link asks the box now.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sent: bool,
    /// The box already holds that value.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unchanged: bool,
    /// santree ON: the page where an admin confirms it, for the caller to
    /// open (the service opens no browser).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_url: Option<String>,
}

#[cfg(test)]
mod tests;
