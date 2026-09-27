//! Which parts of the agent run on this machine, decided once from
//! config.toml's `mode` — the one place that says what a node and the
//! controller each run, so no other module asks which one it is.
//!
//! | part                                | node                          | controller                      |
//! |-------------------------------------|-------------------------------|---------------------------------|
//! | status page, telemetry, `/metrics`  | yes, on the LAN               | yes, on loopback only           |
//! | the local API socket (api/)         | no                            | yes — the app's one door        |
//! | hello to the box                    | yes                           | no — it is the box              |
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
//! terminal) holding the status page, telemetry, the session and the
//! socket the app talks to; the machines' connections arrive with it later
//! (PLAN, feature 13). What it offers the app is derived from this table
//! and the config (`api::capabilities`), never from the OS.

use anyhow::{bail, Result};
use serde::Serialize;

use crate::config::Mode;

/// The parts that run, per the table above.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Role {
    pub mode: Mode,
    /// Announce this machine to the box every `hello_secs`.
    pub hello: bool,
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
    /// The status page answers the LAN; otherwise loopback only.
    pub status_on_lan: bool,
    /// The local API socket is served (api/).
    pub api_socket: bool,
}

impl Role {
    pub const fn of(mode: Mode) -> Self {
        match mode {
            Mode::Node => Self {
                mode,
                hello: true,
                self_update: true,
                keep_awake: true,
                installer: true,
                session: true,
                session_in_service: false,
                claude_update: true,
                tray: true,
                status_on_lan: true,
                api_socket: false,
            },
            Mode::Controller => Self {
                mode,
                hello: false,
                self_update: false,
                keep_awake: false,
                installer: false,
                session: true,
                session_in_service: true,
                claude_update: false,
                tray: false,
                status_on_lan: false,
                api_socket: true,
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

    /// Where the status page listens: every interface on a node, loopback
    /// on the controller, whose door is the socket.
    pub fn status_address(&self) -> &'static str {
        if self.status_on_lan {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_node_runs_everything_and_the_controller_leaves_nix_its_part() {
        let node = Role::of(Mode::Node);
        assert!(node.hello && node.self_update && node.keep_awake && node.installer);
        assert!(node.session && node.tray && node.claude_update && node.status_on_lan);
        assert!(!node.session_in_service && !node.api_socket);
        assert_eq!(node.status_address(), "0.0.0.0");
        assert!(node.allow_install("install").is_ok());

        let c = Role::of(Mode::Controller);
        assert!(!c.hello && !c.self_update && !c.keep_awake && !c.installer && !c.tray);
        assert!(!c.claude_update && !c.status_on_lan);
        assert!(c.session && c.session_in_service && c.api_socket);
        assert_eq!(c.status_address(), "127.0.0.1");
        let e = c.allow_install("uninstall").unwrap_err().to_string();
        assert!(e.contains("controller mode") && e.contains("nix"), "{e}");
    }
}
