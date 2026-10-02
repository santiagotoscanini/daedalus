//! The app's TypeScript wire types, generated from this crate's own: every
//! type the controller's local API answers, takes or pushes (api/wire.rs),
//! and the documents inside them — the Claude report and roster, the
//! telemetry, a machine's hello and status page — as serde writes them
//! (ts-rs reads the serde attributes: `rename_all`, `skip`, `flatten`,
//! `default` with `skip_serializing_if` for an optional key). One file per
//! type, an `index.ts` naming them all, `Methods.ts` (each method's
//! parameters and answer, from `ApiRequest`'s one list), `constants.ts` (the
//! numbers the app must agree with) and `fixtures/` (one answer of each
//! method and each event, the golden tests' values, which the app's tests
//! decode), in `app/src/host/controller/generated/`, which nothing but this
//! writes.
//!
//! This is a test, so ts-rs is a dev-dependency and no release binary
//! carries it. It compares what the types generate with the files there and
//! fails when they differ — a Rust type changed and the app's copy did not;
//! `DAEDALUS_TS_WRITE=1` writes them instead (`agent/gate.sh gen`). The
//! directory is `DAEDALUS_TS_DIR`, else `../app/src/host/controller/generated`
//! beside this crate (the gate mounts it into its container; CI checks the
//! repository out whole).
//!
//! Numbers: a u64 is a JavaScript `number` here, as JSON.parse reads it;
//! the app decodes every one it treats as an identity with its `int`
//! decoder, which refuses anything past 2^53.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ts_rs::{Config, TS};

/// The roots: everything else is exported as their dependency.
fn export_all(cfg: &Config) -> Result<(), ts_rs::ExportError> {
    use crate::api::wire::*;
    // The answers.
    HelloOk::export_all(cfg)?;
    SystemInfo::export_all(cfg)?;
    ClaudeStatus::export_all(cfg)?;
    ClaudeRosterGet::export_all(cfg)?;
    SessionQueued::export_all(cfg)?;
    Queued::export_all(cfg)?;
    TelemetryGet::export_all(cfg)?;
    Subscribed::export_all(cfg)?;
    NodesList::export_all(cfg)?;
    NodeDetail::export_all(cfg)?;
    NodeProviders::export_all(cfg)?;
    NodeClaude::export_all(cfg)?;
    NodeClaudeRoster::export_all(cfg)?;
    ClaudeSessionSent::export_all(cfg)?;
    ProviderModelSent::export_all(cfg)?;
    ProviderInstallSent::export_all(cfg)?;
    ProviderPowerSent::export_all(cfg)?;
    SetDesiredOk::export_all(cfg)?;
    CommandOk::export_all(cfg)?;
    ControllerInfo::export_all(cfg)?;
    RootRunOk::export_all(cfg)?;
    RootFollowOk::export_all(cfg)?;
    RootRunsOk::export_all(cfg)?;
    SantreeStatus::export_all(cfg)?;
    ActionOutcome::export_all(cfg)?;
    crate::ipc::rpc::ApiError::export_all(cfg)?;
    // The parameters.
    HelloParams::export_all(cfg)?;
    ClaudeSession::export_all(cfg)?;
    NodeId::export_all(cfg)?;
    NodeGet::export_all(cfg)?;
    ActionQuery::export_all(cfg)?;
    NodeClaudeSession::export_all(cfg)?;
    NodeProviderModel::export_all(cfg)?;
    NodeProviderInstall::export_all(cfg)?;
    NodeProviderPower::export_all(cfg)?;
    SetDesired::export_all(cfg)?;
    NodeCommand::export_all(cfg)?;
    ControllerRotate::export_all(cfg)?;
    RootRun::export_all(cfg)?;
    RootFollow::export_all(cfg)?;
    RootRuns::export_all(cfg)?;
    // The events.
    ApiEvent::export_all(cfg)?;
    // Logging in: the app's redeem route (enroll.rs).
    EnrollRedeem::export_all(cfg)?;
    EnrollRedeemed::export_all(cfg)?;
    // The local socket's status document, which `nodes.get` carries.
    crate::core::status::StatusDocument::export_all(cfg)?;
    Ok(())
}

/// Every file under `dir`, by its path relative to it.
fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(root, &p, out);
            } else if let Ok(bytes) = std::fs::read(&p) {
                let rel = p.strip_prefix(root).unwrap_or(&p);
                out.insert(rel.to_string_lossy().replace('\\', "/"), bytes);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// `Methods.ts`: each method's parameters and answer, from the one list
/// (api/wire.rs `ApiRequest`), its types imported from the files beside it.
fn methods(cfg: &Config, generated: &BTreeMap<String, Vec<u8>>) -> String {
    let sigs = crate::api::wire::signatures(cfg);
    let known: std::collections::BTreeSet<&str> = generated
        .keys()
        .filter_map(|f| f.strip_suffix(".ts"))
        .collect();
    let mut used = std::collections::BTreeSet::new();
    for (_, p, a) in &sigs {
        for ty in p.iter().chain([a]) {
            for word in ty.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
                if known.contains(word) {
                    used.insert(word.to_string());
                }
            }
        }
    }
    let mut out = String::from(HEADER);
    for ty in &used {
        out.push_str(&format!("import type {{ {ty} }} from './{ty}'\n"));
    }
    out.push_str(
        "\n/** Each method of the controller's API: its parameters (null: it takes none) and its answer. */\n\
         export type Methods = {\n",
    );
    for (m, p, a) in &sigs {
        out.push_str(&format!(
            "  '{m}': [{}, {a}]\n",
            p.as_deref().unwrap_or("null")
        ));
    }
    out.push_str("}\n");
    out
}

/// `constants.ts`: the numbers the app must agree with, from where the agent
/// keeps them.
fn constants() -> String {
    let ms = |d: std::time::Duration| d.as_millis();
    let mut out = String::from(HEADER);
    for (doc, name, value) in [
        (
            "The agent release this engine builds (Cargo.toml); the box's controller runs it, with the build's `+<id>`, once the engine is applied.",
            "AGENT_VERSION",
            format!("'{}'", env!("CARGO_PKG_VERSION")),
        ),
        (
            "The API version (api/mod.rs).",
            "API_VERSION",
            crate::api::API_VERSION.to_string(),
        ),
        (
            "The longest line either side writes, in bytes (ipc/door.rs).",
            "MAX_LINE",
            crate::ipc::door::MAX_LINE.to_string(),
        ),
        (
            "How long the controller waits for a machine to acknowledge a verb it relays, in ms (controller/link/registry.rs).",
            "ACK_TIMEOUT_MS",
            ms(crate::controller::link::ACK_TIMEOUT).to_string(),
        ),
        (
            "How long a detached `root.run` may take to start before the controller answers, in ms (controller/api/mod.rs).",
            "ROOT_DETACH_WAIT_MS",
            ms(crate::controller::api::ROOT_DETACH_WAIT).to_string(),
        ),
        (
            "The longest name `nodes.set_desired` takes, in characters (api/wire.rs).",
            "MAX_NODE_NAME",
            crate::api::wire::MAX_NODE_NAME.to_string(),
        ),
        (
            "The longest hostname a machine's hello carries, in bytes (link/wire.rs).",
            "MAX_HOSTNAME",
            crate::link::wire::MAX_HOSTNAME.to_string(),
        ),
        (
            "The port a lemonade answers on unless its policy names another (providers/lemonade.rs).",
            "LEMONADE_DEFAULT_PORT",
            crate::node::providers::LEMONADE_DEFAULT_PORT.to_string(),
        ),
    ] {
        out.push_str(&format!("/** {doc} */\nexport const {name} = {value}\n\n"));
    }
    out.pop();
    out
}

const HEADER: &str =
    "// Generated from agent/src (src/ts.rs). Do not edit: change the Rust type,\n\
                      // then run agent/gate.sh gen.\n\n";

/// The generated tree, in memory: each type's file, `index.ts`, `Methods.ts`,
/// `constants.ts`, and one fixture per answer and event (api/wire.rs
/// `fixtures`).
fn generate() -> BTreeMap<String, Vec<u8>> {
    let tmp = std::env::temp_dir().join(format!("daedalus-ts-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let cfg = Config::new().with_large_int("number").with_out_dir(&tmp);
    export_all(&cfg).expect("the wire types export");
    let mut out = files(&tmp);
    let _ = std::fs::remove_dir_all(&tmp);
    let mut index = String::from(HEADER);
    for name in out.keys() {
        let module = name.strip_suffix(".ts").unwrap_or(name);
        let ty = module.rsplit('/').next().unwrap_or(module);
        index.push_str(&format!("export type {{ {ty} }} from './{module}'\n"));
    }
    index.push_str("export type { Methods } from './Methods'\n");
    let methods = methods(&cfg, &out);
    out.insert("index.ts".into(), index.into_bytes());
    out.insert("Methods.ts".into(), methods.into_bytes());
    out.insert("constants.ts".into(), constants().into_bytes());
    for (name, mut json) in crate::api::wire::fixtures() {
        json.push('\n');
        out.insert(format!("fixtures/{name}.json"), json.into_bytes());
    }
    out
}

fn target() -> PathBuf {
    std::env::var_os("DAEDALUS_TS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../app/src/host/controller/generated")
        })
}

#[test]
fn the_generated_types_are_current() {
    let want = generate();
    let dir = target();
    if std::env::var_os("DAEDALUS_TS_WRITE").is_some_and(|v| v == "1") {
        let _ = std::fs::remove_dir_all(&dir);
        for (name, bytes) in &want {
            let p = dir.join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, bytes).unwrap();
        }
        return;
    }
    assert!(
        dir.is_dir(),
        "{} does not exist: the app's generated wire types belong there (agent/gate.sh gen)",
        dir.display()
    );
    let have = files(&dir);
    let mut stale: Vec<String> = Vec::new();
    for (name, bytes) in &want {
        match have.get(name) {
            None => stale.push(format!("missing {name}")),
            Some(b) if b != bytes => stale.push(format!("changed {name}")),
            Some(_) => {}
        }
    }
    stale.extend(
        have.keys()
            .filter(|n| !want.contains_key(*n))
            .map(|n| format!("no longer generated {n}")),
    );
    assert!(
        stale.is_empty(),
        "the app's generated wire types in {} are stale — run agent/gate.sh gen and commit them:\n  {}",
        dir.display(),
        stale.join("\n  ")
    );
}
