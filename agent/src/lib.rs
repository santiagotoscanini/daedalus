//! daedalus-agent — the box's presence on a machine it does not run.
//!
//! A Windows service (a launchd daemon on macOS, a systemd service on
//! Linux) that holds the machine awake for as long as the box wants it to,
//! keeps one connection to the controller, the box's own agent (link/),
//! following the policy it carries, answers the tray, the session and the
//! verbs on a local socket that knows its callers (local.rs; nothing on the
//! network, loopback included), samples the machine's telemetry, and
//! updates itself to the
//! newest `agent-v*` release of the engine repository; a session that —
//! with the user's own login — runs `claude remote-control` the way the box
//! runs its own (claude/); and a tray that shows what the service reports.
//!
//! Two executables from this crate (no `.exe` on macOS and Linux):
//!
//!   daedalus-agent.exe        the service and its verbs (src/bin/daedalus-agent.rs)
//!   daedalus-agent-tray.exe   the tray icon (src/bin/daedalus-agent-tray.rs; feature `tray`)
//!
//! Where each lands on the machine, with its config, state and logs:
//! agent/README.md, "On the machine".
//!
//! Three roles, three modules: the service (service/), the
//! `session` — Claude Code supervised and reported to the service, with no
//! UI — and the `tray`, a UI over the session. The tray runs the session on
//! Windows and macOS; on Linux the session is a user unit of its own
//! (`daedalus-agent session`) and the tray only shows it; on the controller
//! it is a thread of the service. Which parts run at all — a node or the
//! controller, whose local API socket (api/) is the app's door — is
//! role.rs's one table. Everything
//! that differs by OS is behind `os` (os/mod.rs lists the surface); nothing
//! else in the crate tests the target.

pub mod api;
pub mod claude;
pub mod config;
pub mod deadline;
pub mod discover;
pub mod dns;
pub mod door;
// Logging in to the box for a tunnel of this machine's own (tunnel/).
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod enroll;
pub mod exec;
pub mod facts;
pub mod http;
pub mod identity;
pub mod jobs;
pub mod jsonl;
pub mod link;
pub mod local;
pub mod logging;
pub mod metrics_page;
pub mod net;
pub mod os;
pub mod pair;
pub mod paths;
pub mod power;
pub mod private;
pub mod procfs;
pub mod providers;
pub mod role;
pub mod root;
pub mod rpc;
#[cfg(unix)]
pub mod santree;
pub mod service;
pub mod session;
pub mod session_host;
pub mod settings;
pub mod shared;
pub mod state;
pub mod status;
pub mod telemetry;
pub mod time;
// The machine's own WireGuard tunnel to the box (macOS and Linux: none on
// Windows in this version).
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod tunnel;
pub mod update;
pub mod util;

// The app's TypeScript wire types, generated from the types above (a test).
#[cfg(test)]
mod ts;

// The tray draws with tray-icon (and GTK on Linux): the `tray` feature.
#[cfg(feature = "tray")]
pub mod tray;

pub const SERVICE_NAME: &str = "daedalus-agent";
pub const DISPLAY_NAME: &str = "Daedalus Agent";
pub use os::TRAY_EXE;
/// This build's version: the crate's, with `+<build id>` on a build that is
/// not a release (build.rs).
pub const VERSION: &str = env!("DAEDALUS_VERSION");
