//! What a machine offers the network beyond itself: a model server today.
//!
//! The agent reports PRESENCE and nothing more — that a provider is here,
//! on which port, which version, whether it answers. The box reads the
//! rest (the catalog, what is loaded, the health) from the provider's own
//! API at this machine's name, the same address the gateway dials; a
//! model list carried here would be a second copy of the provider's state.
//!
//! Lemonade is the one kind the agent detects. Ollama is deliberately not
//! one: Lemonade's installer brings it along, so detecting it would list
//! every Lemonade machine twice (app/src/lib/providers/kinds.ts says more).

use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::hello::Policy;
use crate::telemetry::App;

/// One provider as the telemetry document carries it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderReport {
    /// "lemonade", the one kind the agent detects.
    pub kind: String,
    /// The port it answers on, or would.
    pub port: u16,
    /// What its health endpoint says it is; None when it is not answering.
    pub version: Option<String>,
    /// The probe answered. False with the install found means "here, not
    /// running", which the page names.
    pub running: bool,
}

/// How long a local probe may take. A refused port answers at once; a hung
/// server must not stall the sampling thread for long.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

pub const LEMONADE_DEFAULT_PORT: u16 = 13305;

/// Lemonade Server (lemonade-server.ai): an OpenAI-compatible model server
/// for AMD and other local hardware. Health is `/api/v1/health`, which
/// carries the version. A report when it is running, or installed and not;
/// None when there is no sign of it.
fn detect_lemonade(policy: &Policy, apps: &[App]) -> Option<ProviderReport> {
    let port = policy
        .providers
        .lemonade
        .as_ref()
        .and_then(|p| p.port)
        .unwrap_or(LEMONADE_DEFAULT_PORT);
    if let Some(version) = probe_health(port) {
        return Some(ProviderReport {
            kind: "lemonade".into(),
            port,
            version,
            running: true,
        });
    }
    // Not answering: worth a line only if it is installed, and the
    // inventory the slow facts already read says so.
    let installed = apps
        .iter()
        .any(|a| a.name.to_ascii_lowercase().contains("lemonade"));
    installed.then(|| ProviderReport {
        kind: "lemonade".into(),
        port,
        version: None,
        running: false,
    })
}

/// GET `/api/v1/health` on loopback. Some(version) on a 200 (the version
/// None when the body does not carry one), None when nothing answered.
fn probe_health(port: u16) -> Option<Option<String>> {
    let url = format!("http://127.0.0.1:{port}/api/v1/health");
    let res = ureq::AgentBuilder::new()
        .timeout(PROBE_TIMEOUT)
        .build()
        .get(&url)
        .call()
        .ok()?;
    if res.status() != 200 {
        return None;
    }
    let body: serde_json::Value = res.into_json().ok().unwrap_or(serde_json::Value::Null);
    Some(
        body.get("version")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
    )
}

/// The providers on this machine, as the telemetry document lists them.
pub fn detect(policy: &Policy, apps: &[App]) -> Vec<ProviderReport> {
    detect_lemonade(policy, apps).into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hello::{ProviderPolicy, ProvidersPolicy};

    fn app(name: &str) -> App {
        App {
            name: name.into(),
            kind: "app".into(),
            ..Default::default()
        }
    }

    #[test]
    fn nothing_installed_and_nothing_answering_is_no_report() {
        // A port nothing listens on: the probe refuses at once.
        let mut policy = Policy::default();
        policy.providers.lemonade = Some(ProviderPolicy { port: Some(1) });
        assert!(detect_lemonade(&policy, &[]).is_none());
    }

    #[test]
    fn installed_but_silent_is_found_not_running() {
        let mut policy = Policy::default();
        policy.providers.lemonade = Some(ProviderPolicy { port: Some(1) });
        let r = detect_lemonade(&policy, &[app("Lemonade Server")]).expect("installed");
        assert_eq!(
            r,
            ProviderReport {
                kind: "lemonade".into(),
                port: 1,
                version: None,
                running: false
            }
        );
    }

    #[test]
    fn the_policy_port_is_optional_and_defaults() {
        let policy = Policy {
            providers: ProvidersPolicy::default(),
            ..Policy::default()
        };
        let port = policy
            .providers
            .lemonade
            .as_ref()
            .and_then(|p| p.port)
            .unwrap_or(LEMONADE_DEFAULT_PORT);
        assert_eq!(port, 13305);
        let parsed: Policy =
            serde_json::from_str(r#"{"awake_hold":true,"providers":{"lemonade":{"port":8000}}}"#)
                .unwrap();
        assert_eq!(parsed.providers.lemonade.unwrap().port, Some(8000));
        let without: Policy = serde_json::from_str(r#"{"awake_hold":false}"#).unwrap();
        assert!(without.providers.lemonade.is_none());
    }
}
