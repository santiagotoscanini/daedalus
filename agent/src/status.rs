//! The status document: the agent's picture of this machine, built from
//! the shared hubs (shared/), which the tray, the session and
//! `daedalus-agent status` read through the local socket (local.rs) and the
//! link pushes to the controller (link/node.rs), without its telemetry. The
//! tokens in the user's Claude profile never reach it — the report copies
//! dates and a plan name, not credentials.
//!
//! A node's document also carries `controller`: its link to the controller —
//! the address, its own fingerprint and the pinned key of the controller,
//! and the last error, a changed controller key above all (link/node.rs).

use serde::{Deserialize, Serialize};

use crate::facts::Facts;
use crate::link::wire::Policy;
use crate::link::LinkStatus;
use crate::shared::Shared;
use crate::state::State;

/// santree's door on the status page: how many connections pipe now, of
/// how many it serves at once, and the last refusal.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SantreeDoor {
    pub open: usize,
    pub max: usize,
    pub last_refused: Option<SantreeRefused>,
}

/// One refusal at santree's door: when, and its code.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SantreeRefused {
    pub at: String,
    pub code: crate::rpc::ErrorCode,
}

/// The tray, as the page describes it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(test, ts(rename = "StatusTray"))]
pub struct Tray {
    /// A report landed within the freshness window.
    pub reporting: bool,
    pub last_report: Option<String>,
}

/// The status document: the agent's picture of this machine, as the local
/// socket's `status` answers it (the tray, the session, `daedalus-agent
/// status`) and the link pushes it (`nodes.get` hands it to the app). Its
/// telemetry travels on its own. Read with defaults: the two ends of the
/// link are released apart, and a field one side does not write reads as
/// its default on the other.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct StatusDocument {
    pub agent: String,
    pub version: String,
    pub hostname: String,
    #[serde(flatten)]
    pub facts: Facts,
    pub uptime_secs: u64,
    /// The machine's, not the agent's: a small number here after a night is a reboot.
    pub os_uptime_secs: Option<u64>,
    /// When the machine booted, RFC 3339 UTC, derived from the OS uptime.
    pub booted_at: Option<String>,
    pub awake_hold: bool,
    pub hold_error: Option<String>,
    pub power_requests: Option<String>,
    pub update_available: Option<String>,
    pub restart_pending: bool,
    /// What the box asked of this machine.
    pub policy: Policy,
    /// Claude Code on this machine, as the tray last reported it; null when
    /// the tray has not reported lately.
    pub claude: Option<crate::claude::Summary>,
    pub tray: Tray,
    pub claude_update_requested: bool,
    pub claude_restart_requested: bool,
    /// The settings this machine may ask the box for, and what became of
    /// the last requests (settings.rs).
    pub settings: crate::settings::View,
    /// santree's door (santree.rs); null where there is none (Windows,
    /// the controller).
    pub santree: Option<SantreeDoor>,
    /// The connection to the controller (link/): its address, both
    /// fingerprints, and what went wrong. Null on the controller itself.
    pub controller: Option<LinkStatus>,
    #[serde(flatten)]
    pub state: State,
}

/// The status document, with the OS's power requests as the service last
/// read them (`PowerHub::refresh_requests`).
pub fn document(shared: &Shared) -> StatusDocument {
    let os_uptime = crate::power::os_uptime_secs();
    let (awake_hold, hold_error) = shared.power.hold();
    let claude = shared.claude.view();
    let settings = settings_view(shared, None);
    StatusDocument {
        agent: crate::SERVICE_NAME.into(),
        version: crate::VERSION.into(),
        hostname: crate::facts::hostname(),
        facts: shared.facts.clone(),
        uptime_secs: shared.started.elapsed().as_secs(),
        os_uptime_secs: os_uptime,
        booted_at: os_uptime.map(crate::state::rfc3339_ago),
        awake_hold,
        hold_error,
        power_requests: shared.power.requests(),
        update_available: shared.update.available(),
        restart_pending: shared.update.restart_pending(),
        policy: shared.settings.policy(),
        tray: Tray {
            reporting: claude.summary.is_some(),
            last_report: claude.last_report,
        },
        claude: claude.summary,
        claude_update_requested: claude.update_requested,
        claude_restart_requested: claude.restart_requested,
        settings,
        santree: santree_door(shared),
        controller: shared.link.status(),
        state: shared.state.get(),
    }
}

/// The settings as the pages show them (settings.rs `View`), with
/// `may_change` for the peer asking where there is one.
pub fn settings_view(shared: &Shared, may_change: Option<bool>) -> crate::settings::View {
    let linked = shared.link.linked();
    let (kept, pending, failed) = shared.settings.standing();
    #[cfg(unix)]
    let operator_uid = crate::os::operator_uid();
    #[cfg(not(unix))]
    let operator_uid: Option<u32> = None;
    #[cfg(unix)]
    let operator = operator_uid.and_then(crate::os::user_name);
    #[cfg(not(unix))]
    let operator: Option<String> = None;
    let (node, fingerprint) = match &shared.node {
        Some(n) => (Some(n.id.clone()), Some(n.fingerprint.clone())),
        None => (None, None),
    };
    crate::settings::View {
        fingerprint_short: fingerprint.as_deref().map(crate::util::short_fingerprint),
        node,
        fingerprint,
        linked,
        awake_hold: kept.awake_hold,
        claude_remote_control: kept.claude_remote_control,
        santree: kept.santree,
        pending,
        failed,
        operator_uid,
        operator,
        may_change,
    }
}

/// santree's door as the page shows it, where there is one: on macOS and
/// Linux, on a machine that keeps a link.
fn santree_door(shared: &Shared) -> Option<SantreeDoor> {
    (cfg!(unix) && shared.role.link).then(|| SantreeDoor {
        open: shared.santree.open(),
        #[cfg(unix)]
        max: crate::santree::MAX_CONNECTIONS,
        #[cfg(not(unix))]
        max: 0,
        last_refused: shared.santree.last_refused(),
    })
}
