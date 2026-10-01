//! What the service's threads share: one hub per concern, each with its own
//! lock — Claude's reports (claude.rs), the link to the controller
//! (link.rs), telemetry and the providers (machine.rs), the box's policy
//! and the settings asked of it (settings.rs), the updater's flags
//! (update.rs), the awake hold and santree's door (machine.rs), and the
//! persisted state (state.rs `StateStore`). `Shared` itself only holds
//! them, with what never changes once the service is up: the role, the
//! facts, this machine's key and, on the controller, its parts. The
//! pictures built from them — the status document and the settings view —
//! are status.rs's.

mod claude;
mod link;
mod machine;
mod settings;
mod update;

use std::sync::Arc;
use std::time::Instant;

use crate::core::facts::Facts;
use crate::core::role::Role;
use crate::core::state::{State, StateStore};
use crate::ipc::rpc::Events;
use crate::link::wire::Policy;
use crate::util::Shutdown;

pub use claude::{ClaudeHub, MAX_QUEUED_SESSIONS};
pub use link::{LeaveAnswer, LinkHub};
pub use machine::{PowerHub, ProvidersHub, SantreeCounters, SantreeOpen, TelemetryHub};
pub use settings::SettingsBook;
pub use update::UpdateState;

/// This machine's key, as the settings and santree name it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeKey {
    pub id: String,
    pub fingerprint: String,
}

/// The controller's own parts, built before the service's shared state:
/// its keys (controller/rotation.rs) and where machines reach it, the registry
/// of machines when it listens for them (controller/link/), and the
/// session host it follows (session_host.rs).
#[cfg(feature = "controller")]
pub struct ControllerParts {
    pub keys: Arc<crate::controller::rotation::Keys>,
    pub listen: Option<String>,
    pub advertise: Vec<String>,
    pub nodes: Option<Arc<crate::controller::link::Registry>>,
    pub session_host: Option<Arc<crate::controller::session_host::SessionHost>>,
}

#[cfg(feature = "controller")]
impl ControllerParts {
    /// The controller as `system.info` states it: the key going forward,
    /// the addresses, and a rotation under way (controller/rotation.rs).
    pub fn info(&self) -> crate::api::wire::ControllerInfo {
        let id = self.keys.forward();
        crate::api::wire::ControllerInfo {
            public_key: id.public_key_hex(),
            fingerprint: id.fingerprint(),
            listen: self.listen.clone(),
            advertise: self.advertise.clone(),
            rotation: self.keys.info(),
        }
    }
}

/// What the threads share (module doc).
pub struct Shared {
    pub started: Instant,
    pub facts: Facts,
    pub role: Role,
    /// The service's stop, which the hubs nudge when a worker should look
    /// at once (an update check, new link keys, a setting to send).
    pub stop: Shutdown,
    /// The API's subscribers (controller/api/): told when Claude's state or pid moves,
    /// when a telemetry sample lands, and — on the controller — when a
    /// machine connects, leaves or changes standing (controller/link/).
    pub events: Arc<Events>,
    /// This machine's key, once loaded (a node's; None on the controller).
    pub node: Option<NodeKey>,
    /// The controller's parts; None on a node.
    #[cfg(feature = "controller")]
    pub controller: Option<ControllerParts>,
    pub state: Arc<StateStore>,
    pub settings: Arc<SettingsBook>,
    pub claude: Arc<ClaudeHub>,
    pub telemetry: Arc<TelemetryHub>,
    pub providers: Arc<ProvidersHub>,
    pub link: Arc<LinkHub>,
    pub update: Arc<UpdateState>,
    pub power: Arc<PowerHub>,
    pub santree: Arc<SantreeCounters>,
}

impl Shared {
    /// The shared state for `role`, `policy` standing until the box says
    /// otherwise; `stop` is the service's.
    pub fn new(role: Role, facts: Facts, state: State, policy: Policy, stop: Shutdown) -> Self {
        Self {
            started: Instant::now(),
            facts,
            role,
            events: Arc::new(Events::default()),
            node: None,
            #[cfg(feature = "controller")]
            controller: None,
            state: Arc::new(StateStore::new(state)),
            settings: Arc::new(SettingsBook::new(policy, stop.clone())),
            claude: Arc::default(),
            telemetry: Arc::default(),
            providers: Arc::default(),
            link: Arc::new(LinkHub::new(stop.clone())),
            update: Arc::new(UpdateState::new(stop.clone())),
            power: Arc::default(),
            santree: Arc::default(),
            stop,
        }
    }

    /// With this machine's key (a node's, loaded before the service starts).
    pub fn with_node(mut self, node: NodeKey) -> Self {
        self.node = Some(node);
        self
    }

    /// With the controller's parts, built against this state's `events`.
    #[cfg(feature = "controller")]
    pub fn with_controller(mut self, parts: ControllerParts) -> Self {
        self.controller = Some(parts);
        self
    }

    /// The registry of machines, where this controller listens for them.
    #[cfg(feature = "controller")]
    pub fn nodes(&self) -> Option<&Arc<crate::controller::link::Registry>> {
        self.controller.as_ref()?.nodes.as_ref()
    }

    /// The node id, once the key is loaded.
    pub fn node_id(&self) -> Option<String> {
        self.node.as_ref().map(|n| n.id.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::{ClaudeState, Report, Roster};
    use crate::core::config::Mode;

    /// The link pushes on a generation, which moves when a report or a
    /// roster says something new — never for its clock or the costs that
    /// tick by themselves, and without the link copying either to compare.
    #[test]
    fn generations_move_on_content_not_on_clocks() {
        let shared = Shared::new(
            Role::of(Mode::Controller),
            Facts::default(),
            State::default(),
            Policy::default(),
            Shutdown::new(),
        );
        let report = |state: ClaudeState, at: &str| Report {
            state,
            reported_at: at.into(),
            ..Default::default()
        };
        let policy = Policy::default();
        let claude = &shared.claude;
        claude.take_report(report(ClaudeState::Running, "t1"), &policy);
        let (g, fresh) = claude.report_generation();
        assert!(fresh);
        claude.take_report(report(ClaudeState::Running, "t2"), &policy);
        assert_eq!(claude.report_generation().0, g);
        claude.take_report(report(ClaudeState::Waiting, "t3"), &policy);
        assert_eq!(claude.report_generation().0, g + 1);

        let roster = |at: &str, cpu, errors: Vec<String>| Roster {
            reported_at: at.into(),
            managed: vec![crate::claude::roster::Managed {
                id: "a".into(),
                cpu_nsec: Some(cpu),
                ..Default::default()
            }],
            errors,
            ..Default::default()
        };
        claude.set_roster(roster("t1", 1, vec![]));
        let (_, g) = claude.roster_shared().unwrap();
        claude.set_roster(roster("t2", 2, vec![]));
        assert_eq!(claude.roster_shared().unwrap().1, g);
        claude.set_roster(roster("t3", 2, vec!["x".into()]));
        assert_eq!(claude.roster_shared().unwrap().1, g + 1);
    }
}
