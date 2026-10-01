#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use std::time::Duration;

use serde_json::Value;

use super::client::*;
use super::server::*;
use super::*;
use crate::core::config::Mode;
use crate::core::facts::Facts;
use crate::core::role::Role;
use crate::core::shared::Shared;
use crate::core::state::State;
use crate::ipc::door::Peer;
use crate::ipc::rpc::{line_of, ApiError, ErrorCode};
use crate::link::wire::Policy;

#[test]
fn the_lines_on_the_wire() {
    assert_eq!(
        request_line(&LocalRequest::Status),
        "{\"id\":1,\"m\":\"status\"}\n"
    );
    assert_eq!(
        request_line(&LocalRequest::SettingsSet(SetParams {
            key: crate::node::settings::Key::AwakeHold,
            value: false
        })),
        "{\"id\":1,\"m\":\"settings.set\",\"p\":{\"key\":\"awake_hold\",\"value\":false}}\n"
    );
    let s = shared(Mode::Node);
    let a = |line: &str| line_of(&answer(&s, None, line.as_bytes()));
    assert_eq!(
        a(r#"{"id":1,"m":"update.check"}"#),
        "{\"id\":1,\"ok\":\"checking\"}\n"
    );
    assert_eq!(
        a(r#"{"id":2,"m":"nope"}"#),
        "{\"id\":2,\"err\":{\"code\":\"unknown_method\",\"msg\":\"no method `nope`\"}}\n"
    );
    assert!(a(r#"{"m":"status"}"#).starts_with("{\"id\":null,\"err\":{\"code\":\"bad_request\""));
    assert_eq!(
        refusal(Some(&Peer::Uid(1001))),
        "{\"id\":null,\"err\":{\"code\":\"forbidden\",\"msg\":\"uid 1001 may not use this agent's socket \
         (root, the service's own user and the user it runs Claude for may)\"}}\n"
    );
    assert_eq!(
        crate::ipc::door::busy(16),
        "{\"id\":null,\"err\":{\"code\":\"busy\",\"msg\":\"at most 16 connections at once\"}}\n"
    );
    // A unit method sent with an empty object is still that method.
    assert!(a(r#"{"id":3,"m":"status","p":{}}"#).contains("bad_request"));
}

/// A request as a client writes it, read as the service reads it.
fn ask(s: &Shared, peer: Option<&Peer>, m: &str, p: Value) -> Result<Value, ApiError> {
    crate::ipc::rpc::Request {
        id: 1,
        m: m.into(),
        p,
    }
    .typed()
    .and_then(|r| handle(s, peer, r))
}

fn shared(mode: Mode) -> Shared {
    Shared::new(
        Role::of(mode),
        Facts::default(),
        State::default(),
        Policy::default(),
        crate::util::Shutdown::new(),
    )
}

#[test]
fn no_one_pairs_through_the_socket_and_a_reload_follows_the_file() {
    let dir = std::env::temp_dir().join(format!("daedalus-local-pair-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("config.toml");
    let key = crate::identity::format_fingerprint(&[4; 32]);
    // As a system that pairs has them (Windows, Linux: a pin alone).
    let files = crate::link::KeyFiles {
        config: path.clone(),
        login: None,
    };
    let s = shared(Mode::Node);
    // Pairing is an administrator's (`pair`, elevated): the socket has
    // no method for it, whoever asks and whatever the machine's state.
    let e = ask(&s, None, "link.pair", serde_json::json!({"pin": key})).unwrap_err();
    assert_eq!(e.code, ErrorCode::UnknownMethod);
    assert_eq!(s.link.keys().0.pin, None);
    assert!(!path.exists());
    // What `pair` does as root: writes the file, then asks for a reload.
    crate::node::pair::Pairing::new(&key, Some("box.lan:7788"))
        .unwrap()
        .write_at(&path)
        .unwrap();
    assert!(link_reload(&s, &files)
        .unwrap()
        .as_str()
        .unwrap()
        .contains("new keys"));
    assert_eq!(s.link.keys().0.pin.as_deref(), Some(key.as_str()));
    // A reload with nothing new changes nothing.
    assert!(link_reload(&s, &files)
        .unwrap()
        .as_str()
        .unwrap()
        .contains("in use"));
    // The controller has no link to reload.
    assert_eq!(
        link_reload(&shared(Mode::Controller), &files)
            .unwrap_err()
            .code,
        ErrorCode::Unsupported
    );
    assert!(ask(&s, None, "link.reload", serde_json::json!({"x": 1})).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_methods_reach_the_shared_state() {
    let s = shared(Mode::Node);
    assert_eq!(ask(&s, None, "claude", Value::Null).unwrap(), Value::Null);
    let report = serde_json::to_value(Report {
        state: crate::claude::ClaudeState::Running,
        ..Default::default()
    })
    .unwrap();
    s.claude.request_restart();
    let answer = ask(&s, None, "claude.report", report).unwrap();
    assert_eq!(answer["restart"], true);
    assert_eq!(
        ask(&s, None, "claude", Value::Null).unwrap()["state"],
        "running"
    );
    assert_eq!(
        ask(&s, None, "status", Value::Null).unwrap()["claude"]["state"],
        "running"
    );
    assert!(ask(&s, None, "claude.update", Value::Null).is_ok());
    assert!(ask(&s, None, "update.check", Value::Null).is_ok());
    assert!(s.update.take_check_request());
    assert!(ask(&s, None, "claude.report", serde_json::json!({"state": 3})).is_err());
    assert!(ask(&s, None, "status", serde_json::json!({"x": 1})).is_err());
    assert!(ask(&s, None, "reboot", Value::Null)
        .unwrap_err()
        .msg
        .contains("no method"));
    // nix pins Claude on the controller.
    let c = shared(Mode::Controller);
    assert!(ask(&c, None, "claude.update", Value::Null)
        .unwrap_err()
        .msg
        .contains("nix"));
}

/// `settings.set`: the operator's alone; nothing sent for a value the box
/// holds; santree ON sends nothing and names the page, or says where to
/// turn it on when this machine knows no app.
#[cfg(unix)]
#[test]
fn settings_are_the_operator_s_to_change_and_santree_on_is_the_browser_s() {
    use crate::node::settings::Key;
    let dir = std::env::temp_dir().join(format!("daedalus-local-set-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let with_app = dir.join("config.toml");
    std::fs::write(
        &with_app,
        "app_url = \"https://daedalus-app.example.org\"\n",
    )
    .unwrap();
    let without = dir.join("none.toml");

    let s = shared(Mode::Node).with_node(crate::core::shared::NodeKey {
        id: "0123456789abcdef".into(),
        fingerprint: "0123:4567:89ab:cdef".into(),
    });
    s.settings.set_policy(Policy {
        awake_hold: true,
        claude_remote_control: true,
        ..Default::default()
    });
    s.link.set_status(|l| {
        l.connected = true;
        l.state = Some(crate::link::LinkState::Approved);
    });
    let root = Peer::Uid(0);
    let set = |peer: &Peer, key: Key, v: bool, cfg: &Path| {
        settings_set(&s, Some(peer), SetParams { key, value: v }, cfg)
    };
    let answer = |v: Value| serde_json::from_value::<SetAnswer>(v).unwrap();

    // Someone else: refused, nothing recorded.
    let e = set(&Peer::Uid(4242), Key::AwakeHold, false, &with_app).unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert!(s.settings.take_request().is_none());
    // The value the box holds: nothing to send.
    assert!(answer(set(&root, Key::AwakeHold, true, &with_app).unwrap()).unchanged);
    assert!(s.settings.take_request().is_none());
    // Another value: recorded, and the link sends it.
    assert!(answer(set(&root, Key::AwakeHold, false, &with_app).unwrap()).sent);
    let (_, req) = s.settings.take_request().unwrap();
    assert_eq!(req.awake_hold, Some(false));
    // santree ON: the page, and nothing on the link.
    let a = answer(set(&root, Key::Santree, true, &with_app).unwrap());
    assert_eq!(
        a.confirm_url.as_deref(),
        Some(
            "https://daedalus-app.example.org/settings?tab=machines&node=0123456789abcdef&santree=on"
        )
    );
    assert!(s.settings.take_request().is_none());
    let view = crate::core::status::settings_view(&s, None);
    assert!(view
        .pending
        .iter()
        .any(|p| p.key == Key::Santree && p.via == crate::node::settings::Via::Browser));
    // No app known: where to turn it on instead, and nothing recorded.
    let s2 = shared(Mode::Node).with_node(crate::core::shared::NodeKey {
        id: "0123456789abcdef".into(),
        fingerprint: "x".into(),
    });
    let e = settings_set(
        &s2,
        Some(&root),
        SetParams {
            key: Key::Santree,
            value: true,
        },
        &without,
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Unsupported);
    assert!(e.msg.contains("Settings › Machines"));
    assert!(crate::core::status::settings_view(&s2, None)
        .pending
        .is_empty());
    // Exact parameters.
    assert!(set_raw(
        &s,
        &root,
        serde_json::json!({"key": "providers", "value": true})
    )
    .is_err());
    assert!(set_raw(
        &s,
        &root,
        serde_json::json!({"key": "santree", "value": true, "x": 1})
    )
    .is_err());
    // Read by anyone the door admits; `may_change` says for whom.
    let got = ask(&s, Some(&Peer::Uid(4242)), "settings.get", Value::Null).unwrap();
    assert_eq!(got["may_change"], false);
    assert_eq!(got["node"], "0123456789abcdef");
    assert_eq!(
        ask(&s, Some(&root), "settings.get", Value::Null).unwrap()["may_change"],
        true
    );
    // The status page carries the same block, without `may_change`.
    let page = ask(&s, None, "status", Value::Null).unwrap();
    assert_eq!(page["settings"]["linked"], true);
    assert!(page["settings"].get("may_change").is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
fn set_raw(s: &Shared, peer: &Peer, p: Value) -> Result<Value, ApiError> {
    ask(s, Some(peer), "settings.set", p)
}

/// The socket itself, on unix: served to this uid, answered, refused
/// past the gate.
#[cfg(unix)]
#[test]
fn the_socket_answers_this_user_and_refuses_the_gate() {
    let dir = std::env::temp_dir().join(format!("daedalus-local-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("run").join("agent.sock");
    let s = Arc::new(shared(Mode::Node));
    let served = {
        let s = Arc::clone(&s);
        crate::os::serve_local(
            &path,
            &policy(
                Arc::new(|peer| {
                    crate::ipc::door::peer_allowed(
                        peer,
                        &crate::ipc::door::unix_allowed(crate::os::own_uid().unwrap(), &[]),
                    )
                }),
                4,
                Duration::from_secs(2),
            ),
            move |c| serve_one(&s, c),
        )
        .unwrap()
    };
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o666);
        assert_eq!(mode(path.parent().unwrap()), 0o711);
    }
    assert_eq!(
        call_at::<String>(&path, &LocalRequest::UpdateCheck).unwrap(),
        "checking"
    );
    assert!(s.update.take_check_request());
    let doc: crate::core::status::StatusDocument = call_at(&path, &LocalRequest::Status).unwrap();
    assert_eq!(doc.version, crate::VERSION);
    // An answer of another type than asked is said so, not misread.
    assert!(matches!(
        call_at::<u32>(&path, &LocalRequest::UpdateCheck),
        Err(CallError::Decode(_))
    ));
    drop(served);

    // A gate that says no: one line, closed.
    let refusing = crate::os::serve_local(
        &path,
        &policy(Arc::new(|_| false), 4, Duration::from_secs(2)),
        |_| unreachable!("refused before serving"),
    )
    .unwrap();
    let e = call_at::<Value>(&path, &LocalRequest::Status).unwrap_err();
    assert!(
        matches!(&e, CallError::Remote { code: ErrorCode::Forbidden, msg } if msg.starts_with("uid ")),
        "{e:?}"
    );
    drop(refusing);
    assert!(matches!(
        call_at::<Value>(&path, &LocalRequest::Status),
        Err(CallError::Transport(_))
    ));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A client that drips its request never holds the connection past the
/// whole exchange's deadline.
#[cfg(unix)]
#[test]
fn a_dripping_client_is_cut_off_at_the_whole_deadline() {
    use std::io::Write as _;
    use std::time::Instant;
    let dir = std::env::temp_dir().join(format!("daedalus-drip-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("run").join("agent.sock");
    let s = Arc::new(shared(Mode::Node));
    let served = crate::os::serve_local(
        &path,
        &policy(Arc::new(|_| true), 4, Duration::from_millis(500)),
        move |c| serve_one(&s, c),
    )
    .unwrap();
    let mut c = std::os::unix::net::UnixStream::connect(&path).unwrap();
    let t = Instant::now();
    let mut cut = false;
    while t.elapsed() < Duration::from_secs(4) {
        if c.write_all(b" ").is_err() {
            cut = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(cut, "still open after {:?}", t.elapsed());
    assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
    drop(served);
    let _ = std::fs::remove_dir_all(&dir);
}
