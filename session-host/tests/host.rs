//! The built binary, end to end: `serve --config` on 127.0.0.1:0 with a
//! throwaway host key and allow-list, driven over the pinned TLS link by a raw
//! JSON-lines client (exact wire order) and by santree's own `RemoteClient`
//! (conformance with the app), each presenting a throwaway node key.

use std::io::Write as _;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use santree_remote_client::proto::{
    Anchor, ErrorCode, ExecParams, FsKind, FsReadParams, FsStat, PtyOpenParams, ReplayMode,
};
use santree_remote_client::{PtyEvent, RemoteClient, RemoteError};
use santree_remote_tls::{Identity, Refusal};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use tokio::net::{TcpStream, UnixStream};

const BIN: &str = env!("CARGO_BIN_EXE_daedalus-session-host");
const WAIT: Duration = Duration::from_secs(10);

type Tls = santree_remote_tls::ClientStream<TcpStream>;

/// Tests that fork real shells behind real PTYs run one at a time, as
/// santree-pty's own suite does: parallel PTY allocation contends for the
/// pty table.
async fn pty_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    SERIAL.lock().await
}

fn tempdir() -> tempfile::TempDir {
    // Under /tmp: a unix socket path must fit in 108 bytes.
    tempfile::Builder::new()
        .prefix("dsh")
        .tempdir_in("/tmp")
        .unwrap()
}

fn node_id(key: &[u8; 32]) -> String {
    daedalus_session_host::allow::node_id_of(key)
}

/// Write the allow-list as the controller does: a 0600 temp file renamed
/// over it.
fn write_allow(path: &Path, nodes: &[&Identity]) {
    use std::os::unix::fs::PermissionsExt;
    let doc = json!({
        "schemaVersion": 1,
        "nodes": nodes.iter().map(|n| json!({
            "id": node_id(&n.public_key()),
            "publicKey": santree_remote_tls::key_hex(&n.public_key()),
        })).collect::<Vec<_>>(),
    });
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, doc.to_string()).unwrap();
    std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::rename(&temp, path).unwrap();
}

// ── the host process ──────────────────────────────────────────────────────

struct Host {
    child: Child,
    dir: PathBuf,
    addr: SocketAddr,
    key: [u8; 32],
    /// The node every test connects as, allowed at start.
    node: Identity,
}

impl Host {
    fn root(&self) -> PathBuf {
        self.dir.join("projects")
    }
    fn hook_socket(&self) -> PathBuf {
        self.dir.join("run/hook.sock")
    }
    fn allow_list(&self) -> PathBuf {
        self.dir.join("allow.json")
    }
    fn status_file(&self) -> PathBuf {
        self.dir.join("state/status.json")
    }

    /// `serve` with everything under `dir`, HOME = `dir`.
    fn start(dir: &Path) -> Host {
        let node = Identity::generate().unwrap();
        std::fs::create_dir_all(dir.join("projects")).unwrap();
        write_allow(&dir.join("allow.json"), &[&node]);
        let config = json!({
            "listen": ["127.0.0.1:0"],
            "stateDir": dir.join("state"),
            "allowList": dir.join("allow.json"),
            "hookSocket": dir.join("run/hook.sock"),
            "projectsRoot": dir.join("projects"),
            "workspaces": dir.join("workspaces.json"),
            "workspaceIcons": dir.join("icons"),
            "hookBin": BIN,
        });
        std::fs::write(dir.join("config.json"), config.to_string()).unwrap();
        // A status file from a previous run is not this one's.
        let _ = std::fs::remove_file(dir.join("state/status.json"));
        let child = Command::new(BIN)
            .args(["serve", "--config"])
            .arg(dir.join("config.json"))
            .env("HOME", dir)
            .env("SESSION_HOST_LOG", "warn")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let status_file = dir.join("state/status.json");
        let deadline = Instant::now() + WAIT;
        let status = loop {
            if let Ok(bytes) = std::fs::read(&status_file) {
                break serde_json::from_slice::<Value>(&bytes).unwrap();
            }
            assert!(Instant::now() < deadline, "serve never wrote its status");
            std::thread::sleep(Duration::from_millis(10));
        };
        let addr = status["listen"][0].as_str().unwrap().parse().unwrap();
        let key = santree_remote_tls::parse_key_hex(status["hostKey"].as_str().unwrap()).unwrap();
        Host {
            child,
            dir: dir.to_path_buf(),
            addr,
            key,
            node,
        }
    }

    fn signal(&self, sig: i32) {
        // SAFETY: plain kill(2) on our own child.
        assert_eq!(unsafe { libc::kill(self.child.id() as i32, sig) }, 0);
    }

    fn wait(&mut self) -> std::process::ExitStatus {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "serve did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// A TLS connection as `node`.
    async fn tls_as(&self, node: &Identity) -> Tls {
        let tcp = TcpStream::connect(self.addr).await.unwrap();
        santree_remote_tls::connect(santree_remote_tls::client_config(node, self.key), tcp)
            .await
            .unwrap()
    }

    async fn tls(&self) -> Tls {
        self.tls_as(&self.node).await
    }

    async fn raw(&self) -> Raw {
        Raw::over(self.tls().await)
    }

    async fn greeted(&self) -> Raw {
        let mut raw = self.raw().await;
        let hello = raw.hello(1).await;
        assert!(hello.get("ok").is_some(), "{hello}");
        raw
    }

    async fn client(&self) -> RemoteClient {
        let (r, w) = tokio::io::split(self.tls().await);
        let client = RemoteClient::new(r, w);
        client.hello("santree/test", "owner-a").await.unwrap();
        client
    }

    fn root_str(&self) -> String {
        self.root().to_string_lossy().into_owned()
    }
}

impl Drop for Host {
    /// SIGTERM first, so the host closes its PTYs; SIGKILL if it hangs.
    fn drop(&mut self) {
        // SAFETY: plain kill(2) on our own child.
        unsafe { libc::kill(self.child.id() as i32, libc::SIGTERM) };
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ── a raw JSON-lines client ───────────────────────────────────────────────

struct Raw {
    reader: BufReader<ReadHalf<Tls>>,
    writer: WriteHalf<Tls>,
    next: u64,
}

impl Raw {
    fn over(tls: Tls) -> Raw {
        let (r, w) = tokio::io::split(tls);
        Raw {
            reader: BufReader::new(r),
            writer: w,
            next: 1,
        }
    }

    async fn send_line(&mut self, line: &str) {
        self.writer.write_all(line.as_bytes()).await.unwrap();
        self.writer.write_all(b"\n").await.unwrap();
        self.writer.flush().await.unwrap();
    }

    async fn send(&mut self, m: &str, p: Value) -> u64 {
        let id = self.next;
        self.next += 1;
        self.send_line(&json!({"id": id, "m": m, "p": p}).to_string())
            .await;
        id
    }

    /// The next frame, pings included.
    async fn frame(&mut self) -> Value {
        let mut line = String::new();
        let n = tokio::time::timeout(WAIT, self.reader.read_line(&mut line))
            .await
            .expect("no frame in time")
            .unwrap();
        assert!(n > 0, "connection closed");
        serde_json::from_str(&line).unwrap()
    }

    /// The next frame that is not a ping.
    async fn next(&mut self) -> Value {
        loop {
            let frame = self.frame().await;
            if frame["e"] != "ping" {
                return frame;
            }
        }
    }

    /// Send and return the response, which must be the next non-ping frame.
    async fn call(&mut self, m: &str, p: Value) -> Value {
        let id = self.send(m, p).await;
        let frame = self.next().await;
        assert_eq!(frame["id"], id, "expected the response to {m}: {frame}");
        frame
    }

    async fn ok(&mut self, m: &str, p: Value) -> Value {
        let frame = self.call(m, p).await;
        frame
            .get("ok")
            .cloned()
            .unwrap_or_else(|| panic!("{m} failed: {frame}"))
    }

    async fn hello(&mut self, protocol: u32) -> Value {
        self.call(
            "hello",
            json!({"protocol": protocol, "client": "test/1", "owner": "owner-a"}),
        )
        .await
    }

    /// Resolves once the host has closed the connection (reading and
    /// discarding whatever was still in flight).
    async fn closed(&mut self, within: Duration) {
        let mut sink = vec![0u8; 64 * 1024];
        tokio::time::timeout(within, async {
            loop {
                match self.reader.read(&mut sink).await {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        })
        .await
        .expect("the host did not close the connection in time");
    }
}

/// A line on the local hook socket, and its answer.
async fn hook_call(socket: &Path, line: Value) -> Value {
    let (r, mut w) = UnixStream::connect(socket).await.unwrap().into_split();
    w.write_all(format!("{line}\n").as_bytes()).await.unwrap();
    let mut answer = String::new();
    tokio::time::timeout(WAIT, BufReader::new(r).read_line(&mut answer))
        .await
        .unwrap()
        .unwrap();
    serde_json::from_str(&answer).unwrap()
}

async fn push_hook(socket: &Path, event: &str, env: Value, stdin: &[u8]) -> u64 {
    let answer = hook_call(
        socket,
        json!({"id": 1, "m": "hooks.push", "p": {"event": event, "env": env, "stdin": b64(stdin)}}),
    )
    .await;
    answer["ok"]["seq"].as_u64().unwrap()
}

fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

fn unb64(v: &Value) -> Vec<u8> {
    B64.decode(v.as_str().unwrap()).unwrap()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn open(host: &Host, command: &str, args: &[&str]) -> Value {
    json!({"cwd": host.root_str(), "command": command, "args": args, "cols": 80, "rows": 24,
           "env": [], "owner": "owner-a", "label": "test"})
}

fn read_status(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

async fn wait_until(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !f() {
        assert!(Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ── CLI and the hook socket's lifecycle ───────────────────────────────────

#[test]
fn version_is_exact() {
    let out = Command::new(BIN).arg("--version").output().unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        "daedalus-session-host 0.1.0 protocol 1\n"
    );
}

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

// ── 1. handshake ──────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_version_refusal_and_the_hello_gate() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.raw().await;

    // Garbage and blank lines get no answer; the next request still works.
    raw.send_line("not json").await;
    raw.send_line("").await;

    let early = raw.call("pty.sessions", json!({})).await;
    assert_eq!(early["err"]["code"], "bad_request");
    assert_eq!(early["err"]["msg"], "send hello first");
    // hooks.push is not served on the link, before hello or after.
    let push = json!({"event": "Stop", "env": [], "stdin": ""});
    assert_eq!(
        raw.call("hooks.push", push.clone()).await["err"]["code"],
        "bad_request"
    );

    let refused = raw.hello(99).await;
    assert_eq!(refused["err"]["code"], "version");
    assert_eq!(refused["err"]["protocol"], 1);

    let hello = raw.hello(1).await["ok"].clone();
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["version"], "0.1.0");
    assert_eq!(hello["home"], dir.path().to_str().unwrap());
    assert_eq!(hello["projectsRoot"], host.root_str());
    assert_eq!(hello["hookBin"], BIN);
    assert_eq!(
        hello["features"],
        json!(["workspaces.list", "workspaces.icon"])
    );
    let boot = hello["bootId"].as_str().unwrap();
    assert_eq!(boot.len(), 16);
    assert!(boot.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(!hello["hostname"].as_str().unwrap().is_empty());
    assert!(raw
        .ok("pty.sessions", json!({}))
        .await
        .as_array()
        .unwrap()
        .is_empty());
    let push = raw.call("hooks.push", push).await;
    assert_eq!(push["err"]["code"], "bad_request");
    assert!(push["err"]["msg"].as_str().unwrap().contains("hook socket"));
    // hello is repeatable, and the boot is the same.
    assert_eq!(raw.hello(1).await["ok"]["bootId"], boot);
    let unknown = raw.call("pty.teleport", json!({})).await;
    assert_eq!(unknown["err"]["code"], "bad_request");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_real_client_handshakes_and_is_refused_cleanly() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let (r, w) = tokio::io::split(host.tls().await);
    let client = RemoteClient::new(r, w);
    let early = client.pty_sessions().await.unwrap_err();
    assert_eq!(early.code(), Some(&ErrorCode::BadRequest));
    let refused = client
        .call::<santree_remote_client::proto::m::Hello>(
            &santree_remote_client::proto::HelloParams {
                protocol: 2,
                client: "santree/test".into(),
                owner: "o".into(),
            },
        )
        .await
        .unwrap_err();
    match refused {
        RemoteError::Remote(e) => {
            assert_eq!(e.code, ErrorCode::Version);
            assert_eq!(e.protocol, Some(1));
        }
        other => panic!("{other:?}"),
    }
    assert!(!client.is_closed());
    let hello = client.hello("santree/test", "o").await.unwrap();
    assert_eq!(hello.version, "0.1.0");
    assert!(hello.supports::<santree_remote_client::proto::m::WorkspacesList>());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unlisted_key_gets_access_denied_on_its_first_read() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let stranger = Identity::generate().unwrap();
    // TLS 1.3: the client's side of the handshake completes…
    let tls = host.tls_as(&stranger).await;
    let mut raw = Raw::over(tls);
    raw.send_line(r#"{"id":1,"m":"hello","p":{"protocol":1,"client":"x","owner":"o"}}"#)
        .await;
    // …and the refusal is the first read.
    let mut line = String::new();
    let e = tokio::time::timeout(WAIT, raw.reader.read_line(&mut line))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(Refusal::of(&e), Some(Refusal::NotEnrolled), "{e}");

    // A client pinning another host key refuses the host itself.
    let tcp = TcpStream::connect(host.addr).await.unwrap();
    let e =
        santree_remote_tls::connect(santree_remote_tls::client_config(&host.node, [7; 32]), tcp)
            .await
            .unwrap_err();
    assert_eq!(Refusal::of(&e), Some(Refusal::HostKeyMismatch), "{e}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_ping_comes_after_one_interval() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    let started = Instant::now();
    let mut line = String::new();
    let n = tokio::time::timeout(Duration::from_secs(20), raw.reader.read_line(&mut line))
        .await
        .expect("no ping within 20s")
        .unwrap();
    assert!(n > 0);
    assert_eq!(line.trim_end(), r#"{"e":"ping"}"#);
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_secs(13),
        "first ping after {waited:?}"
    );
}

// ── 2. reattach without gaps or duplicates ────────────────────────────────

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
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut second = host.greeted().await;
    let listed = second.ok("pty.sessions", json!({})).await;
    assert_eq!(listed[0]["attached"], false, "a drop detaches");
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

// ── 3. exit ───────────────────────────────────────────────────────────────

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

// ── 4. exec ───────────────────────────────────────────────────────────────

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

// ── 5. fs ─────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_reads_writes_and_confines() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let client = host.client().await;
    let root = host.root();
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let s = |p: &Path| p.to_string_lossy().into_owned();

    // Atomic write, parents created, mode applied; an overwrite keeps it.
    let file = root.join("deep/dir/hello.txt");
    client
        .fs_write(&s(&file), b"hello world".to_vec(), Some(0o640))
        .await
        .unwrap();
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o7777;
    assert_eq!(mode(&file), 0o640);
    client
        .fs_write(&s(&file), b"hello world".to_vec(), None)
        .await
        .unwrap();
    assert_eq!(mode(&file), 0o640);
    let leftovers: Vec<_> = std::fs::read_dir(file.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(leftovers.len(), 1, "no temp files left: {leftovers:?}");

    // A write's parent must be under the projects root, through no symlink.
    let escape_dir = root.join("escape-dir");
    std::os::unix::fs::symlink(&outside, &escape_dir).unwrap();
    for path in [
        outside.join("x"),
        escape_dir.join("x"),
        root.join("../outside/y"),
    ] {
        let refused = client
            .fs_write(&s(&path), b"no".to_vec(), None)
            .await
            .unwrap_err();
        assert_eq!(refused.code(), Some(&ErrorCode::Outside), "{path:?}");
    }
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);

    let read = |offset: Option<i64>, len: Option<u64>, within: Option<String>| FsReadParams {
        path: s(&file),
        offset,
        len,
        within,
    };
    let whole = client
        .fs_read(&read(None, None, Some(s(&root))))
        .await
        .unwrap();
    assert_eq!(
        (whole.data.as_slice(), whole.size, whole.eof),
        (&b"hello world"[..], 11, true)
    );
    let head = client.fs_read(&read(Some(0), Some(5), None)).await.unwrap();
    assert_eq!((head.data.as_slice(), head.eof), (&b"hello"[..], false));
    let tail = client.fs_read(&read(Some(-5), None, None)).await.unwrap();
    assert_eq!((tail.data.as_slice(), tail.eof), (&b"world"[..], true));

    // Reads are not confined to the root; `within` still confines one.
    std::fs::write(outside.join("secret"), b"nope").unwrap();
    let plain = client
        .fs_read(&FsReadParams {
            path: s(&outside.join("secret")),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(plain.data, b"nope");
    let link = root.join("escape");
    std::os::unix::fs::symlink(outside.join("secret"), &link).unwrap();
    for path in [s(&link), format!("{}/../outside/secret", s(&root))] {
        let refused = client
            .fs_read(&FsReadParams {
                path,
                within: Some(s(&root)),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(refused.code(), Some(&ErrorCode::Outside));
    }
    let relative = client
        .fs_read(&FsReadParams {
            path: "relative".into(),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(relative.code(), Some(&ErrorCode::BadRequest));
    let a_dir = client
        .fs_read(&FsReadParams {
            path: s(&root),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(a_dir.code(), Some(&ErrorCode::Io));

    // stat is an lstat; a missing path is an answer, ENOTDIR an io error.
    let st = client.fs_stat(&s(&link)).await.unwrap();
    assert_eq!((st.exists, st.kind), (true, Some(FsKind::Symlink)));
    let st = client.fs_stat(&s(&file)).await.unwrap();
    assert_eq!((st.kind, st.size), (Some(FsKind::File), 11));
    assert!(st.mtime_ms > 0);
    assert_eq!(
        client.fs_stat(&s(&root)).await.unwrap().kind,
        Some(FsKind::Dir)
    );
    assert_eq!(
        client.fs_stat(&s(&root.join("nope"))).await.unwrap(),
        FsStat::default()
    );
    let notdir = client
        .fs_stat(&format!("{}/below", s(&file)))
        .await
        .unwrap_err();
    assert_eq!(notdir.code(), Some(&ErrorCode::Io));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_path_stats_as_the_exact_default_object() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    let missing = dir.path().join("missing");
    let st = raw
        .ok("fs.stat", json!({"path": missing.to_str().unwrap()}))
        .await;
    assert_eq!(
        st,
        json!({"exists": false, "kind": null, "size": 0, "mtimeMs": 0})
    );
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

// ── 6. workspaces ─────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspaces_list_serves_the_snapshot() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    let root = host.root_str();

    // No snapshot yet: an empty list, generatedAt null.
    assert_eq!(
        raw.ok("workspaces.list", json!({})).await,
        json!({"root": root, "generatedAt": null, "workspaces": []})
    );

    // As the workspace sync publishes it (host/workspace-lib.sh).
    let sync = json!({"result": "ok", "detail": "", "at": "2026-09-29T10:00:00+00:00"});
    let snapshot = json!({
        "daedalusExport": 1, "domain": "workspaces", "schemaVersion": 1, "source": "host",
        "revision": null, "generatedAt": "2026-09-29T10:00:01+00:00",
        "data": {"root": root, "workspaces": [
            {"name": "web", "remote": "o/web", "branch": "main", "head": "abc123def456",
             "headAt": "2026-09-28T09:00:00+00:00", "dirty": true, "ahead": 1, "behind": 0,
             "sync": sync},
            {"name": "fresh", "remote": null, "branch": null, "head": null, "headAt": null,
             "dirty": false, "ahead": null, "behind": null, "sync": null},
            {"name": "..", "remote": null, "branch": null, "head": null, "headAt": null,
             "dirty": false, "ahead": null, "behind": null, "sync": null},
        ]},
    });
    std::fs::write(dir.path().join("workspaces.json"), snapshot.to_string()).unwrap();
    assert_eq!(
        raw.ok("workspaces.list", json!({})).await,
        json!({"root": root, "generatedAt": "2026-09-29T10:00:01+00:00", "workspaces": [
            {"name": "web", "path": format!("{root}/web"), "remote": "o/web", "branch": "main",
             "head": "abc123def456", "headAt": "2026-09-28T09:00:00+00:00", "dirty": true,
             "ahead": 1, "behind": 0, "sync": sync},
            {"name": "fresh", "path": format!("{root}/fresh"), "remote": null, "branch": null,
             "head": null, "headAt": null, "dirty": false, "ahead": null, "behind": null,
             "sync": null},
        ]})
    );

    // A snapshot of another root describes other checkouts: none are served.
    let mut other = snapshot.clone();
    other["data"]["root"] = json!("/elsewhere");
    std::fs::write(dir.path().join("workspaces.json"), other.to_string()).unwrap();
    assert_eq!(
        raw.ok("workspaces.list", json!({})).await["workspaces"],
        json!([])
    );
    std::fs::write(dir.path().join("workspaces.json"), "{").unwrap();
    assert_eq!(
        raw.call("workspaces.list", json!({})).await["err"]["code"],
        "io"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspaces_icon_serves_the_exported_icon() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;

    // No icon directory yet (the app has not exported): not_found.
    assert_eq!(
        raw.call("workspaces.icon", json!({"name": "web"})).await["err"]["code"],
        "not_found"
    );

    // As the app writes it (app/src/host/workspace-icons.ts).
    let icons = dir.path().join("icons");
    std::fs::create_dir_all(&icons).unwrap();
    let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
    std::fs::write(icons.join("web.icon"), png).unwrap();
    use base64::Engine;
    assert_eq!(
        raw.ok("workspaces.icon", json!({"name": "web"})).await,
        json!({"contentType": "image/png",
               "data": base64::engine::general_purpose::STANDARD.encode(png)})
    );

    std::fs::write(icons.join("page.icon"), "<html>not an icon</html>").unwrap();
    assert_eq!(
        raw.call("workspaces.icon", json!({"name": "page"})).await["err"]["code"],
        "not_found"
    );
    assert_eq!(
        raw.call("workspaces.icon", json!({"name": "../web"})).await["err"]["code"],
        "bad_request"
    );
    assert_eq!(
        raw.call("workspaces.icon", json!({})).await["err"]["code"],
        "bad_request"
    );
}

// ── 7. hooks ──────────────────────────────────────────────────────────────

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

// ── 8. the allow-list, live ───────────────────────────────────────────────

/// A node taken off the allow-list mid-connection loses its links and the
/// PTYs it opened within 2 s; another node keeps both.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_node_removed_from_the_allow_list_loses_its_links_and_ptys() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let host = Host::start(dir.path());
    let other = Identity::generate().unwrap();
    write_allow(&host.allow_list(), &[&host.node, &other]);
    // The watch polls once a second.
    let mut theirs = loop {
        let mut raw = Raw::over(host.tls_as(&other).await);
        raw.send_line(r#"{"id":1,"m":"hello","p":{"protocol":1,"client":"x","owner":"o"}}"#)
            .await;
        let mut line = String::new();
        let read = tokio::time::timeout(WAIT, raw.reader.read_line(&mut line))
            .await
            .unwrap();
        if matches!(read, Ok(n) if n > 0) {
            break raw;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let their_pty = theirs.ok("pty.open", open(&host, "sleep", &["30"])).await["id"].clone();
    let mut mine = host.greeted().await;
    let my_pty = mine.ok("pty.open", open(&host, "sleep", &["30"])).await["id"].clone();

    let removed = Instant::now();
    write_allow(&host.allow_list(), &[&host.node]);
    theirs.closed(Duration::from_secs(2)).await;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let ids: Vec<Value> = mine
            .ok("pty.sessions", json!({}))
            .await
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].clone())
            .collect();
        if ids == vec![my_pty.clone()] {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "their PTY {their_pty} still open after {:?}: {ids:?}",
            removed.elapsed()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Their key is now refused outright; mine still works.
    let mut again = Raw::over(host.tls_as(&other).await);
    again.send_line("{}").await;
    let mut line = String::new();
    let e = again.reader.read_line(&mut line).await.unwrap_err();
    assert_eq!(Refusal::of(&e), Some(Refusal::NotEnrolled));
    mine.ok("pty.close", json!({"id": my_pty})).await;

    // The file gone: fail closed, even for the node that was allowed.
    std::fs::remove_file(host.allow_list()).unwrap();
    mine.closed(Duration::from_secs(3)).await;
}

// ── 9. caps ───────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caps_on_ptys_requests_and_connections() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;

    // 64 PTYs on the host; the 65th is `busy`.
    for _ in 0..64 {
        raw.ok("pty.open", open(&host, "sleep", &["30"])).await;
    }
    let refused = raw.call("pty.open", open(&host, "sleep", &["30"])).await;
    assert_eq!(refused["err"]["code"], "busy", "{refused}");

    // 32 requests running on one connection; the 33rd is `busy`.
    let cwd = host.root_str();
    for _ in 0..32 {
        raw.send("exec.run", json!({"cwd": cwd, "argv": ["sleep", "2"]}))
            .await;
    }
    let over = raw.call("fs.stat", json!({"path": "/"})).await;
    assert_eq!(over["err"]["code"], "busy", "{over}");

    // Four connections per node; a fifth is closed at once.
    let mut held = vec![];
    for _ in 0..3 {
        held.push(host.greeted().await);
    }
    let mut fifth = host.raw().await;
    fifth.closed(WAIT).await;
    drop(held);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pre_auth_slots_on_loopback_and_the_handshake_deadline() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    // Review S8: loopback (every VPN peer, every container) is not one
    // address's three slots: a local client holding a few silent
    // connections leaves the others room to handshake.
    let few: Vec<TcpStream> = connect_many(host.addr, 8).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut raw = host.greeted().await;
    raw.ok("pty.sessions", json!({})).await;
    drop(raw);
    drop(few);
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Loopback's own pool is full at LOOPBACK_PREAUTH…
    let silent: Vec<TcpStream> =
        connect_many(host.addr, daedalus_session_host::serve::LOOPBACK_PREAUTH).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    // …so one more is closed without a handshake.
    let mut over = TcpStream::connect(host.addr).await.unwrap();
    let mut buf = [0u8; 1];
    let n = tokio::time::timeout(WAIT, over.read(&mut buf))
        .await
        .unwrap()
        .unwrap_or(0);
    assert_eq!(n, 0, "the connection past the pool was served");
    // The silent ones are cut at the handshake deadline (5 s).
    let started = Instant::now();
    for mut s in silent {
        let n = tokio::time::timeout(WAIT, s.read(&mut buf))
            .await
            .unwrap()
            .unwrap_or(0);
        assert_eq!(n, 0);
    }
    assert!(started.elapsed() < Duration::from_secs(6));
    // Then the slots are free again.
    let mut raw = host.greeted().await;
    raw.ok("pty.sessions", json!({})).await;
}

async fn connect_many(addr: SocketAddr, n: usize) -> Vec<TcpStream> {
    let mut out = Vec::new();
    for _ in 0..n {
        out.push(TcpStream::connect(addr).await.unwrap());
    }
    out
}

/// A client that stops reading fills its queue; the link is dropped and its
/// sessions parked, alive, for the next connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_stops_reading_is_dropped_and_its_session_parked() {
    let _serial = pty_guard().await;
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    let id = raw
        .ok(
            "pty.open",
            open(
                &host,
                "sh",
                &["-c", "while :; do echo spam spam spam spam spam; done"],
            ),
        )
        .await["id"]
        .clone();
    raw.send("pty.attach", json!({"id": id, "anchor": "fresh"}))
        .await;
    // Read nothing until the host gives up on this link.
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let conns = read_status(&host.status_file())["connections"]
            .as_array()
            .unwrap()
            .len();
        if conns == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "the link was never dropped");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    drop(raw);
    let mut next = host.greeted().await;
    let listed = next.ok("pty.sessions", json!({})).await;
    assert_eq!(listed[0]["id"], id);
    assert_eq!(listed[0]["alive"], true);
    assert_eq!(listed[0]["attached"], false, "parked");
    next.ok("pty.close", json!({"id": id})).await;
}

// ── 10. the status file ───────────────────────────────────────────────────

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
    // Review S3: the config it runs on, which the controller compares with
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

// ── 11. hook backlog, link close, hook socket hygiene ─────────────────────

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

/// The host ends a link with TLS `close_notify`, so the node reads a close
/// (here, a revocation) rather than a cut.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_link_the_host_closes_ends_with_close_notify() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    write_allow(&host.allow_list(), &[]);
    let mut rest = Vec::new();
    let read = tokio::time::timeout(WAIT, raw.reader.read_to_end(&mut rest))
        .await
        .expect("the host did not close the link");
    assert!(read.is_ok(), "the link was cut, not closed: {read:?}");
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
    tokio::time::sleep(Duration::from_millis(100)).await;
    // One more is closed unanswered.
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
