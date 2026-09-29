//! TLS 1.3 for the link, with keys pinned instead of a CA: the two configs,
//! the verifiers that do the pinning, and `Tls`, one connection carrying
//! newline-delimited JSON.
//!
//! **Both ends present a certificate** made from their identity key
//! (cert.rs) and prove they hold it by signing the handshake (ed25519, the
//! only scheme offered). What each accepts:
//!
//! - the machine (`PinnedController`) accepts the controller only if the
//!   SHA-256 of the key it presents equals the pin, config.toml's and
//!   nothing else (link/node.rs): there is no first use.
//!   The key a refused controller presented is kept for the message, and
//!   labelled UNPROVEN: the pin check runs before the handshake signature,
//!   so nothing proves the peer holds it. A key is taken as the
//!   controller's only once the handshake has completed (`Tls::peer_key`).
//!   The machine's side is built ONCE per identity (`Client`) and re-armed
//!   with each attempt's pin, so the key's DER is not copied per attempt;
//!   the copy rustls loads is wiped as it is (crypto.rs);
//! - the controller (`AnyEd25519Machine`) accepts any ed25519 key at the
//!   TLS layer: whether that key is approved, pending or revoked is decided
//!   right after, from the key the handshake proved (link/controller.rs),
//!   so an unknown machine can still reach the pending list.
//!
//! No hostname is checked (there is no name to check against: the key is
//! the identity), no session is resumed (every connection proves its key
//! afresh), and TLS 1.2 is never offered.
//!
//! **`Tls`** is one blocking connection driven from one thread: `recv`
//! waits at most the socket's read timeout (`TICK` once the handshake is
//! done) and returns a whole line, `Idle` or `Closed`; `send` writes one
//! line and flushes it, within the socket's write timeout. The loop that
//! owns it (node.rs, controller.rs) interleaves the two, so nothing else
//! ever touches the connection.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, DistinguishedName, Error, ServerConfig,
    SignatureScheme,
};

use super::{cert, crypto, MAX_LINE, TICK};
use crate::deadline::Deadline;
use crate::identity::{digest, Identity};
use crate::jsonl::LineBuf;
use crate::util::LockExt;

/// The name the machine's client asks for, under which it names the key it
/// pins (`server_name_for`); nothing checks it as a name.
const SERVER_NAME: &str = "daedalus-controller";

fn signature_holds(
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, Error> {
    if dss.scheme != SignatureScheme::ED25519 {
        return Err(Error::InvalidCertificate(CertificateError::BadSignature));
    }
    let key = cert::public_key_of(cert)
        .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))?;
    if crypto::verify_ed25519(&key, message, dss.signature()) {
        Ok(HandshakeSignatureValid::assertion())
    } else {
        Err(Error::InvalidCertificate(CertificateError::BadSignature))
    }
}

fn no_tls12() -> Error {
    Error::General("TLS 1.2 is not offered on the link".into())
}

/// The machine's check on the controller (module doc), re-armed with the
/// pin of each attempt.
#[derive(Debug, Default)]
struct PinnedController {
    /// The SHA-256 of the key to accept; None trusts the first key seen.
    pin: Mutex<Option<[u8; 32]>>,
    /// The key the controller's certificate carried on the last attempt,
    /// recorded before the handshake signature is checked: unproven.
    presented: Mutex<Option<[u8; 32]>>,
}

impl PinnedController {
    fn arm(&self, pin: Option<[u8; 32]>) {
        *self.pin.lock_ok() = pin;
        *self.presented.lock_ok() = None;
    }

    fn presented(&self) -> Option<[u8; 32]> {
        *self.presented.lock_ok()
    }
}

/// Why `Client::connect` did not give a connection.
#[derive(Debug)]
pub enum ConnectError {
    /// The controller's certificate carries another key than the pin.
    /// `presented_unproven` is that key, before any signature proved it.
    KeyMismatch {
        presented_unproven: [u8; 32],
        pinned: [u8; 32],
    },
    Io(io::Error),
}

/// The machine's side of the link, built once per identity.
pub struct Client {
    fingerprint: String,
    config: Arc<ClientConfig>,
    verifier: Arc<PinnedController>,
    /// One attempt at a time: the verifier is armed per attempt.
    attempt: Mutex<()>,
}

impl Client {
    pub fn new(id: &Identity) -> anyhow::Result<Self> {
        let verifier = Arc::new(PinnedController::default());
        let config = client_config(id, Arc::clone(&verifier) as Arc<dyn ServerCertVerifier>)?;
        Ok(Self {
            fingerprint: id.fingerprint(),
            config,
            verifier,
            attempt: Mutex::new(()),
        })
    }

    /// This machine's fingerprint.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// Connect over `sock`, accepting the controller only by `pin` (None:
    /// the first key, which the caller then records), the handshake done
    /// within `timeout`.
    pub fn connect(
        &self,
        sock: TcpStream,
        pinned: [u8; 32],
        timeout: Duration,
    ) -> Result<Tls, ConnectError> {
        let pin = Some(pinned);
        let _one = self.attempt.lock_ok();
        self.verifier.arm(pin);
        match Tls::client(
            sock,
            Arc::clone(&self.config),
            &server_name_for(pin),
            timeout,
        ) {
            Ok(t) => Ok(t),
            Err(e) => match (self.verifier.presented(), pin) {
                (Some(key), Some(pinned)) if digest(&key) != pinned => {
                    Err(ConnectError::KeyMismatch {
                        presented_unproven: key,
                        pinned,
                    })
                }
                _ => Err(ConnectError::Io(e)),
            },
        }
    }
}

impl ServerCertVerifier for PinnedController {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let key = cert::public_key_of(end_entity)
            .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))?;
        *self.presented.lock_ok() = Some(key);
        let pin = *self.pin.lock_ok();
        // A machine trusts its pin alone (trust T1): no pin, no controller.
        match pin {
            Some(pin) if pin == digest(&key) => Ok(ServerCertVerified::assertion()),
            _ => Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            )),
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(no_tls12())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        signature_holds(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}

/// The controller's check on a machine: any ed25519 key that signs the
/// handshake; the key's standing is decided after (module doc).
#[derive(Debug)]
struct AnyEd25519Machine;

impl ClientCertVerifier for AnyEd25519Machine {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        cert::public_key_of(end_entity)
            .map(|_| ClientCertVerified::assertion())
            .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(no_tls12())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        signature_holds(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}

fn certificate_and_key(id: &Identity) -> (Vec<CertificateDer<'static>>, PrivateKeyDer<'static>) {
    let key = id.signing_key();
    (
        vec![cert::self_signed(key)],
        PrivateKeyDer::Pkcs8(crypto::pkcs8(key.as_bytes()).into()),
    )
}

/// The machine's config: its own certificate, the controller checked by
/// `verifier`.
fn client_config(
    id: &Identity,
    verifier: Arc<dyn ServerCertVerifier>,
) -> anyhow::Result<Arc<ClientConfig>> {
    let (certs, key) = certificate_and_key(id);
    let mut config = ClientConfig::builder_with_provider(crypto::provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_auth_cert(certs, key)?;
    config.resumption = rustls::client::Resumption::disabled();
    Ok(Arc::new(config))
}

/// The controller's side: its own certificate, every machine asked for one.
pub fn server_config(id: &Identity) -> anyhow::Result<Arc<ServerConfig>> {
    let (certs, key) = certificate_and_key(id);
    let mut config = ServerConfig::builder_with_provider(crypto::provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_client_cert_verifier(Arc::new(AnyEd25519Machine))
        .with_single_cert(certs, key)?;
    config.send_tls13_tickets = 0;
    config.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    Ok(Arc::new(config))
}

/// The name a machine asks for (SNI): the node id of the key it pins, under
/// `SERVER_NAME`, so a controller holding two keys during a rotation
/// presents the one this machine trusts (rotation.rs); the bare name
/// without one (the tests' raw clients).
pub fn server_name_for(pin: Option<[u8; 32]>) -> String {
    match pin {
        Some(d) => format!("k{}.{SERVER_NAME}", &hex::encode(d)[..16]),
        None => SERVER_NAME.to_string(),
    }
}

/// The node id of the key a machine pins, from the name it asked for; None
/// for the bare name or anything else.
pub fn pinned_id_of(sni: Option<&str>) -> Option<&str> {
    let id = sni?
        .strip_prefix('k')?
        .strip_suffix(SERVER_NAME)?
        .strip_suffix('.')?;
    (id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then_some(id)
}

/// An identity as rustls presents it: its certificate and signing key.
pub(crate) fn certified(id: &Identity) -> anyhow::Result<Arc<rustls::sign::CertifiedKey>> {
    let (certs, key) = certificate_and_key(id);
    let signing = crypto::provider().key_provider.load_private_key(key)?;
    Ok(Arc::new(rustls::sign::CertifiedKey::new(certs, signing)))
}

/// The controller's side with its keys chosen per connection by `resolver`
/// (rotation.rs), every machine asked for a certificate.
pub fn server_config_resolving(
    resolver: Arc<dyn rustls::server::ResolvesServerCert>,
) -> anyhow::Result<Arc<ServerConfig>> {
    let mut config = ServerConfig::builder_with_provider(crypto::provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_client_cert_verifier(Arc::new(AnyEd25519Machine))
        .with_cert_resolver(resolver);
    config.send_tls13_tickets = 0;
    config.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    Ok(Arc::new(config))
}

/// What one `recv` gave.
#[derive(Debug, PartialEq, Eq)]
pub enum Recv {
    Line(Vec<u8>),
    /// Nothing arrived within the read timeout.
    Idle,
    /// The peer closed the connection.
    Closed,
}

/// One connection (module doc).
pub struct Tls {
    conn: rustls::Connection,
    sock: TcpStream,
    lines: LineBuf,
}

fn is_timeout(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    )
}

fn invalid(e: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

impl Tls {
    /// Connect as the machine and finish the handshake within `timeout`.
    pub fn client(
        sock: TcpStream,
        config: Arc<ClientConfig>,
        name: &str,
        timeout: Duration,
    ) -> io::Result<Self> {
        let name = ServerName::try_from(name.to_string()).map_err(invalid)?;
        let conn = rustls::ClientConnection::new(config, name).map_err(invalid)?;
        Self::handshake(conn.into(), sock, timeout)
    }

    /// Accept as the controller and finish the handshake within `timeout`.
    pub fn server(
        sock: TcpStream,
        config: Arc<ServerConfig>,
        timeout: Duration,
    ) -> io::Result<Self> {
        let conn = rustls::ServerConnection::new(config).map_err(invalid)?;
        Self::handshake(conn.into(), sock, timeout)
    }

    /// The handshake, all of it within `timeout` from now: every read and
    /// write waits at most what is left, and the deadline is checked after
    /// each, so a peer trickling a byte at a time is cut off on time
    /// (rustls' `complete_io` would loop for as long as bytes arrive).
    fn handshake(
        mut conn: rustls::Connection,
        mut sock: TcpStream,
        timeout: Duration,
    ) -> io::Result<Self> {
        sock.set_nodelay(true)?;
        let deadline = Deadline::after(timeout);
        while conn.is_handshaking() {
            if deadline.passed() {
                return Err(io::ErrorKind::TimedOut.into());
            }
            let wait = deadline.timeout(timeout);
            sock.set_write_timeout(Some(wait))?;
            while conn.wants_write() {
                conn.write_tls(&mut sock)?;
            }
            if !conn.is_handshaking() {
                break;
            }
            sock.set_read_timeout(Some(wait))?;
            match conn.read_tls(&mut sock) {
                Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
                Ok(_) => {}
                Err(e) if is_timeout(&e) => continue,
                Err(e) => return Err(e),
            }
            if let Err(e) = conn.process_new_packets() {
                // The alert that says why, then the error.
                let _ = conn.write_tls(&mut sock);
                return Err(invalid(e));
            }
        }
        while conn.wants_write() {
            conn.write_tls(&mut sock)?;
        }
        // Lines up to MAX_LINE go out whole; the peer's pace is the
        // write timeout's to judge.
        conn.set_buffer_limit(None);
        sock.set_read_timeout(Some(TICK))?;
        sock.set_write_timeout(Some(timeout))?;
        Ok(Self {
            conn,
            sock,
            lines: LineBuf::new(MAX_LINE),
        })
    }

    /// The name the machine asked for, on the controller's side (SNI;
    /// `pinned_id_of` reads the key it pins from it).
    pub fn sni(&self) -> Option<&str> {
        match &self.conn {
            rustls::Connection::Server(s) => s.server_name(),
            rustls::Connection::Client(_) => None,
        }
    }

    /// The key the peer's certificate carries — the one its handshake
    /// signature proved.
    pub fn peer_key(&self) -> Option<[u8; 32]> {
        let certs = self.conn.peer_certificates()?;
        cert::public_key_of(certs.first()?).ok()
    }

    /// Where the peer connects from.
    pub fn peer_addr(&self) -> Option<std::net::SocketAddr> {
        self.sock.peer_addr().ok()
    }

    /// Accept lines up to `n` bytes (a connection not yet admitted reads
    /// less than `MAX_LINE`, link/controller.rs).
    pub fn set_max_line(&mut self, n: usize) {
        self.lines.set_max(n.min(MAX_LINE));
    }

    /// The read timeout `recv` waits at most.
    pub fn set_read_timeout(&self, d: Duration) -> io::Result<()> {
        self.sock.set_read_timeout(Some(d))
    }

    fn flush(&mut self) -> io::Result<()> {
        while self.conn.wants_write() {
            self.conn.write_tls(&mut self.sock)?;
        }
        Ok(())
    }

    /// Bytes as they are, one record, flushed (the tests' tricklers).
    #[cfg(test)]
    pub fn send_bytes(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.conn.writer().write_all(bytes)?;
        self.flush()
    }

    /// One line, newline added, written and flushed.
    pub fn send(&mut self, line: &str) -> io::Result<()> {
        if line.len() > MAX_LINE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("a line is at most {MAX_LINE} bytes"),
            ));
        }
        self.conn.writer().write_all(line.as_bytes())?;
        self.conn.writer().write_all(b"\n")?;
        self.flush()
    }

    /// The next line, or `Idle` once one read of the network brought no
    /// whole line — nothing within the read timeout, or a part of one — so
    /// the caller's deadlines are checked at least that often however the
    /// peer paces its bytes. Each look scans only the bytes that are new
    /// (jsonl.rs).
    pub fn recv(&mut self) -> io::Result<Recv> {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            if let Some(line) = self.lines.take()? {
                return Ok(Recv::Line(line));
            }
            match self.conn.reader().read(&mut chunk) {
                Ok(0) => return Ok(Recv::Closed),
                Ok(n) => {
                    self.lines.push(&chunk[..n]);
                    continue;
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(Recv::Closed),
                Err(e) => return Err(e),
            }
            match self.conn.read_tls(&mut self.sock) {
                Ok(0) => return Ok(Recv::Closed),
                Ok(_) => {}
                Err(e) if is_timeout(&e) => return Ok(Recv::Idle),
                Err(e) => return Err(e),
            }
            self.conn.process_new_packets().map_err(invalid)?;
            // Alerts and key updates the packets asked for.
            self.flush()?;
            // What that record held, then back to the caller — a line it
            // completed before any close that came with it.
            let mut ended = false;
            loop {
                match self.conn.reader().read(&mut chunk) {
                    Ok(0) => {
                        ended = true;
                        break;
                    }
                    Ok(n) => self.lines.push(&chunk[..n]),
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
                        ended = true;
                        break;
                    }
                    Err(e) => return Err(e),
                }
            }
            return Ok(match self.lines.take()? {
                Some(line) => Recv::Line(line),
                None if ended => Recv::Closed,
                None => Recv::Idle,
            });
        }
    }

    /// Say goodbye and tear the connection down.
    pub fn close(&mut self) {
        self.conn.send_close_notify();
        let _ = self.flush();
        let _ = self.sock.shutdown(Shutdown::Both);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A connected client and server over loopback; `pin` is what the
    /// client expects of the server's key.
    fn pair(
        client: &Client,
        server_id: &Identity,
        pin: [u8; 32],
    ) -> (Result<Tls, ConnectError>, io::Result<Tls>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_cfg = server_config(server_id).unwrap();
        let server = std::thread::spawn(move || {
            let (sock, _) = listener.accept().unwrap();
            Tls::server(sock, server_cfg, Duration::from_secs(5))
        });
        let c = client.connect(
            TcpStream::connect(addr).unwrap(),
            pin,
            Duration::from_secs(5),
        );
        (c, server.join().unwrap())
    }

    fn id(n: u8) -> Identity {
        Identity::from_seed([n; 32])
    }

    fn recv_line(t: &mut Tls) -> Vec<u8> {
        for _ in 0..100 {
            match t.recv().unwrap() {
                Recv::Line(l) => return l,
                Recv::Idle => continue,
                Recv::Closed => panic!("closed"),
            }
        }
        panic!("no line")
    }

    #[test]
    fn a_machine_names_the_key_it_pins() {
        let d = [0xabu8; 32];
        let name = server_name_for(Some(d));
        assert_eq!(name, "kabababababababab.daedalus-controller");
        assert_eq!(pinned_id_of(Some(&name)), Some("abababababababab"));
        assert_eq!(server_name_for(None), SERVER_NAME);
        for other in [
            SERVER_NAME,
            "kABABABABABABABAB.daedalus-controller",
            "kabab.daedalus-controller",
            "kabababababababab.elsewhere",
        ] {
            assert_eq!(pinned_id_of(Some(other)), None, "{other}");
        }
        assert_eq!(pinned_id_of(None), None);
    }

    #[test]
    fn both_keys_are_proved_and_lines_flow_both_ways() {
        let (node, ctl) = (id(1), id(2));
        let client = Client::new(&node).unwrap();
        let pin = digest(ctl.public_key().as_bytes());
        let (c, s) = pair(&client, &ctl, pin);
        let (mut c, mut s) = (c.unwrap(), s.unwrap());
        assert_eq!(s.peer_key(), Some(*node.public_key().as_bytes()));
        assert_eq!(c.peer_key(), Some(*ctl.public_key().as_bytes()));
        c.send("hello").unwrap();
        assert_eq!(recv_line(&mut s), b"hello");
        // A line far past rustls' default buffer goes out whole.
        let big = "x".repeat(300_000);
        s.send(&big).unwrap();
        assert_eq!(recv_line(&mut c).len(), 300_000);
        assert!(s.send(&"y".repeat(MAX_LINE + 1)).is_err());
        // A line past the reader's own limit ends the read.
        s.send(&"z".repeat(2000)).unwrap();
        c.set_max_line(1000);
        assert!(c.recv().is_err() || c.recv().is_err());
        c.close();
        let mut end = None;
        for _ in 0..100 {
            match s.recv() {
                Ok(Recv::Idle) => continue,
                other => {
                    end = Some(other);
                    break;
                }
            }
        }
        assert!(matches!(end, Some(Ok(Recv::Closed))), "{end:?}");
    }

    #[test]
    fn a_controller_with_another_key_is_refused_and_named_unproven() {
        let (node, ctl, other) = (id(1), id(2), id(3));
        let client = Client::new(&node).unwrap();
        let pin = digest(other.public_key().as_bytes());
        match pair(&client, &ctl, pin).0 {
            Err(ConnectError::KeyMismatch {
                presented_unproven,
                pinned,
            }) => {
                assert_eq!(presented_unproven, *ctl.public_key().as_bytes());
                assert_eq!(pinned, pin);
            }
            other => panic!("{:?}", other.map(|_| ())),
        }
        // The same client, re-armed with the right pin, gets in.
        let right = digest(ctl.public_key().as_bytes());
        assert!(pair(&client, &ctl, right).0.is_ok());
    }

    /// The provider against ring's, on Linux where ring is built anyway:
    /// a handshake and a record each way between the two, so the record
    /// layer cannot be wrong the same way at both ends.
    #[cfg(target_os = "linux")]
    #[test]
    fn this_provider_interoperates_with_rings() {
        let (node, ctl) = (id(1), id(2));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        // The controller on ring's provider, restricted to the same suite.
        let (certs, key) = certificate_and_key(&ctl);
        let ring = rustls::crypto::ring::default_provider();
        let ring = rustls::crypto::CryptoProvider {
            cipher_suites: vec![rustls::crypto::ring::cipher_suite::TLS13_CHACHA20_POLY1305_SHA256],
            kx_groups: vec![rustls::crypto::ring::kx_group::X25519],
            ..ring
        };
        let server_cfg = Arc::new(
            ServerConfig::builder_with_provider(Arc::new(ring))
                .with_protocol_versions(&[&rustls::version::TLS13])
                .unwrap()
                .with_client_cert_verifier(Arc::new(AnyEd25519Machine))
                .with_single_cert(certs, key)
                .unwrap(),
        );
        let server = std::thread::spawn(move || {
            let (sock, _) = listener.accept().unwrap();
            let mut s = Tls::server(sock, server_cfg, Duration::from_secs(5)).unwrap();
            let got = recv_line(&mut s);
            s.send("from ring").unwrap();
            (got, s.peer_key())
        });
        let pin = digest(ctl.public_key().as_bytes());
        let client = Client::new(&node).unwrap();
        let mut c = client
            .connect(
                TcpStream::connect(addr).unwrap(),
                pin,
                Duration::from_secs(5),
            )
            .map_err(|e| format!("{e:?}"))
            .unwrap();
        c.send("from this provider").unwrap();
        assert_eq!(recv_line(&mut c), b"from ring");
        let (got, peer) = server.join().unwrap();
        assert_eq!(got, b"from this provider");
        assert_eq!(peer, Some(*node.public_key().as_bytes()));
    }
}
