use super::*;
use crate::claude::{ClaudeState, Report};
use crate::core::status::StatusDocument;
use crate::link::wire::Policy;
use crate::link::TunnelStatus;
use crate::link::{LinkState, LinkStatus};
use crate::node::settings::{FailedView, PendingView};
use crate::node::settings::{Via, View};
use std::ffi::OsString;
use std::path::Path;

use super::elevate::*;

/// The backing runs on its own thread: the tray only hands it clicks and
/// reads what it told, and neither waits on the backing's calls. A
/// watcher with no service to answer it still polls, and is told.
#[test]
fn the_backing_runs_off_the_ui_thread() {
    let w = Worker::start(Box::new(Watcher::new())).unwrap();
    let until = std::time::Instant::now() + Duration::from_secs(10);
    let first = loop {
        if let (Some((poll, _)), false) = w.drain() {
            break poll;
        }
        assert!(std::time::Instant::now() < until, "no poll was told");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(first.page.is_none(), "no service in a test");
    assert_eq!(first.report.state, ClaudeState::NoSession);
    // A click returns at once, whatever the backing does with it.
    let t = std::time::Instant::now();
    w.ask(Ask::CheckUpdates);
    w.ask(Ask::RestartClaude);
    assert!(t.elapsed() < Duration::from_millis(50));
    drop(w);
}

#[test]
fn the_updates_row_says_what_the_updater_is_doing() {
    let checked = StatusDocument {
        state: crate::core::state::State {
            last_update_result: Some("up to date".into()),
            last_update_check: Some("2026-09-30T10:00:00Z".into()),
            ..Default::default()
        },
        ..StatusDocument::default()
    };
    assert_eq!(update_line(&checked), "Updates: up to date · 10:00");
    let offered = StatusDocument {
        update_available: Some("0.25.1".into()),
        ..StatusDocument::default()
    };
    assert_eq!(update_line(&offered), "Updating to 0.25.1…");
    let restarting = StatusDocument {
        restart_pending: true,
        ..StatusDocument::default()
    };
    assert_eq!(update_line(&restarting), "Update installed — restarting");
    assert_eq!(
        update_line(&StatusDocument::default()),
        "Updates: not checked yet"
    );
}

fn linked_page() -> StatusDocument {
    StatusDocument {
        awake_hold: true,
        policy: Policy {
            awake_hold: true,
            claude_remote_control: true,
            ..Default::default()
        },
        controller: Some(LinkStatus {
            address: Some("box.lan:7788".into()),
            found_via: None,
            state: Some(LinkState::Approved),
            connected: true,
            since: Some("2026-09-30T09:12:00Z".into()),
            fingerprint:
                "f876:e2c7:1a0b:2c3d:4e5f:6a7b:8c9d:0e1f:2a3b:4c5d:6e7f:8a9b:0c1d:2e3f:4a5b:8029"
                    .into(),
            controller_fingerprint: Some(
                "3a1b:0c9d:1111:2222:3333:4444:5555:6666:7777:8888:9999:aaaa:bbbb:cccc:dddd:77e2"
                    .into(),
            ),
            rotated: None,
            error: None,
            tunnel: Some(TunnelStatus {
                endpoint: "s2.toscanini.me:51820".into(),
                address: "10.8.0.5".into(),
                last_handshake_secs: Some(42),
                rx_bytes: 12_400_000,
                tx_bytes: 2_200_000,
                ..Default::default()
            }),
        }),
        settings: View {
            linked: true,
            awake_hold: true,
            claude_remote_control: true,
            operator_uid: Some(501),
            operator: Some("santiago".into()),
            ..Default::default()
        },
        ..StatusDocument::default()
    }
}

fn running() -> Report {
    Report {
        state: ClaudeState::Running,
        ..Default::default()
    }
}

/// One test per header state (module doc), in the order they win.
#[test]
fn the_header_has_one_state_for_every_way_things_stand() {
    let ok = linked_page();
    let r = running();
    let h = |p: Option<&StatusDocument>, off: bool, claude: &Report, wanted: bool| {
        let h = header(p, off, claude, wanted);
        (h.dot, h.text)
    };
    assert_eq!(
        h(Some(&ok), false, &r, true),
        (Dot::Green, "Daedalus Agent is connected".into())
    );
    // The service is silent: switched off in Login Items, or not answering.
    let off = header(None, true, &r, true);
    assert_eq!((off.dot, off.login_items), (Dot::Grey, true));
    assert_eq!(off.text, "The service is off in Login Items");
    assert_eq!(
        h(None, false, &r, true),
        (Dot::Red, "The service is not answering".into())
    );
    // Not joined.
    let mut out = linked_page();
    if cfg!(target_os = "macos") {
        out.controller.as_mut().unwrap().tunnel = None;
    } else {
        out.controller.as_mut().unwrap().state = Some(LinkState::Unpaired);
    }
    let (dot, text) = h(Some(&out), false, &r, true);
    assert_eq!(dot, Dot::Grey);
    assert_eq!(text, UNJOINED_HEADER);
    // The link's states.
    let with = |f: &dyn Fn(&mut LinkStatus)| {
        let mut p = linked_page();
        f(p.controller.as_mut().unwrap());
        p
    };
    let changed = with(&|l| l.state = Some(LinkState::KeyChanged));
    assert_eq!(
        h(Some(&changed), false, &r, true),
        (Dot::Red, "The box's key changed — refused".into())
    );
    let revoked = with(&|l| l.state = Some(LinkState::Revoked));
    assert_eq!(h(Some(&revoked), false, &r, true).1, "Revoked by the box");
    let pending = with(&|l| l.state = Some(LinkState::Pending));
    assert_eq!(
        h(Some(&pending), false, &r, true),
        (Dot::Amber, "Waiting for approval in Daedalus".into())
    );
    let down = with(&|l| {
        l.connected = false;
        l.state = Some(LinkState::Connecting);
        l.error = Some("connection refused by box.lan:7788 after three tries in a row".into());
    });
    let (dot, text) = h(Some(&down), false, &r, true);
    assert_eq!(dot, Dot::Red);
    assert!(
        text.starts_with("Disconnected — connection refused"),
        "{text}"
    );
    assert!(text.chars().count() <= "Disconnected — ".chars().count() + 40);
    let connecting = with(&|l| {
        l.connected = false;
        l.state = Some(LinkState::Connecting);
    });
    assert_eq!(
        h(Some(&connecting), false, &r, true),
        (Dot::Amber, "Connecting…".into())
    );
    let stale = with(&|l| l.tunnel.as_mut().unwrap().last_handshake_secs = Some(600));
    assert_eq!(h(Some(&stale), false, &r, true).1, "VPN handshake is stale");
    // The machine's own.
    let restarting = StatusDocument {
        restart_pending: true,
        ..linked_page()
    };
    assert_eq!(
        h(Some(&restarting), false, &r, true).1,
        "Update installed — restarting"
    );
    let unheld = StatusDocument {
        awake_hold: false,
        ..linked_page()
    };
    assert_eq!(
        h(Some(&unheld), false, &r, true),
        (Dot::Amber, "Keep awake is not holding".into())
    );
    // Not holding because the box lets it sleep: fine.
    let mut sleeps = unheld;
    sleeps.policy.awake_hold = false;
    assert_eq!(h(Some(&sleeps), false, &r, true).0, Dot::Green);
    let exited = Report {
        state: ClaudeState::Waiting,
        ..Default::default()
    };
    assert_eq!(
        h(Some(&ok), false, &exited, true).1,
        "Claude remote control is not running"
    );
    assert_eq!(h(Some(&ok), false, &exited, false).0, Dot::Green);
    let mut failed = linked_page();
    failed.settings.failed = vec![FailedView {
        key: Key::AwakeHold,
        want: false,
        why: "Daedalus did not apply it".into(),
    }];
    assert_eq!(
        h(Some(&failed), false, &r, true),
        (Dot::Amber, "A setting was not applied".into())
    );
}

#[test]
fn a_switch_shows_the_box_s_value_or_the_one_on_its_way() {
    let base = linked_page().settings;
    let sw = switch(Key::AwakeHold, &base, true);
    assert_eq!(
        sw,
        Switch {
            text: "Keep awake".into(),
            checked: true,
            enabled: true
        }
    );
    assert_eq!(switches_note(Some(&base), true), None);
    assert_eq!(switches_note(None, true), None);
    assert_eq!(mark(&sw), Mark::Check);
    // On its way: the value asked for.
    let mut s = base.clone();
    s.pending = vec![PendingView {
        key: Key::AwakeHold,
        want: false,
        via: Via::Box,
    }];
    let sw = switch(Key::AwakeHold, &s, true);
    assert_eq!(
        (sw.text.as_str(), sw.checked),
        ("Keep awake — sending…", false)
    );
    assert_eq!(mark(&sw), Mark::Blank);
    // A click while it is on its way asks for the other value again.
    assert!(next_value(Key::AwakeHold, &s));
    // Not taken: the box's value, and why.
    let mut s = base.clone();
    s.failed = vec![FailedView {
        key: Key::ClaudeRemoteControl,
        want: false,
        why: "Daedalus is not listening (the app is down) and more words past forty".into(),
    }];
    let sw = switch(Key::ClaudeRemoteControl, &s, true);
    assert!(sw.checked);
    assert!(
        sw.text
            .starts_with("Claude Remote Control — not changed: Daedalus is not listening"),
        "{}",
        sw.text
    );
    assert!(sw.text.ends_with('…'));
    // santree ON waits on the browser; a click opens the page again.
    let mut s = base.clone();
    s.pending = vec![PendingView {
        key: Key::Santree,
        want: true,
        via: Via::Browser,
    }];
    let sw = switch(Key::Santree, &s, true);
    assert_eq!(
        (sw.text.as_str(), sw.checked),
        ("santree on the box — confirm in the browser…", true)
    );
    assert!(next_value(Key::Santree, &s));
    // On: a click sends OFF.
    let on = View {
        santree: true,
        ..base.clone()
    };
    assert!(!next_value(Key::Santree, &on));
    // Someone else at this Mac: read-only, and says whose they are.
    let sw = switch(Key::AwakeHold, &base, false);
    assert!(!sw.enabled);
    assert_eq!(
        switches_note(Some(&base), false).as_deref(),
        Some("Only santiago can change these")
    );
    let nobody = View {
        operator: None,
        ..base.clone()
    };
    assert_eq!(
        switches_note(Some(&nobody), false).as_deref(),
        Some("Only the user who installed the agent can change these")
    );
    // Not linked: disabled, and why.
    let unlinked = View {
        linked: false,
        ..base
    };
    assert!(!switch(Key::AwakeHold, &unlinked, true).enabled);
    assert_eq!(
        switches_note(Some(&unlinked), true).as_deref(),
        Some("Changes need the box: not connected")
    );
}

#[test]
fn the_connection_submenu_shortens_what_is_long_and_keeps_it_whole_for_copy() {
    let p = linked_page();
    let rows = connection_rows(p.controller.as_ref());
    assert_eq!(rows.title, "Connection · VPN up");
    assert_eq!(rows.link, "Box: box.lan:7788 — approved, linked 09:12");
    assert_eq!(rows.vpn, "VPN: up · handshake 42 s ago");
    assert_eq!(rows.traffic, "Traffic: ↓ 12.4 MB · ↑ 2.2 MB");
    assert_eq!(rows.address, "Tunnel address: 10.8.0.5");
    assert_eq!(rows.endpoint, "Endpoint: s2.toscanini.me:51820");
    assert_eq!(rows.own_key.0, format!("{OWN_KEY}: f876:e2c7…8029"));
    assert!(rows.own_key.1.starts_with("f876:e2c7:1a0b") && rows.own_key.1.ends_with(":8029"));
    assert_eq!(rows.box_key.0, "Box's key: 3a1b:0c9d…77e2 (pinned)");
    // Down, and why.
    let mut l = p.controller.clone().unwrap();
    l.tunnel.as_mut().unwrap().error = Some("s2.toscanini.me:51820 does not resolve".into());
    let rows = connection_rows(Some(&l));
    assert_eq!(rows.title, "Connection · VPN down");
    assert_eq!(
        rows.vpn,
        "VPN: down — s2.toscanini.me:51820 does not resolve"
    );
    // Pending: compare both keys.
    let mut l = p.controller.clone().unwrap();
    l.state = Some(LinkState::Pending);
    assert_eq!(
        connection_rows(Some(&l)).link,
        "Box: box.lan:7788 — waiting for approval"
    );
    // Not joined: a Mac logs in, the others pair; nothing to copy.
    let mut l = p.controller.clone().unwrap();
    if cfg!(target_os = "macos") {
        l.tunnel = None;
        assert_eq!(
            connection_rows(Some(&l)).link,
            "Box: not logged in — choose Log in…"
        );
        assert_eq!(connection_rows(Some(&l)).title, "Connection · logged out");
    } else {
        l.tunnel = None;
        l.state = Some(LinkState::Unpaired);
        l.controller_fingerprint = None;
        let rows = connection_rows(Some(&l));
        assert_eq!(rows.link, "Box: not paired — choose Pair with the box…");
        assert_eq!(
            rows.box_key,
            ("Box's key: none trusted yet".into(), "—".into())
        );
        assert_eq!(rows.title, "Connection · direct");
    }
    assert_eq!(connection_rows(None).own_key.1, "—");
    assert_eq!(bytes(999), "999 B");
    assert_eq!(bytes(3_100), "3.1 KB");
}

#[test]
fn claude_and_santree_say_what_runs_and_what_a_restart_ends() {
    let mut r = running();
    r.server.version = Some("2.1.4".into());
    r.home = Some("/Users/santiago".into());
    r.workdir = Some("/Users/santiago/projects".into());
    r.sessions = vec![
        crate::claude::Session {
            alive: true,
            ..Default::default()
        },
        crate::claude::Session {
            alive: true,
            ..Default::default()
        },
        crate::claude::Session::default(),
    ];
    let c = claude_rows(&r, &Policy::default());
    assert_eq!(c.title, "Claude · 2 sessions");
    assert_eq!(c.server, "Remote control: running 2.1.4");
    assert_eq!(c.folder, "Folder: ~/projects (the latest project)");
    assert_eq!(c.restart, "Restart remote control (ends 2 sessions)");
    let set = Policy {
        claude_workdir: Some("/Users/santiago/work".into()),
        ..Default::default()
    };
    assert_eq!(
        claude_rows(&r, &set).folder,
        "Folder: ~/work (set in Daedalus)"
    );
    let off = Report {
        state: ClaudeState::Off,
        ..Default::default()
    };
    assert_eq!(claude_rows(&off, &Policy::default()).title, "Claude · off");

    let mut p = linked_page();
    assert_eq!(santree_rows(Some(&p)).title, "santree · off");
    p.policy.santree = true;
    p.policy.session_host = Some(crate::link::wire::SessionHost {
        address: "s2.toscanini.me:7789".into(),
        public_key: String::new(),
    });
    p.santree = Some(crate::core::status::SantreeDoor {
        open: 1,
        max: 4,
        last_refused: None,
    });
    let s = santree_rows(Some(&p));
    assert_eq!(
        s,
        SantreeRows {
            title: "santree · 1 open".into(),
            host: "Session host: s2.toscanini.me:7789".into(),
            open: "Open connections: 1 of 4".into(),
            refused: "Last refused: —".into(),
        }
    );
}

#[cfg(not(target_os = "macos"))]
#[test]
fn the_tray_pairs_through_the_elevated_verb_with_checked_words_only() {
    let key = crate::identity::format_fingerprint(&[6; 32]);
    let args = |text: &str| crate::node::pair::parse_pasted(text).map(|p| pair_args(&p));
    assert_eq!(
        args(&format!(
            "sudo daedalus-agent pair --pin '{key}' --controller box.lan:7788"
        ))
        .unwrap(),
        ["pair", "--pin", &key, "--controller", "box.lan:7788"]
    );
    assert_eq!(args(&key).unwrap(), ["pair", "--pin", &key]);
    // Malformed pastes are refused before any prompt: no key, a key
    // that is not one, an address that is not host:port.
    for bad in [
        String::new(),
        "hello".into(),
        "3f2a:9c01".into(),
        format!("--pin {key} --controller '$(reboot):1'"),
        format!("--pin {key} --controller box.lan"),
        format!("--pin {key}x"),
    ] {
        assert!(pair_command(&bad).is_err(), "{bad:?}");
    }

    let exe = Path::new("/usr/local/bin/daedalus-agent");
    let a: Vec<String> = ["pair", "--pin", &key, "--controller", "box.lan:7788"]
        .map(String::from)
        .into();
    let os = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();

    // Linux: pkexec, the absolute binary, then the words as they are.
    let mut want = os(&["/run/wrappers/bin/pkexec", "/usr/local/bin/daedalus-agent"]);
    want.extend(a.iter().map(OsString::from));
    assert_eq!(
        pkexec_argv(Path::new("/run/wrappers/bin/pkexec"), exe, &a),
        want
    );

    // Windows: the parameters line, quoted as CommandLineToArgvW reads it.
    assert_eq!(
        windows_parameters(&a),
        format!("pair --pin {key} --controller box.lan:7788")
    );
    let q = |v: &[&str]| windows_parameters(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    assert_eq!(q(&["a b", ""]), "\"a b\" \"\"");
    assert_eq!(q(&["say \"hi\""]), "\"say \\\"hi\\\"\"");
    assert_eq!(q(&["C:\\dir\\ x\\"]), "\"C:\\dir\\ x\\\\\"");
    assert_eq!(q(&["C:\\plain\\"]), "C:\\plain\\");
}

/// A log-in's last step runs as root behind the administrator prompt:
/// a fixed script, the binary first after it, the words as arguments —
/// nothing the browser sent inside any `-e`.
#[test]
fn the_elevated_log_in_passes_its_words_as_arguments_only() {
    let exe = Path::new(
        "/Library/Application Support/daedalus-agent/Daedalus Agent.app/Contents/MacOS/daedalus-agent",
    );
    // What the callback brought back, as hostile as it may be, and a
    // prompt naming an account that is.
    let code = "c0de'; rm -rf / # box.example.org";
    let prompt = "It serves \"x\" & (do shell script \"id\")";
    let a: Vec<String> = vec!["enroll-finish".into(), code.into()];
    let v = osascript_argv(exe, &a, prompt);
    let at = v.iter().position(|w| w == exe.as_os_str()).unwrap();
    assert_eq!(
        v[at + 1..v.len() - 1],
        a.iter().map(OsString::from).collect::<Vec<_>>()
    );
    assert_eq!(v.last().unwrap(), prompt);
    for pair in v[..at].chunks(2) {
        assert_eq!(pair[0], "-e");
        let line = pair[1].to_str().unwrap();
        assert!(
            !line.contains("rm -rf") && !line.contains("box.example") && !line.contains("\"id\""),
            "{line}"
        );
    }
    let script: Vec<_> = v[..at].iter().skip(1).step_by(2).collect();
    assert!(script.iter().any(|l| l
        .to_str()
        .unwrap()
        .contains("with administrator privileges")));
    assert!(script
        .iter()
        .all(|l| !l.to_str().unwrap().contains("do shell script cmd &")));
}

/// Every glyph the menu names is in the bundle's sources, at both sizes.
#[test]
fn every_menu_glyph_ships_at_18_and_36_px() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("macos/icons");
    for name in ICONS {
        assert!(dir.join(format!("{name}.svg")).is_file(), "{name}.svg");
        for (file, px) in [
            (format!("{name}Template.png"), 18),
            (format!("{name}Template@2x.png"), 36),
        ] {
            let f = std::fs::File::open(dir.join(&file)).unwrap();
            let info = png::Decoder::new(std::io::BufReader::new(f))
                .read_info()
                .unwrap()
                .info()
                .clone();
            assert_eq!((info.width, info.height), (px, px), "{file}");
        }
    }
}
