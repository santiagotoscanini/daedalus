use std::io::{Read, Write};
use std::path::Path;
use std::time::Instant;

use super::*;
use crate::api::wire::{EnrollController, WireguardConfig};
use crate::core::config::Mode;
use crate::core::role::Role;

const APP: &str = "https://daedalus-app.example.org";

fn fp(n: u8) -> String {
    format_fingerprint(&[n; 32])
}

fn wg(n: u8) -> String {
    crate::node::tunnel::wg_key(&[n; 32])
}

fn scratch(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("daedalus-enroll-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn files(dir: &Path) -> Files {
    Files {
        identity: dir.join("identity.key"),
        tunnel: dir.join("tunnel.toml"),
        config: dir.join("config.toml"),
        policy: dir.join("policy.json"),
    }
}

fn node() -> Shared {
    Shared::new(
        Role::of(Mode::Node),
        crate::core::facts::Facts::default(),
        crate::core::state::State::default(),
        crate::link::wire::Policy::default(),
        crate::util::Shutdown::new(),
    )
}

/// What the app hands back for `node`: a wg-easy client of a box at
/// 192.168.0.2, whose link is on :7788.
fn redeemed(node: &str) -> EnrollRedeemed {
    EnrollRedeemed {
        node: node.into(),
        controller: EnrollController {
            pin: fp(1),
            address: "192.168.0.2:7788".into(),
        },
        wireguard: WireguardConfig {
            private_key: wg(2),
            address: "10.8.0.5/32".into(),
            server_public_key: wg(3),
            preshared_key: Some(wg(4)),
            endpoint: "box.example.org:51820".into(),
            allowed_ips: vec!["192.168.0.2/32".into()],
        },
    }
}

#[test]
fn the_app_is_https_host_and_port_and_nothing_else() {
    assert_eq!(
        app_url(" https://Daedalus-App.example.org/ ").unwrap(),
        "https://daedalus-app.example.org"
    );
    assert_eq!(
        app_url("https://box.example.org:8443").unwrap(),
        "https://box.example.org:8443"
    );
    for bad in [
        "http://box.example.org",
        "box.example.org",
        "https://",
        "https://box.example.org/agent",
        "https://box.example.org?x=1",
        "https://user@box.example.org",
        "https://box.example.org:0",
        "https://box..example.org",
        "https://box.example.org#frag",
        "javascript:alert(1)",
    ] {
        assert!(app_url(bad).is_err(), "{bad}");
    }
}

#[test]
fn pkce_is_rfc_7636_s256() {
    // base64url(SHA-256(verifier)), unpadded: the value coreutils gives
    // (`printf %s VERIFIER | sha256sum`, the digest base64url-encoded).
    assert_eq!(
        challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWjOEjXk"),
        "VYFANLqdx_HDV6BqEhluZJ63rtrIPROSSFdB3P6G83I"
    );
    let v = random_token();
    assert_eq!(
        v.len(),
        43,
        "32 bytes, base64url: RFC 7636's shortest verifier"
    );
    assert_ne!(v, random_token());
}

#[test]
fn the_callback_is_this_log_ins_and_carries_a_code() {
    let state = "s".repeat(43);
    let code = "c0de-c0de_c0de-c0de";
    assert_eq!(
        callback(&format!("state={state}&code={code}"), &state),
        Ok(Ok(Outcome::Code(code.into())))
    );
    // Another log-in's state, none, or a field twice: not this one's.
    assert_eq!(
        callback(&format!("state={}&code={code}", "t".repeat(43)), &state),
        Err(Stale)
    );
    assert_eq!(callback(&format!("code={code}"), &state), Err(Stale));
    assert_eq!(
        callback(&format!("state={state}&code={code}&code=x"), &state),
        Err(Stale)
    );
    // Declined, or said something else.
    assert_eq!(
        callback(&format!("state={state}&error=denied"), &state),
        Ok(Ok(Outcome::Denied))
    );
    assert!(matches!(
        callback(&format!("state={state}&error=boom"), &state),
        Ok(Err(_))
    ));
    // No code, or not one the app hands out.
    assert!(matches!(
        callback(&format!("state={state}"), &state),
        Ok(Err(_))
    ));
    for bad in ["short", "has%20space%20in%20it%20ok", &"x".repeat(129)] {
        assert!(
            matches!(
                callback(&format!("state={state}&code={bad}"), &state),
                Ok(Err(_))
            ),
            "{bad}"
        );
    }
}

fn a_begin() -> Begin {
    Begin {
        app_url: APP.into(),
        public_key: "ab".repeat(32),
        fingerprint: fp(3),
        hostname: "Santiago’s MacBook Pro (2)".into(),
        os: "macos".into(),
        arch: "aarch64".into(),
        version: "0.23.0".into(),
        code_challenge: challenge_of("v"),
    }
}

#[test]
fn the_page_opened_names_this_machine_the_callback_and_the_challenge() {
    let b = a_begin();
    let url = enroll_url(&b, 50123, "st-ate_1");
    let (base, query) = url.split_once('?').unwrap();
    assert_eq!(base, "https://daedalus-app.example.org/agent/enroll");
    let got: std::collections::HashMap<String, String> = form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect();
    assert_eq!(got["key"], b.public_key);
    assert_eq!(got["name"], b.hostname);
    assert_eq!(got["port"], "50123");
    assert_eq!(got["state"], "st-ate_1");
    assert_eq!(got["code_challenge"], b.code_challenge);
    assert_eq!(got["code_challenge_method"], "S256");
    assert_eq!(got["os"], "macos");
    assert_eq!(got.len(), 9, "public values only: {got:?}");
}

/// One GET to the loopback listener: its status code.
fn get(port: u16, path: &str) -> u16 {
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut text = String::new();
    let _ = s.read_to_string(&mut text);
    text.split_whitespace().nth(1).unwrap().parse().unwrap()
}

#[test]
fn the_loopback_takes_one_callback_and_refuses_the_rest() {
    let l = Loopback::new().unwrap();
    let url = l.url(&a_begin());
    let q: std::collections::HashMap<String, String> =
        form_urlencoded::parse(url.split_once('?').unwrap().1.as_bytes())
            .into_owned()
            .collect();
    let (port, state) = (q["port"].parse::<u16>().unwrap(), q["state"].clone());
    assert_eq!(state.len(), 43, "256 bits, base64url");
    let waiting = std::thread::spawn(move || l.wait(Duration::from_secs(10)));
    assert_eq!(get(port, "/"), 404);
    assert_eq!(
        get(port, "/callback?state=wrong&code=c0de-c0de_c0de-c0de"),
        400
    );
    assert_eq!(
        get(
            port,
            &format!("/callback?state={state}&code=c0de-c0de_c0de-c0de")
        ),
        200
    );
    assert_eq!(
        waiting.join().unwrap(),
        Ok(Outcome::Code("c0de-c0de_c0de-c0de".into()))
    );

    // Nobody comes: an error in time.
    let l = Loopback::new().unwrap();
    let t = Instant::now();
    assert!(l.wait(Duration::from_millis(300)).is_err());
    assert!(t.elapsed() < Duration::from_secs(3));
}

#[test]
fn only_the_operator_logs_in_and_only_root_finishes() {
    let own = crate::os::own_uid().unwrap();
    assert!(may_finish(Some(&Peer::Uid(0))));
    assert!(may_finish(Some(&Peer::Uid(own))));
    assert!(!may_finish(None));
    if own != 0 {
        assert!(!may_finish(Some(&Peer::Uid(own + 1))));
    }
    assert!(may_enroll(Some(&Peer::Uid(0))));
    assert!(!may_enroll(None));
}

#[test]
fn logging_in_redeems_once_with_the_verifier_and_logging_out_forgets_it() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("flow");
    let f = files(&dir);
    std::fs::write(&f.config, "# mine\ntelemetry = \"minimal\"\n").unwrap();
    let s = node();
    let me = Identity::load_or_create_at(&f.identity).unwrap().node_id();
    let begin_now = |s: &Shared| {
        begin(
            s,
            &f,
            BeginParams {
                app_url: "https://Daedalus-App.example.org/".into(),
            },
        )
        .unwrap()
    };
    let code = || FinishParams {
        code: "c0de-c0de_c0de-c0de".into(),
    };

    // Finishing what nobody began redeems nothing.
    let e = finish(&s, &f, code(), |_, _| panic!("redeemed")).unwrap_err();
    assert!(e.msg.contains("no log-in waits"), "{}", e.msg);

    // Begin: the machine, and a challenge whose verifier stays here.
    let b = begin_now(&s);
    assert_eq!(b.app_url, APP);
    assert_eq!(b.public_key.len(), 64);
    assert_eq!(b.code_challenge.len(), 43);

    // Finish: the redeem goes to the app begun with, the verifier matches
    // the challenge, and the answer is written and linked through.
    let mut asked = None;
    let said = finish(&s, &f, code(), |app, body| {
        asked = Some((app.to_string(), body.clone()));
        Ok(redeemed(&me))
    })
    .unwrap();
    assert!(said.contains("192.168.0.2:7788"), "{said}");
    let (app, body) = asked.unwrap();
    assert_eq!(app, APP);
    assert_eq!(body.code, "c0de-c0de_c0de-c0de");
    assert_eq!(challenge_of(&body.code_verifier), b.code_challenge);
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&f.tunnel), 0o600);
    let text = std::fs::read_to_string(&f.config).unwrap();
    assert!(
        text.starts_with("# mine\ntelemetry = \"minimal\"\n"),
        "{text}"
    );
    let cfg = crate::core::config::load_at(&f.config).unwrap();
    assert_eq!(cfg.controller_pin.as_deref(), Some(fp(1).as_str()));
    assert_eq!(cfg.controller_address.as_deref(), Some("192.168.0.2:7788"));
    assert_eq!(cfg.app_url.as_deref(), Some(APP));
    assert!(matches!(s.link.dialer(), Dialer::Tunnel(_)));
    assert_eq!(s.link.keys().0.pin.as_deref(), Some(fp(1).as_str()));
    let st = s.link.tunnel_status().unwrap();
    assert_eq!(st.address, "10.8.0.5");
    assert_eq!(st.endpoint, "box.example.org:51820");

    // Logged in: begin and finish are refused until a log-out.
    let e = begin(
        &s,
        &f,
        BeginParams {
            app_url: APP.into(),
        },
    )
    .unwrap_err();
    assert!(e.msg.contains("log out first"), "{}", e.msg);
    let e = finish(&s, &f, code(), |_, _| panic!("redeemed")).unwrap_err();
    assert!(e.msg.contains("log out first"), "{}", e.msg);

    // The service starting again takes the tunnel up from the file.
    let again = node();
    start(&again, &f);
    assert!(matches!(again.link.dialer(), Dialer::Tunnel(_)));

    // Log out: the file gone, the keys cleared, the app kept for the prompt.
    std::fs::write(&f.policy, "{}").unwrap();
    leave(&s, &f).unwrap();
    for p in [&f.tunnel, &f.policy] {
        assert!(!p.exists(), "{}", p.display());
    }
    let cfg = crate::core::config::load_at(&f.config).unwrap();
    assert_eq!(cfg.controller_pin, None);
    assert_eq!(cfg.controller_address, None);
    assert_eq!(cfg.app_url.as_deref(), Some(APP));
    assert!(matches!(s.link.dialer(), Dialer::Direct));
    assert!(!s.link.keys().0.paired());
    // Logged out already is no error.
    leave(&s, &f).unwrap();

    // A code is redeemed once: the verifier went with the first finish.
    begin_now(&s);
    let refused = finish(&s, &f, code(), |_, _| Err("403: used".into())).unwrap_err();
    assert!(refused.msg.contains("used"), "{}", refused.msg);
    let e = finish(&s, &f, code(), |_, _| panic!("redeemed twice")).unwrap_err();
    assert!(e.msg.contains("no log-in waits"), "{}", e.msg);

    // An answer for another machine, a tunnel that reaches more than the
    // box, a controller outside it, a pin that is not one: refused, and
    // nothing written.
    let mut wide = redeemed(&me);
    wide.wireguard.allowed_ips = vec!["0.0.0.0/0".into()];
    let mut outside = redeemed(&me);
    outside.controller.address = "192.168.0.9:7788".into();
    let mut no_pin = redeemed(&me);
    no_pin.controller.pin = "nope".into();
    for (why, bad) in [
        ("another node", redeemed("0123456789abcdef")),
        ("AllowedIPs 0.0.0.0/0", wide),
        ("a controller outside the tunnel", outside),
        ("a pin that is not one", no_pin),
    ] {
        begin_now(&s);
        assert!(
            finish(&s, &f, code(), move |_, _| Ok(bad)).is_err(),
            "{why}"
        );
        assert!(!f.tunnel.exists(), "{why}: written");
        assert!(crate::core::config::load_at(&f.config)
            .unwrap()
            .controller_pin
            .is_none());
    }

    // A tunnel config that does not parse refuses every dial at start.
    std::fs::write(&f.tunnel, "address = 1\n").unwrap();
    std::fs::set_permissions(&f.tunnel, std::fs::Permissions::from_mode(0o600)).unwrap();
    let broken = node();
    start(&broken, &f);
    assert!(matches!(broken.link.dialer(), Dialer::Refused(_)));
    assert!(broken.link.tunnel_status().unwrap().error.is_some());
    let _ = std::fs::remove_dir_all(dir);
}
