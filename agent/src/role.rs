//! Which parts of the agent run on this machine, decided once from
//! config.toml's `mode` — the one place that says what a node and the
//! controller each run, so no other module asks which one it is.
//!
//! | part                                | node                          | controller                      |
//! |-------------------------------------|-------------------------------|---------------------------------|
//! | status page, telemetry, `/metrics`  | yes                           | yes                             |
//! | hello to the box                    | yes                           | no — it is the box              |
//! | self-update (`updates`)             | yes                           | no — nix moves it with the lock |
//! | keep-awake hold (the box's policy)  | yes                           | no — a server does not sleep    |
//! | `install` / `uninstall`             | yes                           | refused — nix manages it        |
//! | session: Claude remote control      | yes                           | yes                             |
//! | tray                                | where there is a desktop      | no                              |
//!
//! A node is every machine that joins the network: Windows, macOS, or a
//! Linux desktop or server (the root service, the `session` user unit, and
//! on an x86_64 desktop the tray). The controller is the box itself —
//! NixOS by definition — running the same Linux code as its own user,
//! built, configured and moved by nix; its own row, the socket the app
//! talks to and the machines' connections arrive with it (PLAN, feature 13).

use anyhow::{bail, Result};

use crate::config::Mode;

/// The parts that run, per the table above.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
    /// A tray may run (where the OS has one and a desktop is present).
    pub tray: bool,
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
                tray: true,
            },
            Mode::Controller => Self {
                mode,
                hello: false,
                self_update: false,
                keep_awake: false,
                installer: false,
                session: true,
                tray: false,
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
        assert!(node.hello && node.self_update && node.keep_awake && node.installer);
        assert!(node.session && node.tray);
        assert!(node.allow_install("install").is_ok());

        let c = Role::of(Mode::Controller);
        assert!(!c.hello && !c.self_update && !c.keep_awake && !c.installer && !c.tray);
        assert!(c.session);
        let e = c.allow_install("uninstall").unwrap_err().to_string();
        assert!(e.contains("controller mode") && e.contains("nix"), "{e}");
    }
}
