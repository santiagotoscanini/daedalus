//! What every test file shares: the built binary run as `serve --config` on
//! 127.0.0.1:0 with a throwaway host key and allow-list ([`Host`]), driven
//! over the pinned TLS link by a raw JSON-lines client ([`Raw`], exact wire
//! order) or by santree's own `RemoteClient` (conformance with the app), each
//! presenting a throwaway node key.

// Each test file uses a part of this.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use santree_remote_client::RemoteClient;
use santree_remote_tls::Identity;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use tokio::net::{TcpStream, UnixStream};

pub const BIN: &str = env!("CARGO_BIN_EXE_daedalus-session-host");
pub const WAIT: Duration = Duration::from_secs(10);

pub type Tls = santree_remote_tls::ClientStream<TcpStream>;

/// Tests that fork real shells behind real PTYs run one at a time, as
/// santree-pty's own suite does: parallel PTY allocation contends for the
/// pty table.
pub async fn pty_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    SERIAL.lock().await
}

pub fn tempdir() -> tempfile::TempDir {
    // Under /tmp: a unix socket path must fit in 108 bytes.
    tempfile::Builder::new()
        .prefix("dsh")
        .tempdir_in("/tmp")
        .unwrap()
}

pub fn node_id(key: &[u8; 32]) -> String {
    daedalus_session_host::allow::node_id_of(key)
}

/// Write the allow-list as the controller does: a 0600 temp file renamed
/// over it.
pub fn write_allow(path: &Path, nodes: &[&Identity]) {
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

pub struct Host {
    pub child: Child,
    dir: PathBuf,
    pub addr: SocketAddr,
    pub key: [u8; 32],
    /// The node every test connects as, allowed at start.
    pub node: Identity,
}

impl Host {
    pub fn root(&self) -> PathBuf {
        self.dir.join("projects")
    }
    pub fn hook_socket(&self) -> PathBuf {
        self.dir.join("run/hook.sock")
    }
    pub fn allow_list(&self) -> PathBuf {
        self.dir.join("allow.json")
    }
    pub fn status_file(&self) -> PathBuf {
        self.dir.join("state/status.json")
    }

    /// `serve` with everything under `dir`, HOME = `dir`.
    pub fn start(dir: &Path) -> Host {
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

    pub fn signal(&self, sig: i32) {
        // SAFETY: plain kill(2) on our own child.
        assert_eq!(unsafe { libc::kill(self.child.id() as i32, sig) }, 0);
    }

    pub fn wait(&mut self) -> std::process::ExitStatus {
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
    pub async fn tls_as(&self, node: &Identity) -> Tls {
        let tcp = TcpStream::connect(self.addr).await.unwrap();
        santree_remote_tls::connect(santree_remote_tls::client_config(node, self.key), tcp)
            .await
            .unwrap()
    }

    pub async fn tls(&self) -> Tls {
        self.tls_as(&self.node).await
    }

    pub async fn raw(&self) -> Raw {
        Raw::over(self.tls().await)
    }

    pub async fn greeted(&self) -> Raw {
        let mut raw = self.raw().await;
        let hello = raw.hello(1).await;
        assert!(hello.get("ok").is_some(), "{hello}");
        raw
    }

    pub async fn client(&self) -> RemoteClient {
        let (r, w) = tokio::io::split(self.tls().await);
        let client = RemoteClient::new(r, w);
        client.hello("santree/test", "owner-a").await.unwrap();
        client
    }

    pub fn root_str(&self) -> String {
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

pub struct Raw {
    pub reader: BufReader<ReadHalf<Tls>>,
    pub writer: WriteHalf<Tls>,
    next: u64,
}

impl Raw {
    pub fn over(tls: Tls) -> Raw {
        let (r, w) = tokio::io::split(tls);
        Raw {
            reader: BufReader::new(r),
            writer: w,
            next: 1,
        }
    }

    pub async fn send_line(&mut self, line: &str) {
        self.writer.write_all(line.as_bytes()).await.unwrap();
        self.writer.write_all(b"\n").await.unwrap();
        self.writer.flush().await.unwrap();
    }

    pub async fn send(&mut self, m: &str, p: Value) -> u64 {
        let id = self.next;
        self.next += 1;
        self.send_line(&json!({"id": id, "m": m, "p": p}).to_string())
            .await;
        id
    }

    /// The next frame, pings included.
    pub async fn frame(&mut self) -> Value {
        let mut line = String::new();
        let n = tokio::time::timeout(WAIT, self.reader.read_line(&mut line))
            .await
            .expect("no frame in time")
            .unwrap();
        assert!(n > 0, "connection closed");
        serde_json::from_str(&line).unwrap()
    }

    /// The next frame that is not a ping.
    pub async fn next(&mut self) -> Value {
        loop {
            let frame = self.frame().await;
            if frame["e"] != "ping" {
                return frame;
            }
        }
    }

    /// Send and return the response, which must be the next non-ping frame.
    pub async fn call(&mut self, m: &str, p: Value) -> Value {
        let id = self.send(m, p).await;
        let frame = self.next().await;
        assert_eq!(frame["id"], id, "expected the response to {m}: {frame}");
        frame
    }

    pub async fn ok(&mut self, m: &str, p: Value) -> Value {
        let frame = self.call(m, p).await;
        frame
            .get("ok")
            .cloned()
            .unwrap_or_else(|| panic!("{m} failed: {frame}"))
    }

    /// Call `m` until its result satisfies `done`, polling within [`WAIT`].
    pub async fn ok_until(&mut self, m: &str, p: Value, done: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            let result = self.ok(m, p.clone()).await;
            if done(&result) {
                return result;
            }
            assert!(Instant::now() < deadline, "{m} never got there: {result}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub async fn hello(&mut self, protocol: u32) -> Value {
        self.call(
            "hello",
            json!({"protocol": protocol, "client": "test/1", "owner": "owner-a"}),
        )
        .await
    }

    /// Resolves once the host has closed the connection (reading and
    /// discarding whatever was still in flight).
    pub async fn closed(&mut self, within: Duration) {
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
pub async fn hook_call(socket: &Path, line: Value) -> Value {
    let (r, mut w) = UnixStream::connect(socket).await.unwrap().into_split();
    w.write_all(format!("{line}\n").as_bytes()).await.unwrap();
    let mut answer = String::new();
    tokio::time::timeout(WAIT, BufReader::new(r).read_line(&mut answer))
        .await
        .unwrap()
        .unwrap();
    serde_json::from_str(&answer).unwrap()
}

pub async fn push_hook(socket: &Path, event: &str, env: Value, stdin: &[u8]) -> u64 {
    let answer = hook_call(
        socket,
        json!({"id": 1, "m": "hooks.push", "p": {"event": event, "env": env, "stdin": b64(stdin)}}),
    )
    .await;
    answer["ok"]["seq"].as_u64().unwrap()
}

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn unb64(v: &Value) -> Vec<u8> {
    B64.decode(v.as_str().unwrap()).unwrap()
}

pub fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

pub fn open(host: &Host, command: &str, args: &[&str]) -> Value {
    json!({"cwd": host.root_str(), "command": command, "args": args, "cols": 80, "rows": 24,
           "env": [], "owner": "owner-a", "label": "test"})
}

pub fn read_status(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

pub async fn wait_until(what: &str, within: Duration, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !f() {
        assert!(Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
