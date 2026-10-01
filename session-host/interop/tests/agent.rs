//! A daedalus agent reaches the session host: the agent's own TLS client
//! (`daedalus_agent::link::tls::Client` — its pure-Rust provider, its
//! self-signed certificate, its SHA-256 pin) against the host's server config
//! (santree-remote-tls, ring). Both speak TLS 1.3 with ed25519 and nothing
//! else, so they meet on X25519 + ChaCha20-Poly1305, the one suite the agent
//! offers.
//!
//! - an allowed node key completes the handshake and gets `hello` answered;
//! - a key outside the allow-list completes its side of the handshake (TLS
//!   1.3) and reads the host's `access_denied` alert on its first read;
//! - the allow-list is written from the agent's own values (its node id and
//!   public key hex), and the host's node id agrees with the agent's.

use std::net::TcpStream;
use std::path::Path;
use std::time::{Duration, Instant};

use daedalus_agent::identity::{digest, Identity};
use daedalus_agent::link::tls::{Client, Recv, Tls};
use daedalus_session_host::{Config, Server};
use serde_json::{json, Value};

const WAIT: Duration = Duration::from_secs(10);

fn write_allow(path: &Path, nodes: &[&Identity]) {
    use std::os::unix::fs::PermissionsExt;
    let doc = json!({
        "schemaVersion": 1,
        "nodes": nodes.iter().map(|n| json!({
            "id": n.node_id(),
            "publicKey": n.public_key_hex(),
        })).collect::<Vec<_>>(),
    });
    std::fs::write(path, doc.to_string()).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

/// One request line, and the first line back (pings skipped).
fn call(tls: &mut Tls, line: &str) -> std::io::Result<Value> {
    tls.send(line)?;
    let deadline = Instant::now() + WAIT;
    loop {
        assert!(Instant::now() < deadline, "no answer in time");
        match tls.recv()? {
            Recv::Line(bytes) => {
                let frame: Value = serde_json::from_slice(&bytes).unwrap();
                if frame["e"] != "ping" {
                    return Ok(frame);
                }
            }
            Recv::Idle => {}
            Recv::Closed => {
                return Err(std::io::ErrorKind::UnexpectedEof.into());
            }
        }
    }
}

const HELLO: &str =
    r#"{"id":1,"m":"hello","p":{"protocol":1,"client":"daedalus-agent/test","owner":"o"}}"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_agents_client_meets_the_session_host() {
    let dir = tempfile::Builder::new()
        .prefix("dshi")
        .tempdir_in("/tmp")
        .unwrap();
    let d = dir.path();
    std::fs::create_dir_all(d.join("projects")).unwrap();
    let allowed = Identity::from_seed([1; 32]);
    let stranger = Identity::from_seed([2; 32]);
    assert_eq!(
        daedalus_session_host::allow::node_id_of(allowed.public_key().as_bytes()),
        allowed.node_id(),
        "one node id, however it is derived"
    );
    write_allow(&d.join("allow.json"), &[&allowed]);

    let server = Server::bind(Config {
        listen: vec!["127.0.0.1:0".parse().unwrap()],
        state_dir: d.join("state"),
        allow_list: d.join("allow.json"),
        hook_socket: d.join("hook.sock"),
        projects_root: d.join("projects"),
        workspaces: d.join("workspaces.json"),
        workspace_icons: d.join("icons"),
        hook_bin: "/bin/true".into(),
        file: None,
    })
    .await
    .unwrap();
    let addr = server.local_addrs()[0];
    // The agent pins a key by its SHA-256 (config.toml's pin format).
    let pin = digest(&server.host_key());
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let serving = tokio::spawn(server.run(async {
        let _ = stopped.await;
    }));

    tokio::task::spawn_blocking(move || {
        // Allowed: the handshake completes and hello is answered.
        let client = Client::new(&allowed).unwrap();
        let mut tls = client
            .connect(TcpStream::connect(addr).unwrap(), pin, WAIT)
            .unwrap_or_else(|e| panic!("{e:?}"));
        let hello = call(&mut tls, HELLO).unwrap();
        assert_eq!(hello["id"], 1, "{hello}");
        assert_eq!(hello["ok"]["protocol"], 1, "{hello}");
        assert_eq!(
            hello["ok"]["features"],
            json!(["workspaces.list", "workspaces.icon"])
        );
        tls.close();

        // Not in the allow-list: the connect succeeds (TLS 1.3), and the
        // host's refusal is the first thing read. Nothing is written first:
        // the host refuses without waiting for a request and closes, and a
        // write racing that close fails with a broken pipe before the alert
        // is read.
        let client = Client::new(&stranger).unwrap();
        let mut tls = client
            .connect(TcpStream::connect(addr).unwrap(), pin, WAIT)
            .unwrap_or_else(|e| panic!("{e:?}"));
        let deadline = Instant::now() + WAIT;
        let refused = loop {
            assert!(Instant::now() < deadline, "no refusal in time");
            match tls.recv() {
                Ok(Recv::Idle) => {}
                Ok(Recv::Line(l)) => {
                    panic!("a stranger was answered: {}", String::from_utf8_lossy(&l))
                }
                Ok(Recv::Closed) => panic!("closed without the refusal"),
                Err(e) => break e,
            }
        };
        assert!(
            refused.to_string().contains("AccessDenied"),
            "expected access_denied, got {refused}"
        );
    })
    .await
    .unwrap();

    let _ = stop.send(());
    serving.await.unwrap();
}
