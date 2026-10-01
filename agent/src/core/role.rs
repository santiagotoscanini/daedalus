//! Which parts of the agent run on this machine, decided once from
//! config.toml's `mode` — the one place that says what a node and the
//! controller each run, so no other module asks which one it is.
//!
//! | part                                | node                          | controller                      |
//! |-------------------------------------|-------------------------------|---------------------------------|
//! | the local socket (ipc/local/), telemetry | yes                        | yes                             |
//! | metrics page (`/healthz`, `/nodes/metrics`) | no — a node listens on nothing | yes, on every interface |
//! | the local API socket (controller/api/)         | no                            | yes — the app's one door        |
//! | link to the controller (node/link.rs) | yes                         | no — it is the controller       |
//! | listener for the machines' links    | no                            | yes, where `listen` names one   |
//! | self-update (`updates`)             | yes                           | no — nix moves it with the lock |
//! | keep-awake hold (the box's policy)  | yes                           | no — a server does not sleep    |
//! | `install` / `uninstall`             | yes                           | refused — nix manages it        |
//! | session: Claude remote control      | yes, in the tray or its unit  | yes, inside the service         |
//! | updating Claude Code (`claude update`) | yes, when the box asks     | no — nix pins it on the box     |
//! | tray                                | where there is a desktop      | no                              |
//!
//! A node is every machine that joins the network: Windows, macOS, or a
//! Linux desktop or server (the root service, the `session` user unit, and
//! on an x86_64 desktop the tray). The controller is the box itself —
//! NixOS by definition — running the same Linux code as its own user,
//! built, configured and moved by nix: ONE process (`run`, or `serve` in a
//! terminal) holding the metrics page, telemetry, the session and the
//! socket the app talks to, and the listener the machines' links reach
//! (link/). What it offers the app is derived from this table
//! and the config (`api::capabilities`), never from the OS.

use anyhow::{bail, Result};
use serde::Serialize;

use crate::core::config::Mode;

/// The parts that run, per the table above.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Role {
    pub mode: Mode,
    /// Keep the link to the controller (node/link.rs).
    pub link: bool,
    /// Look for, and (per `updates`) install, newer releases.
    pub self_update: bool,
    /// Hold the machine awake while the box's policy says so.
    pub keep_awake: bool,
    /// `install` and `uninstall` may register the service here.
    pub installer: bool,
    /// The session supervises Claude remote control.
    pub session: bool,
    /// The session runs inside the service's own process rather than in a
    /// tray or a user unit of its own.
    pub session_in_service: bool,
    /// Claude Code may be updated by the agent (`claude update`).
    pub claude_update: bool,
    /// A tray may run (where the OS has one and a desktop is present).
    pub tray: bool,
    /// The metrics page answers on every interface's `port`: `/healthz`
    /// and `/nodes/metrics` (metrics_page.rs) — the box's Prometheus container
    /// reaches it through pasta's host alias, and the host firewall keeps
    /// the port closed to the LAN. A node has no page: it listens on
    /// nothing, loopback included.
    pub metrics_page: bool,
    /// The local API socket is served (controller/api/).
    pub api_socket: bool,
    /// The machines' links are accepted (controller/link/), where
    /// `[controller] listen` names an address.
    pub node_listener: bool,
}

impl Role {
    pub const fn of(mode: Mode) -> Self {
        match mode {
            Mode::Node => Self {
                mode,
                link: true,
                self_update: true,
                keep_awake: true,
                installer: true,
                session: true,
                session_in_service: false,
                claude_update: true,
                tray: true,
                metrics_page: false,
                api_socket: false,
                node_listener: false,
            },
            Mode::Controller => Self {
                mode,
                link: false,
                self_update: false,
                keep_awake: false,
                installer: false,
                session: true,
                session_in_service: true,
                claude_update: false,
                tray: false,
                metrics_page: true,
                api_socket: true,
                node_listener: true,
            },
        }
    }

    /// `install` and `uninstall` stop here on the controller.
    pub fn allow_install(&self, verb: &str) -> Result<()> {
        if !self.installer {
            bail!(
                "`{verb}` refuses in controller mode: nix manages this machine (config.toml says mode = \"controller\")"
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_node_runs_everything_and_the_controller_leaves_nix_its_part() {
        let node = Role::of(Mode::Node);
        assert!(node.link && node.self_update && node.keep_awake && node.installer);
        assert!(node.session && node.tray && node.claude_update);
        assert!(!node.session_in_service && !node.api_socket && !node.node_listener);
        assert!(!node.metrics_page);
        assert!(node.allow_install("install").is_ok());

        let c = Role::of(Mode::Controller);
        assert!(!c.link && !c.self_update && !c.keep_awake && !c.installer && !c.tray);
        assert!(!c.claude_update && c.metrics_page);
        assert!(c.session && c.session_in_service && c.api_socket && c.node_listener);
        let e = c.allow_install("uninstall").unwrap_err().to_string();
        assert!(e.contains("controller mode") && e.contains("nix"), "{e}");
    }
}
