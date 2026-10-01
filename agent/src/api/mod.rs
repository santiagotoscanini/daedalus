//! The app↔controller contract: the API's wire types (wire.rs, from which
//! the app's TypeScript is generated), the version both ends speak, and
//! what an agent offers (`capabilities`) — shared by the controller that
//! serves it (controller/api/) and every machine, whose hello names its
//! capabilities to the controller (node/link.rs).

pub mod wire;

use crate::core::config::{Config, TelemetryLevel};
use wire::Capability;

/// The API version this agent speaks.
pub const API_VERSION: u32 = 1;

/// What the controller serves beyond its config, as it starts: machines
/// (`[controller] listen`), a session host it follows, its own link key.
/// A node serves none of them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Serves {
    pub nodes: bool,
    pub santree: bool,
    pub keys: bool,
}

/// What this agent offers the app, from its role and config
/// (controller/api/mod.rs, **Capabilities**).
pub fn capabilities(cfg: &Config, serves: Serves) -> Vec<Capability> {
    let role = cfg.role();
    let mut c = Vec::new();
    // A node runs Claude as the box's policy says; the controller only
    // when nix turned it on — never offered while it cannot run.
    let claude = match role.mode {
        crate::core::config::Mode::Node => true,
        crate::core::config::Mode::Controller => cfg.controller.claude_remote_control,
    };
    if role.session && claude {
        c.push(Capability::ClaudeRemoteControl);
        if role.claude_update {
            c.push(Capability::ClaudeUpdate);
        }
        c.push(Capability::ClaudeSessions);
    }
    match cfg.telemetry {
        TelemetryLevel::Full => c.push(Capability::TelemetryFull),
        TelemetryLevel::Minimal => c.push(Capability::TelemetryMinimal),
        TelemetryLevel::Off => {}
    }
    // A node reads its providers and drives their residency for the box.
    if role.link {
        c.push(Capability::ProvidersResidency);
    }
    if serves.nodes && role.node_listener {
        c.push(Capability::Nodes);
    }
    // The root helper answers only the controller (root/mod.rs), and only
    // where nix named its socket.
    if role.api_socket && cfg.controller.root_socket.is_some() {
        c.push(Capability::Root);
    }
    if role.api_socket && serves.santree {
        c.push(Capability::Santree);
    }
    if role.api_socket && serves.keys {
        c.push(Capability::Controller);
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_come_from_the_role_and_the_config() {
        let cfg = |text: &str| toml::from_str::<Config>(text).unwrap();
        let nodes = Serves {
            nodes: true,
            ..Serves::default()
        };
        let capabilities = |cfg: &Config, serves: Serves| -> Vec<String> {
            super::capabilities(cfg, serves)
                .iter()
                .map(ToString::to_string)
                .collect()
        };
        assert_eq!(
            capabilities(&cfg(""), Serves::default()),
            [
                "claude.remote_control",
                "claude.update",
                "claude.sessions",
                "telemetry.full",
                "providers.residency"
            ]
        );
        // A node never offers `nodes`, whatever it is told.
        assert_eq!(
            capabilities(&cfg("telemetry = \"off\""), nodes),
            [
                "claude.remote_control",
                "claude.update",
                "claude.sessions",
                "providers.residency"
            ]
        );
        // The controller offers Claude only when nix turned it on, and never
        // `claude.update`: nix pins Claude there.
        let on = "mode = \"controller\"\n[controller]\nclaude_remote_control = true\n";
        assert_eq!(
            capabilities(&cfg(on), Serves::default()),
            ["claude.remote_control", "claude.sessions", "telemetry.full"]
        );
        assert_eq!(
            capabilities(&cfg("mode = \"controller\""), Serves::default()),
            ["telemetry.full"]
        );
        assert_eq!(
            capabilities(
                &cfg("mode = \"controller\"\ntelemetry = \"minimal\""),
                nodes
            ),
            ["telemetry.minimal", "nodes"]
        );
        assert_eq!(
            capabilities(
                &cfg(&format!("telemetry = \"off\"\n{on}")),
                Serves::default()
            ),
            ["claude.remote_control", "claude.sessions"]
        );
        // `root` only on the controller, and only with the helper's socket.
        let root = "mode = \"controller\"\ntelemetry = \"off\"\n[controller]\nroot_socket = \"/run/r.sock\"\n";
        assert_eq!(capabilities(&cfg(root), Serves::default()), ["root"]);
        let node_root = "telemetry = \"off\"\n[controller]\nroot_socket = \"/run/r.sock\"\n";
        assert!(!capabilities(&cfg(node_root), Serves::default()).contains(&"root".to_string()));
        // `santree` and `controller` where the controller follows a session
        // host and holds its link key; a node offers neither.
        let all = Serves {
            nodes: true,
            santree: true,
            keys: true,
        };
        assert_eq!(
            capabilities(&cfg("mode = \"controller\"\ntelemetry = \"off\""), all),
            ["nodes", "santree", "controller"]
        );
        assert!(capabilities(&cfg("telemetry = \"off\""), all)
            .iter()
            .all(|c| c != "santree" && c != "controller"));
    }
}
