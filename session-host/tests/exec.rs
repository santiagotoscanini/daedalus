//! `exec.run`: argv, timeouts, signals, process groups, concurrency.

mod common;

use santree_remote_client::proto::{ErrorCode, ExecParams};
use serde_json::json;

use common::*;

// ── exec ──────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exec_runs_argv_times_out_and_reports_signals() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let client = host.client().await;
    let cwd = host.root_str();

    let git = client
        .exec_run(&ExecParams {
            cwd: cwd.clone(),
            argv: vec!["git".into(), "--version".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(git.success(), "{git:?}");
    assert!(String::from_utf8_lossy(&git.stdout).starts_with("git version"));

    let env = client
        .exec_run(&ExecParams {
            cwd: cwd.clone(),
            argv: vec![
                "sh".into(),
                "-c".into(),
                "printf %s \"$GIT_OPTIONAL_LOCKS:$X:$(pwd)\"; cat; exit 3".into(),
            ],
            env: Some(vec![
                ("X".into(), "y".into()),
                ("GIT_OPTIONAL_LOCKS".into(), "1".into()),
            ]),
            stdin: Some(b"|in".to_vec()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(env.code, Some(3));
    let real = host.root().canonicalize().unwrap();
    assert_eq!(
        String::from_utf8(env.stdout).unwrap(),
        format!("0:y:{}|in", real.display())
    );

    let slow = client
        .exec_run(&ExecParams {
            cwd: cwd.clone(),
            argv: vec!["sleep".into(), "5".into()],
            timeout_ms: Some(200),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(slow.code(), Some(&ErrorCode::Timeout));

    let killed = client
        .exec_run(&ExecParams {
            cwd: cwd.clone(),
            argv: vec!["sh".into(), "-c".into(), "kill -9 $$".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!((killed.code, killed.signal), (None, Some(9)));

    let missing = client
        .exec_run(&ExecParams {
            cwd: cwd.clone(),
            argv: vec!["santree-no-such-binary".into()],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(missing.code(), Some(&ErrorCode::NotFound));
    for (cwd, code) in [
        ("relative".to_string(), ErrorCode::BadRequest),
        ("/".to_string(), ErrorCode::Outside),
        (format!("{cwd}/.."), ErrorCode::Outside),
        (format!("{cwd}/missing"), ErrorCode::NotFound),
    ] {
        let refused = client
            .exec_run(&ExecParams {
                cwd: cwd.clone(),
                argv: vec!["true".into()],
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(refused.code(), Some(&code), "{cwd}");
    }
}

/// A timeout kills the whole process group, not only the direct child.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_timeout_kills_the_process_group() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let client = host.client().await;
    let pidfile = host.root().join("pid");
    let slow = client
        .exec_run(&ExecParams {
            cwd: host.root_str(),
            argv: vec![
                "sh".into(),
                "-c".into(),
                format!("sleep 60 & echo $! > {}; wait", pidfile.display()),
            ],
            timeout_ms: Some(500),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(slow.code(), Some(&ErrorCode::Timeout));
    let pid: i32 = std::fs::read_to_string(&pidfile)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // SAFETY: kill(2) with signal 0 only asks whether the pid exists.
    wait_until("the grandchild outlived the timeout", WAIT, || unsafe {
        libc::kill(pid, 0) != 0
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exec_wire_shape_omits_signal_when_none() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    let result = raw
        .ok(
            "exec.run",
            json!({"cwd": host.root_str(), "argv": ["sh", "-c", "printf hi"]}),
        )
        .await;
    assert_eq!(
        result,
        json!({"code": 0, "stdout": b64(b"hi"), "stderr": "", "truncated": false})
    );
}

/// Requests run concurrently and answer out of order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_call_does_not_hold_up_a_fast_one() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    let slow = raw
        .send(
            "exec.run",
            json!({"cwd": host.root_str(), "argv": ["sleep", "1"]}),
        )
        .await;
    let fast = raw.send("fs.stat", json!({"path": "/"})).await;
    let first = raw.next().await;
    assert_eq!(first["id"], fast, "{first}");
    let second = raw.next().await;
    assert_eq!(second["id"], slow, "{second}");
}
