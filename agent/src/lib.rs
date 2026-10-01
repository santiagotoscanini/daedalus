//! daedalus-agent — the box's presence on a machine it does not run.
//!
//! A Windows service (a launchd daemon on macOS, a systemd service on
//! Linux) that holds the machine awake for as long as the box wants it to,
//! keeps one connection to the controller, the box's own agent (node/link.rs),
//! following the policy it carries, answers the tray, the session and the
//! verbs on a local socket that knows its callers (ipc/local/; nothing on
//! the network, loopback included), samples the machine's telemetry, and
//! updates itself to the newest `agent-v*` release of the engine repository; a session that —
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
//! controller, whose local API socket (controller/api/) is the app's door —
//! is core/role.rs's one table. The modules below are grouped by that:
//! the roles, what they stand on (core/, ipc/), each side's own (node/,
//! controller/), what both share, and the machine underneath. Everything
//! that differs by OS is behind `os` (os/mod.rs lists the surface); nothing
//! else in the crate tests the target.

// The roles: the service, the Claude session, the tray (the `tray`
// feature: tray-icon, and GTK on Linux).
pub mod service;
pub mod session;
#[cfg(feature = "tray")]
pub mod tray;

// What every part stands on, and how the parts talk on the machine.
pub mod core;
pub mod ipc;

// A node's side of the box, and the controller's — the `controller`
// feature, which only the box's build carries.
#[cfg(feature = "controller")]
pub mod controller;
pub mod node;

// Both sides': the link's protocol, the app↔controller contract, Claude
// Code, the machine's telemetry.
pub mod api;
pub mod claude;
pub mod link;
pub mod telemetry;

// The machine underneath: its OS (os/), processes, network and keys.
pub mod discover;
pub mod dns;
pub mod exec;
pub mod http;
pub mod identity;
pub mod jobs;
pub mod net;
pub mod os;
pub mod private;
pub mod procfs;
pub mod time;
pub mod util;

#[cfg(all(feature = "controller", not(target_os = "linux")))]
compile_error!("the controller runs on the box: the `controller` feature builds for Linux only");

// The app's TypeScript wire types, generated from the types above (a test
// of the controller's build: the contract's constants are the server's).
#[cfg(all(test, feature = "controller"))]
mod ts;

pub const SERVICE_NAME: &str = "daedalus-agent";
pub const DISPLAY_NAME: &str = "Daedalus Agent";
pub use os::TRAY_EXE;
/// This build's version: the crate's, with `+<build id>` on a build that is
/// not a release (build.rs).
pub const VERSION: &str = env!("DAEDALUS_VERSION");
