//! PTY sessions: reattach without gaps or duplicates, exit, santree's own
//! client driving a shell, and where a PTY may open.

mod common;

use std::time::{Duration, Instant};

use santree_remote_client::proto::{Anchor, PtyOpenParams, ReplayMode};
use santree_remote_client::PtyEvent;
use serde_json::{json, Value};

use common::*;

// ── reattach without gaps or duplicates ───────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_connection_resumes_exactly() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let host = Host::start(dir.path());
    let script = "for i in $(seq 1 2000); do echo line $i; done; sleep 30";

    let mut first = host.greeted().await;
    let info = first
        .ok("pty.open", open(&host, "sh", &["-c", script]))
        .await;
    assert_eq!(info["attached"], false);
    assert_eq!(info["alive"], true);
    let id = info["id"].as_u64().unwrap();
    let attach = first
        .ok("pty.attach", json!({"id": id, "anchor": "fresh"}))
        .await;
    assert_eq!(attach["mode"], "tail");
    let epoch = attach["epoch"].as_str().unwrap().to_string();
    let mut seen = unb64(&attach["data"]);
    let base = attach["seq"].as_u64().unwrap() - seen.len() as u64;
    assert_eq!(base, 0, "the ring holds the whole stream");
    // Read a little, then drop the connection mid-stream.
    while !contains(&seen, b"line 50\r\n") {
        let frame = first.next().await;
        assert_eq!(frame["e"], "pty.data", "{frame}");
        seen.extend(unb64(&frame["p"]["data"]));
    }
    drop(first);

    let mut second = host.greeted().await;
    // A drop detaches, once the host has seen it.
    let listed = second
        .ok_until("pty.sessions", json!({}), |l| l[0]["attached"] == false)
        .await;
    assert_eq!(listed[0]["alive"], true, "a drop never closes");
    let resumed = second
        .ok(
            "pty.attach",
            json!({"id": id, "anchor": {"at": {"epoch": epoch, "seq": seen.len()}}}),
        )
        .await;
    assert_eq!(resumed["mode"], "exact");
    seen.extend(unb64(&resumed["data"]));
    assert_eq!(resumed["seq"].as_u64().unwrap(), seen.len() as u64);
    while !contains(&seen, b"line 2000\r\n") {
        let frame = second.next().await;
        assert_eq!(frame["e"], "pty.data", "{frame}");
        seen.extend(unb64(&frame["p"]["data"]));
    }
    let text = String::from_utf8(seen).unwrap();
    let lines: Vec<&str> = text.split("\r\n").filter(|l| !l.is_empty()).collect();
    let expected: Vec<String> = (1..=2000).map(|i| format!("line {i}")).collect();
    assert_eq!(lines, expected, "every line exactly once, in order");
    // Closing a session this connection receives: its pty.exit may come first.
    let close = second.send("pty.close", json!({"id": id})).await;
    loop {
        let frame = second.next().await;
        if frame["id"] == close {
            assert_eq!(frame["ok"], json!({}));
            break;
        }
        assert!(
            frame["e"] == "pty.data" || frame["e"] == "pty.exit",
            "{frame}"
        );
    }
}

/// santree's own client, end to end over TLS: hello → pty.open → attach →
/// data → the link dropped → a new link re-attaches `exact`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conformance_the_real_client_reattaches_exactly_after_a_drop() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let host = Host::start(dir.path());
    let client = host.client().await;
    let info = client
        .pty_open(&PtyOpenParams {
            cwd: Some(host.root_str()),
            command: "sh".into(),
            cols: 80,
            rows: 24,
            owner: "owner-a".into(),
            label: "tree:x".into(),
            ..Default::default()
        })
        .await
        .unwrap();
    let (attach, mut rx) = client.pty_attach(info.id, Anchor::Fresh).await.unwrap();
    let mut seen = attach.data;
    let base = attach.seq - seen.len() as u64;
    client
        .pty_write(info.id, b"echo one-$((1+1))\n".to_vec())
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + WAIT;
    while !contains(&seen, b"one-2") {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(PtyEvent::Data(bytes))) => seen.extend(bytes),
            other => panic!("{other:?}"),
        }
    }
    client.shutdown();
    drop(client);

    let again = host.client().await;
    again
        .pty_write(info.id, b"echo two-$((2+2))\n".to_vec())
        .await
        .unwrap();
    let (resumed, mut rx) = again
        .pty_attach(
            info.id,
            Anchor::At {
                epoch: attach.epoch.clone(),
                seq: base + seen.len() as u64,
            },
        )
        .await
        .unwrap();
    assert_eq!(resumed.mode, ReplayMode::Exact);
    seen.extend(resumed.data);
    let deadline = tokio::time::Instant::now() + WAIT;
    while !contains(&seen, b"two-4") {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(PtyEvent::Data(bytes))) => seen.extend(bytes),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(
        String::from_utf8_lossy(&seen).matches("one-2").count(),
        1,
        "nothing replayed twice"
    );
    again.pty_close(info.id).await.unwrap();
}

// ── exit ──────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exit_is_delivered_and_an_exited_session_stays_listed() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;

    let info = raw
        .ok(
            "pty.open",
            open(&host, "sh", &["-c", "sleep 0.3; echo bye"]),
        )
        .await;
    let id = info["id"].as_u64().unwrap();
    let attach = raw
        .ok("pty.attach", json!({"id": id, "anchor": "fresh"}))
        .await;
    let mut out = unb64(&attach["data"]);
    loop {
        let frame = raw.next().await;
        match frame["e"].as_str() {
            Some("pty.data") => out.extend(unb64(&frame["p"]["data"])),
            Some("pty.exit") => {
                assert_eq!(frame["p"]["id"], id);
                break;
            }
            _ => panic!("{frame}"),
        }
    }
    assert!(contains(&out, b"bye"));

    let deadline = Instant::now() + WAIT;
    loop {
        let listed = raw.ok("pty.sessions", json!({})).await;
        let entry = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .cloned()
            .expect("an exited session is listed until closed");
        if entry["alive"] == false {
            break;
        }
        assert!(Instant::now() < deadline, "never read as exited");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Attach to the exited session: the response, then pty.exit.
    let req = raw
        .send("pty.attach", json!({"id": id, "anchor": "fresh"}))
        .await;
    let response = raw.next().await;
    assert_eq!(response["id"], req, "{response}");
    assert!(contains(&unb64(&response["ok"]["data"]), b"bye"));
    let exit = raw.next().await;
    assert_eq!(exit, json!({"e": "pty.exit", "p": {"id": id}}));

    assert_eq!(raw.ok("pty.close", json!({"id": id})).await, json!({}));
    assert_eq!(raw.ok("pty.close", json!({"id": 999})).await, json!({}));
    for (m, p) in [
        ("pty.write", json!({"id": id, "data": b64(b"x")})),
        ("pty.resize", json!({"id": id, "cols": 10, "rows": 10})),
        ("pty.attach", json!({"id": id, "anchor": "fresh"})),
    ] {
        let frame = raw.call(m, p).await;
        assert_eq!(frame["err"]["code"], "not_found", "{m}: {frame}");
    }
    assert!(raw
        .ok("pty.sessions", json!({}))
        .await
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_client_drives_a_shell() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let host = Host::start(dir.path());
    let client = host.client().await;
    let info = client
        .pty_open(&PtyOpenParams {
            cwd: Some(host.root_str()),
            command: "sh".into(),
            cols: 80,
            rows: 24,
            owner: "owner-a".into(),
            label: "tree:x".into(),
            env: vec![("SANTREE_T".into(), "overlay".into())],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(info.alive && !info.attached);
    let (attach, mut rx) = client.pty_attach(info.id, Anchor::Fresh).await.unwrap();
    assert_eq!(attach.mode, ReplayMode::Tail);
    client
        .pty_write(
            info.id,
            b"echo \"$SANTREE_T:$TERM:$((40+2)):$(pwd)\"\n".to_vec(),
        )
        .await
        .unwrap();
    let mut out = attach.data;
    let expect = format!(
        "overlay:xterm-256color:42:{}",
        host.root().canonicalize().unwrap().display()
    );
    let deadline = tokio::time::Instant::now() + WAIT;
    while !contains(&out, expect.as_bytes()) {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(PtyEvent::Data(bytes))) => out.extend(bytes),
            other => panic!("{other:?}: {:?}", String::from_utf8_lossy(&out)),
        }
    }
    client.pty_resize(info.id, 100, 30).await.unwrap();
    let listed = client.pty_sessions().await.unwrap();
    assert!(listed
        .iter()
        .any(|s| s.id == info.id && s.attached && s.cols == 100 && s.rows == 30));

    // A newer attach replaces the older receiver; detach leaves it running.
    let (_, _newer) = client
        .pty_attach(
            info.id,
            Anchor::At {
                epoch: attach.epoch.clone(),
                seq: attach.seq,
            },
        )
        .await
        .unwrap();
    while tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("old receiver never closed")
        .is_some()
    {}
    client.pty_detach(info.id).await.unwrap();
    assert!(client
        .pty_sessions()
        .await
        .unwrap()
        .iter()
        .any(|s| s.id == info.id && s.alive && !s.attached));

    // Adoption hands the session to another owner.
    assert!(client.pty_adopt("owner-a").await.unwrap().is_empty());
    let adopted = client.pty_adopt("owner-b").await.unwrap();
    assert_eq!(adopted.len(), 1);
    assert_eq!(adopted[0].owner, "owner-b");
    let (again, _rx) = client.pty_attach(info.id, Anchor::Unknown).await.unwrap();
    assert_eq!(again.mode, ReplayMode::Reanchor);
    client.pty_close(info.id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pty_opens_only_in_an_existing_directory_under_the_root() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    let root = host.root_str();
    std::os::unix::fs::symlink(dir.path(), host.root().join("up")).unwrap();
    for (cwd, code) in [
        (Value::Null, "bad_request"),
        (json!(format!("{root}/..")), "outside"),
        (json!(format!("{root}/up")), "outside"),
        (json!("/"), "outside"),
        (json!(format!("{root}/gone")), "not_found"),
    ] {
        let mut p = open(&host, "sh", &[]);
        p["cwd"] = cwd.clone();
        let frame = raw.call("pty.open", p).await;
        assert_eq!(frame["err"]["code"], code, "{cwd}: {frame}");
    }
    assert!(raw
        .ok("pty.sessions", json!({}))
        .await
        .as_array()
        .unwrap()
        .is_empty());
}
