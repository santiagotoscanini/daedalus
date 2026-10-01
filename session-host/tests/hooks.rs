//! Hooks: the hook socket's lifecycle, the queue, the `hook` subcommand,
//! a large backlog, and the socket's caps.

mod common;

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use common::*;

// ── the hook socket's lifecycle ───────────────────────────────────────────

#[test]
fn serve_refuses_a_hook_socket_another_host_answers_on() {
    let dir = tempdir();
    let first = Host::start(dir.path());
    // A second host of its own, but on the first one's hook socket.
    let other = tempdir();
    std::fs::create_dir_all(other.path().join("projects")).unwrap();
    let config = json!({
        "listen": ["127.0.0.1:0"], "stateDir": other.path().join("state"),
        "allowList": other.path().join("allow.json"), "hookSocket": first.hook_socket(),
        "projectsRoot": other.path().join("projects"),
        "workspaces": other.path().join("w.json"),
        "workspaceIcons": other.path().join("icons"), "hookBin": BIN,
    });
    std::fs::write(other.path().join("config.json"), config.to_string()).unwrap();
    let second = Command::new(BIN)
        .args(["serve", "--config"])
        .arg(other.path().join("config.json"))
        .env("SESSION_HOST_LOG", "error")
        .output()
        .unwrap();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("another session host"));
    std::os::unix::net::UnixStream::connect(first.hook_socket()).unwrap();
}

#[test]
fn serve_replaces_a_stale_hook_socket_and_keeps_its_key() {
    // What a crash leaves: a socket file nobody listens on.
    let dir = tempdir();
    let mut crashed = Host::start(dir.path());
    crashed.signal(libc::SIGKILL);
    crashed.wait();
    assert!(crashed.hook_socket().exists());
    let key = crashed.key;
    let host = Host::start(dir.path());
    std::os::unix::net::UnixStream::connect(host.hook_socket()).unwrap();
    assert_eq!(host.key, key, "the host key is made once and kept");
}

// ── the queue and the hook command ────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hooks_queue_deliver_ack_and_restart_per_boot() {
    let dir = tempdir();
    let mut host = Host::start(dir.path());
    let socket = host.hook_socket();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
        0o600
    );

    // Pushed before anyone subscribed, on the hook socket, without a hello.
    let first = push_hook(
        &socket,
        "SessionStart",
        json!([["SANTREE_REPO", "/srv/web"]]),
        b"{\"a\":1}",
    )
    .await;
    assert_eq!(first, 1);
    // The hook socket serves nothing else.
    let other = hook_call(&socket, json!({"id": 5, "m": "pty.sessions", "p": {}})).await;
    assert_eq!(other["id"], 5);
    assert_eq!(other["err"]["code"], "bad_request");

    let mut sub = host.greeted().await;
    let boot = sub.hello(1).await["ok"]["bootId"].clone();
    let req = sub.send("hooks.subscribe", json!({})).await;
    let response = sub.next().await;
    assert_eq!(response, json!({"id": req, "ok": {}}));
    let hook = sub.next().await;
    assert_eq!(hook["e"], "hook");
    assert_eq!(hook["p"]["seq"], 1);
    assert_eq!(hook["p"]["event"], "SessionStart");
    assert_eq!(hook["p"]["env"], json!([["SANTREE_REPO", "/srv/web"]]));
    assert_eq!(unb64(&hook["p"]["stdin"]), b"{\"a\":1}");
    let at = hook["p"]["at"].as_i64().unwrap();
    assert!(at > 1_700_000_000_000, "at is unix ms: {at}");

    // Acked, then a second event arrives live.
    sub.ok("hooks.ack", json!({"upTo": 1})).await;
    push_hook(&socket, "Stop", json!([]), b"").await;
    let live = sub.next().await;
    assert_eq!(live["p"]["seq"], 2);

    // A newer subscriber gets only what is unacked; the older one gets nothing more.
    let mut newer = host.greeted().await;
    newer.ok("hooks.subscribe", json!({})).await;
    let backlog = newer.next().await;
    assert_eq!(backlog["p"]["seq"], 2, "acked seq 1 is not redelivered");
    newer.ok("hooks.ack", json!({"upTo": 2})).await;
    push_hook(&socket, "Stop", json!([]), b"").await;
    assert_eq!(newer.next().await["p"]["seq"], 3);
    let mut stale = String::new();
    assert!(
        tokio::time::timeout(Duration::from_millis(300), sub.reader.read_line(&mut stale))
            .await
            .is_err(),
        "the replaced subscriber got {stale:?}"
    );
    let mut resub = host.greeted().await;
    let after = resub.send("hooks.subscribe", json!({"after": 2})).await;
    assert_eq!(resub.next().await["id"], after);
    assert_eq!(resub.next().await["p"]["seq"], 3);

    // A restart is a new boot: a new bootId, and seq starts over.
    drop((sub, newer, resub));
    host.signal(libc::SIGTERM);
    assert!(host.wait().success());
    assert!(!socket.exists(), "the hook socket is removed");
    let host = Host::start(dir.path());
    let mut again = host.greeted().await;
    let new_boot = again.hello(1).await["ok"]["bootId"].clone();
    assert_ne!(new_boot, boot);
    assert_eq!(push_hook(&socket, "Stop", json!([]), b"").await, 1);
}

fn run_hook(home: &Path, args: &[&str], stdin: &[u8]) -> (std::process::Output, Duration) {
    let started = Instant::now();
    let mut child = Command::new(BIN)
        .arg("hook")
        .args(args)
        .env("HOME", home)
        .env("SANTREE_REPO", "/srv/web")
        .env("SANTREE_TERM_KEY", "tree:web")
        .env("CLAUDE_PROJECT_DIR", "/srv/web")
        .env("NOT_RELAYED", "secret")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    let out = child.wait_with_output().unwrap();
    (out, started.elapsed())
}

#[test]
fn the_hook_subcommand_is_silent_and_logs_when_the_host_is_down() {
    let home = tempdir();
    let socket = home.path().join("none.sock");
    let (out, took) = run_hook(
        home.path(),
        &["--socket", socket.to_str().unwrap(), "Stop"],
        b"{}",
    );
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty());
    assert!(out.stderr.is_empty());
    assert!(took < Duration::from_secs(2), "took {took:?}");
    let state = home.path().join(".local/state/daedalus-session-host");
    let log = std::fs::read_to_string(state.join("hook-errors.log")).unwrap();
    assert_eq!(log.lines().count(), 1, "{log:?}");
    assert!(log.contains("connect"), "{log:?}");
    assert!(!log.contains("/srv/web") && !log.contains("{}"), "{log:?}");
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&state), 0o700);
    assert_eq!(mode(&state.join("hook-errors.log")), 0o600);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hook_subcommand_pushes_verbatim() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let socket = host.hook_socket();
    let socket = socket.to_str().unwrap();

    let payload = br#"{"session_id":"8c1f0000-0000-4000-8000-000000000000"}"#;
    let (out, _) = run_hook(
        dir.path(),
        &["--socket", socket, "--agent-kind", "Codex", "SessionStart"],
        payload,
    );
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty() && out.stderr.is_empty());
    // `--socket` first names the socket; later, it is event text.
    let (out, _) = run_hook(
        dir.path(),
        &[&format!("--socket={socket}"), "statusline", "--socket", "x"],
        b"",
    );
    assert_eq!(out.status.code(), Some(0));
    assert!(!dir
        .path()
        .join(".local/state/daedalus-session-host/hook-errors.log")
        .exists());

    let mut sub = host.greeted().await;
    sub.ok("hooks.subscribe", json!({})).await;
    let first = sub.next().await;
    assert_eq!(first["p"]["event"], "--agent-kind Codex SessionStart");
    assert_eq!(unb64(&first["p"]["stdin"]), payload);
    let mut env: Vec<(String, String)> = serde_json::from_value(first["p"]["env"].clone()).unwrap();
    env.sort();
    assert_eq!(
        env,
        vec![
            ("CLAUDE_PROJECT_DIR".into(), "/srv/web".into()),
            ("SANTREE_REPO".into(), "/srv/web".into()),
            ("SANTREE_TERM_KEY".into(), "tree:web".into()),
        ]
    );
    let second = sub.next().await;
    assert_eq!(second["p"]["event"], "statusline --socket x");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hook_subcommand_does_not_wait_for_a_stdin_that_never_closes() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let started = Instant::now();
    let mut child = Command::new(BIN)
        .args(["hook", "--socket"])
        .arg(host.hook_socket())
        .arg("Stop")
        .env("HOME", dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"{\"partial\":").unwrap();
    // stdin stays open while we wait.
    let deadline = Instant::now() + WAIT;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "hook hung on stdin");
        std::thread::sleep(Duration::from_millis(10));
    };
    let took = started.elapsed();
    drop(stdin);
    assert_eq!(status.code(), Some(0));
    assert!(took < Duration::from_secs(1), "took {took:?}");
    let out = child.wait_with_output().unwrap();
    assert!(out.stdout.is_empty() && out.stderr.is_empty());
    let mut sub = host.greeted().await;
    sub.ok("hooks.subscribe", json!({})).await;
    let hook = sub.next().await;
    assert_eq!(hook["p"]["event"], "Stop");
    assert_eq!(unb64(&hook["p"]["stdin"]), b"{\"partial\":");
}

// ── a backlog, and the socket's caps ──────────────────────────────────────

/// A subscriber that was away while more events queued than any line count
/// would hold (a Mac asleep overnight) gets the whole backlog, in order, and
/// keeps its link.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backlog_of_thousands_of_hooks_is_delivered_whole() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let socket = host.hook_socket();
    const QUEUED: u64 = 3000;
    for _ in 0..QUEUED {
        push_hook(
            &socket,
            "Stop",
            json!([["SANTREE_REPO", "/srv/web"]]),
            b"{}",
        )
        .await;
    }
    let mut sub = host.greeted().await;
    sub.ok("hooks.subscribe", json!({})).await;
    for seq in 1..=QUEUED {
        let hook = sub.next().await;
        assert_eq!(hook["p"]["seq"], seq, "{hook}");
    }
    // Live events follow the backlog on the same link.
    push_hook(&socket, "Stop", json!([]), b"").await;
    assert_eq!(sub.next().await["p"]["seq"], QUEUED + 1);
    sub.ok("hooks.ack", json!({"upTo": QUEUED + 1})).await;
}
/// Reads until the hook socket connection ends; what was answered.
async fn hook_answer(mut stream: UnixStream) -> Vec<u8> {
    let mut answer = Vec::new();
    let _ = tokio::time::timeout(WAIT, stream.read_to_end(&mut answer))
        .await
        .expect("the hook socket kept the connection open");
    answer
}

/// The hook socket serves a few connections at once, each for a moment: a
/// local client holding them open cannot keep hooks out for long.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hook_socket_caps_its_connections_and_times_them_out() {
    use daedalus_session_host::serve::{HOOK_CONN_DEADLINE, MAX_HOOK_CONNS};
    let dir = tempdir();
    let host = Host::start(dir.path());
    let socket = host.hook_socket();
    let mut idle = Vec::new();
    for _ in 0..MAX_HOOK_CONNS {
        idle.push(UnixStream::connect(&socket).await.unwrap());
    }
    // One more is closed unanswered (the host accepts in order, so the idle
    // ones hold every slot by then).
    let mut over = UnixStream::connect(&socket).await.unwrap();
    let push = json!({"id": 1, "m": "hooks.push", "p": {"event": "Stop", "env": [], "stdin": ""}});
    let _ = over.write_all(format!("{push}\n").as_bytes()).await;
    assert!(hook_answer(over).await.is_empty());
    // The silent ones are closed at the deadline, and the slots come back.
    let started = Instant::now();
    for stream in idle {
        assert!(hook_answer(stream).await.is_empty());
    }
    assert!(started.elapsed() < HOOK_CONN_DEADLINE + Duration::from_secs(1));
    assert_eq!(push_hook(&socket, "Stop", json!([]), b"").await, 1);
}
