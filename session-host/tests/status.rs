//! The CLI's `--version` and the status file.

mod common;

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::json;

use common::*;

// ── the CLI ───────────────────────────────────────────────────────────────

#[test]
fn version_is_exact() {
    let out = Command::new(BIN).arg("--version").output().unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        "daedalus-session-host 0.1.0 protocol 1\n"
    );
}

// ── the status file ───────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_status_file_tracks_the_host_and_says_stopped() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let mut host = Host::start(dir.path());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(host.status_file())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let key_mode = std::fs::metadata(dir.path().join("state/host.key"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(key_mode & 0o777, 0o600);
    let status = read_status(&host.status_file());
    let mut keys: Vec<&str> = status
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.as_str())
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "allowList",
            "bootId",
            "config",
            "connections",
            "exe",
            "generatedAt",
            "hostKey",
            "listen",
            "pid",
            "protocol",
            "schemaVersion",
            "sessions",
            "startedAt",
            "state",
            "version"
        ]
    );
    assert_eq!(status["schemaVersion"], 1);
    assert_eq!(status["state"], "running");
    assert_eq!(status["version"], "0.1.0");
    assert_eq!(status["protocol"], 1);
    assert_eq!(status["pid"], host.child.id());
    assert_eq!(
        Path::new(status["exe"].as_str().unwrap()),
        Path::new(BIN).canonicalize().unwrap()
    );
    assert!(status["startedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(status["sessions"], 0);
    // The config it runs on, which the controller compares with
    // the installed one as it does `exe`.
    assert_eq!(
        Path::new(status["config"].as_str().unwrap()),
        dir.path().join("config.json")
    );
    assert_eq!(status["allowList"], json!({"nodes": 1, "error": null}));

    let mut raw = host.greeted().await;
    raw.ok("pty.open", open(&host, "sh", &["-c", "sleep 30"]))
        .await;
    let node = node_id(&host.node.public_key());
    let deadline = Instant::now() + WAIT;
    let status = loop {
        let status = read_status(&host.status_file());
        if status["sessions"] == 1 && status["connections"][0]["client"] == "test/1" {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "status never caught up: {status}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let conn = &status["connections"][0];
    assert_eq!(conn["node"], node);
    assert!(conn["peer"].as_str().unwrap().starts_with("127.0.0.1:"));
    assert!(conn["connectedAt"].as_str().unwrap().ends_with('Z'));

    host.signal(libc::SIGTERM);
    assert!(host.wait().success(), "SIGTERM exits 0");
    let status = read_status(&host.status_file());
    assert_eq!(status["state"], "stopped");
    assert_eq!(status["sessions"], 0);
    assert_eq!(status["connections"], json!([]));
    assert_eq!(
        status["hostKey"],
        santree_remote_tls::key_hex(&host.key),
        "the stopped snapshot still names the host key"
    );
}
