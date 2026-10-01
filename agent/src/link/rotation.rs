//! The controller's keys, and handing its trust to a new one: a signed
//! rotation statement (PLAN, feature 13).
//!
//! **Start** (`controller.rotate`, api/): the controller makes a new
//! identity (`identity.next.key` beside `identity.key`, 0600), signs with
//! the OLD key the statement that the new one succeeds it (identity.rs
//! `sign_rotation`), and records both with the end of a grace period in
//! `rotation.json` (written whole or not at all, util.rs `write_atomic`).
//!
//! **While both exist** the listener presents, per connection, the key the
//! machine pins: a machine names it in the TLS server name
//! (tls.rs `server_name_for`), so one that re-pinned gets the new key and
//! every other — a machine that was away — the old one. Which key a
//! connection got is decided ONCE, in its handshake, from a snapshot of
//! the keys taken as it was accepted (`Snapshot`, `ConnResolver`), so a
//! retirement mid-handshake can neither mislabel nor strand it. Every
//! connection under the key being retired is sent the statement once
//! (`rotate`, link/wire.rs), which the machine checks against the key its
//! handshake just proved, re-pins to the new key (config.toml's
//! `controller_pin`), acknowledges, and reconnects under the new key (link/node.rs).
//!
//! **Retire**: once the grace period is over (`tick`), the new key becomes
//! `identity.key` — the rename is the commit — `rotation.json` goes, and
//! the old key is gone for good: a machine that never connected during the
//! grace period is left with a key the controller no longer has, refused as
//! "controller key changed", and pinned again by hand. The period is
//! wall-clock time (`retires_at`): a clock that jumps ahead retires early,
//! one set back retires late; a controller down past it retires at its
//! next start.
//!
//! **What it does not do.** A rotation moves trust along, it does not
//! repair it: the old key's holder signs the statement, so whoever holds a
//! COMPROMISED old key can make a statement of their own for a key they
//! chose, and every machine that meets them first follows it. Recovering
//! from a leaked controller key is pinning a new one by hand (`install
//! --pin`), not this.
//!
//! **Half-done states heal, never stop the controller.** A next key whose
//! record is missing, torn or does not verify is signed again (ed25519
//! signatures are deterministic: the same statement comes back) under a
//! fresh grace period; a record whose key is already `identity.key` was a
//! retirement that stopped half-way, and goes; a next key that cannot be
//! read, or a record naming a key that is neither, is logged and the
//! current key served alone.
//!
//! `system.info` states the key going forward (the new one, from the start)
//! and, while a rotation runs, where it came from and how many machines
//! still connect under the old key (`info`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use rustls::sign::CertifiedKey;
use serde::{Deserialize, Serialize};

use super::wire::RotateParams;
use crate::identity::{self, Identity};
use crate::util::LockExt;

pub const NEXT_FILE: &str = "identity.next.key";
pub const ROTATION_FILE: &str = "rotation.json";
/// How long both keys are served when `controller.rotate` names no period.
pub const GRACE_DEFAULT: Duration = Duration::from_secs(7 * 86_400);
/// The shortest and the longest a caller may ask for.
pub const GRACE_MIN: Duration = Duration::from_secs(60);
pub const GRACE_MAX: Duration = Duration::from_secs(90 * 86_400);

/// `rotation.json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Record {
    new_public_key: String,
    signature: String,
    started_at: String,
    retires_at: String,
    retires_at_unix: u64,
}

/// A rotation under way, as `system.info` states it.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RotationInfo {
    /// The key being retired, hex, and its fingerprint.
    pub from_public_key: String,
    pub from_fingerprint: String,
    /// RFC 3339.
    pub started_at: String,
    /// When the old key is retired, RFC 3339 (wall-clock time).
    pub retires_at: String,
    /// Machines connected under the old key now: each has been sent the
    /// statement, and one that stays is an agent that does not know it.
    pub old_key_connections: u32,
}

struct Next {
    id: Identity,
    cert: Arc<CertifiedKey>,
    record: Record,
}

struct Inner {
    current: Identity,
    current_cert: Arc<CertifiedKey>,
    next: Option<Next>,
}

/// The controller's keys (module doc). `dir` None: one fixed key that never
/// rotates (tests, and a controller whose key is handed in).
pub struct Keys {
    dir: Option<PathBuf>,
    inner: Mutex<Inner>,
    /// Open connections by the fingerprint of the key they were served.
    connections: Mutex<HashMap<String, usize>>,
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keys")
            .field("fingerprint", &self.forward().fingerprint())
            .finish_non_exhaustive()
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether `r` is `current`'s statement for `next`.
fn record_holds(current: &Identity, next: &Identity, r: &Record) -> bool {
    r.new_public_key == next.public_key_hex()
        && hex::decode(&r.signature).is_ok_and(|sig| {
            identity::verify_rotation(
                current.public_key().as_bytes(),
                next.public_key().as_bytes(),
                &sig,
            )
        })
}

/// `current`'s statement for `next`, retiring `grace` from now.
fn record_for(current: &Identity, next: &Identity, grace: Duration) -> Record {
    let until = now_unix() + grace.as_secs().max(1);
    Record {
        new_public_key: next.public_key_hex(),
        signature: hex::encode(current.sign_rotation(next.public_key().as_bytes())),
        started_at: crate::state::now_rfc3339(),
        retires_at: crate::state::rfc3339_of(until),
        retires_at_unix: until,
    }
}

fn write_record(dir: &Path, r: &Record) -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(r).map_err(std::io::Error::other)?;
    crate::util::write_atomic(
        &dir.join(ROTATION_FILE),
        text.as_bytes(),
        crate::util::Access::Private,
    )
}

/// The keys as one connection is served them: taken when it is accepted,
/// so its handshake chooses among keys that cannot move under it.
#[derive(Clone)]
pub struct Snapshot {
    current: (Arc<CertifiedKey>, String),
    /// The key going forward, its node id, and the statement for it.
    next: Option<(Arc<CertifiedKey>, String, String, RotateParams)>,
}

/// Which key one connection was served, decided in its handshake.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Served {
    pub fingerprint: String,
    /// The statement for the key going forward, when this connection is
    /// under the key being retired: what it is sent (once).
    pub statement: Option<RotateParams>,
}

impl Snapshot {
    /// The key for a machine that asked for `sni`.
    pub fn choose(&self, sni: Option<&str>) -> (Arc<CertifiedKey>, Served) {
        match &self.next {
            Some((cert, fp, id, _)) if super::tls::pinned_id_of(sni) == Some(id.as_str()) => (
                Arc::clone(cert),
                Served {
                    fingerprint: fp.clone(),
                    statement: None,
                },
            ),
            _ => (
                Arc::clone(&self.current.0),
                Served {
                    fingerprint: self.current.1.clone(),
                    statement: self.next.as_ref().map(|n| n.3.clone()),
                },
            ),
        }
    }
}

impl Keys {
    /// One key, fixed: no rotation.
    pub fn fixed(id: &Identity) -> Result<Self> {
        Ok(Self {
            dir: None,
            inner: Mutex::new(Inner {
                current: id.clone(),
                current_cert: super::tls::certified(id)?,
                next: None,
            }),
            connections: Mutex::new(HashMap::new()),
        })
    }

    /// The keys in `dir`: `identity.key`, made on the first start — the
    /// one thing that can refuse the start — and a rotation under way when
    /// `identity.next.key` is there, healed where it stopped half-way
    /// (module doc). A rotation whose grace period ended while the
    /// controller was down is retired at once.
    pub fn load(dir: &Path) -> Result<Self> {
        let current = Identity::load_or_create_at(&dir.join(identity::FILE))?;
        let next_path = dir.join(NEXT_FILE);
        let rot_path = dir.join(ROTATION_FILE);
        let record: Option<Record> = match std::fs::read_to_string(&rot_path) {
            Ok(t) => match serde_json::from_str(&t) {
                Ok(r) => Some(r),
                Err(e) => {
                    tracing::warn!(error = %e, "{ROTATION_FILE} is torn; it is written again if a rotation runs");
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                tracing::warn!(error = %e, "{ROTATION_FILE} could not be read");
                None
            }
        };
        let next_id = if next_path.exists() {
            match Identity::load_at(&next_path) {
                Ok(id) => Some(id),
                Err(e) => {
                    tracing::error!(
                        error = format!("{e:#}"),
                        "{NEXT_FILE} cannot be read; serving the current controller key alone"
                    );
                    None
                }
            }
        } else {
            None
        };
        let next = match (next_id, record) {
            (Some(id), Some(r)) if record_holds(&current, &id, &r) => Some((id, r)),
            (Some(id), r) => {
                // Missing, torn or not the current key's statement: sign it
                // again, keeping the period a record for this key named.
                let kept = r.filter(|r| r.new_public_key == id.public_key_hex());
                let mut fresh = record_for(&current, &id, GRACE_DEFAULT);
                if let Some(k) = kept {
                    fresh.started_at = k.started_at;
                    fresh.retires_at = k.retires_at;
                    fresh.retires_at_unix = k.retires_at_unix;
                }
                tracing::warn!(retires_at = %fresh.retires_at, "the rotation's statement was missing or did not verify; signed again");
                if let Err(e) = write_record(dir, &fresh) {
                    tracing::warn!(error = %e, "{ROTATION_FILE} not written; the rotation runs from memory");
                }
                Some((id, fresh))
            }
            // Retired, and stopped before the record went.
            (None, Some(r)) if r.new_public_key == current.public_key_hex() => {
                let _ = std::fs::remove_file(&rot_path);
                None
            }
            (None, Some(_)) => {
                tracing::warn!(
                    "{ROTATION_FILE} names a key that is neither {} nor a readable {NEXT_FILE}; serving the current key alone",
                    identity::FILE
                );
                None
            }
            (None, None) => None,
        };
        let next = match next {
            Some((id, record)) => {
                match super::tls::certified(&id) {
                    Ok(cert) => Some(Next { id, cert, record }),
                    Err(e) => {
                        tracing::error!(error = format!("{e:#}"), "the next controller key cannot be served; serving the current key alone");
                        None
                    }
                }
            }
            None => None,
        };
        let keys = Self {
            dir: Some(dir.to_path_buf()),
            inner: Mutex::new(Inner {
                current_cert: super::tls::certified(&current)?,
                current,
                next,
            }),
            connections: Mutex::new(HashMap::new()),
        };
        keys.tick();
        Ok(keys)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock_ok()
    }

    /// The key going forward: the new one while a rotation runs.
    pub fn forward(&self) -> Identity {
        let l = self.lock();
        l.next
            .as_ref()
            .map_or_else(|| l.current.clone(), |n| n.id.clone())
    }

    /// Start a rotation with `grace` before the old key retires (module
    /// doc). Refused while one runs, and for a fixed key.
    pub fn start(&self, grace: Duration) -> Result<RotationInfo, String> {
        let Some(dir) = &self.dir else {
            return Err(
                "this controller's key is fixed; it has no data directory to rotate in".into(),
            );
        };
        let mut l = self.lock();
        if let Some(n) = &l.next {
            return Err(format!(
                "a rotation already runs; the old key retires at {}",
                n.record.retires_at
            ));
        }
        let next_path = dir.join(NEXT_FILE);
        let _ = std::fs::remove_file(&next_path);
        let id = Identity::load_or_create_at(&next_path).map_err(|e| format!("{e:#}"))?;
        let record = record_for(&l.current, &id, grace);
        let cert = super::tls::certified(&id).map_err(|e| format!("{e:#}"))?;
        write_record(dir, &record).map_err(|e| format!("writing {ROTATION_FILE}: {e}"))?;
        tracing::warn!(
            from = %l.current.fingerprint(),
            to = %id.fingerprint(),
            retires_at = %record.retires_at,
            "controller key rotation started"
        );
        l.next = Some(Next { cert, id, record });
        drop(l);
        Ok(self.info().expect("a rotation runs"))
    }

    /// The rotation under way, if one is.
    pub fn info(&self) -> Option<RotationInfo> {
        let l = self.lock();
        let n = l.next.as_ref()?;
        let old = l.current.fingerprint();
        Some(RotationInfo {
            from_public_key: l.current.public_key_hex(),
            from_fingerprint: old.clone(),
            started_at: n.record.started_at.clone(),
            retires_at: n.record.retires_at.clone(),
            old_key_connections: self.conns().get(&old).copied().unwrap_or(0) as u32,
        })
    }

    /// The keys as a connection accepted now is served them.
    pub fn snapshot(&self) -> Snapshot {
        let l = self.lock();
        Snapshot {
            current: (Arc::clone(&l.current_cert), l.current.fingerprint()),
            next: l.next.as_ref().map(|n| {
                (
                    Arc::clone(&n.cert),
                    n.id.fingerprint(),
                    n.id.node_id(),
                    RotateParams {
                        new_public_key: n.record.new_public_key.clone(),
                        signature: n.record.signature.clone(),
                    },
                )
            }),
        }
    }

    /// The statement for a connection under the key `fingerprint`, when a
    /// rotation now runs that retires that key: also for a connection that
    /// opened before the rotation started.
    pub fn statement_for(&self, fingerprint: &str) -> Option<RotateParams> {
        let l = self.lock();
        l.next
            .as_ref()
            .filter(|_| l.current.fingerprint() == fingerprint)
            .map(|n| RotateParams {
                new_public_key: n.record.new_public_key.clone(),
                signature: n.record.signature.clone(),
            })
    }

    /// Retire the old key once the grace period is over; whether it did.
    /// Cheap when there is nothing to do: the service's loop calls it.
    pub fn tick(&self) -> bool {
        self.retire_if(|r| now_unix() >= r.retires_at_unix)
    }

    fn retire_if(&self, due: impl FnOnce(&Record) -> bool) -> bool {
        let Some(dir) = &self.dir else {
            return false;
        };
        let mut l = self.lock();
        if !l.next.as_ref().is_some_and(|n| due(&n.record)) {
            return false;
        }
        let key = dir.join(identity::FILE);
        if let Err(e) = std::fs::rename(dir.join(NEXT_FILE), &key) {
            tracing::error!(error = %e, "the old controller key could not be retired; trying again");
            return false;
        }
        let _ = std::fs::remove_file(dir.join(ROTATION_FILE));
        let n = l.next.take().expect("checked above");
        tracing::warn!(
            retired = %l.current.fingerprint(),
            key = %n.id.fingerprint(),
            "controller key rotation done: the old key is retired"
        );
        l.current = n.id;
        l.current_cert = n.cert;
        true
    }

    /// Retire now, whatever the grace period says (the tests).
    #[cfg(test)]
    pub fn retire_now(&self) -> bool {
        self.retire_if(|_| true)
    }

    /// Count a connection by the key it was served while it lives: `info`
    /// tells how many are still on the key being retired.
    pub fn connection(self: &Arc<Self>, served: &Served) -> Connection {
        *self.conns().entry(served.fingerprint.clone()).or_default() += 1;
        Connection {
            keys: Arc::clone(self),
            fingerprint: served.fingerprint.clone(),
        }
    }

    fn conns(&self) -> std::sync::MutexGuard<'_, HashMap<String, usize>> {
        self.connections.lock_ok()
    }
}

/// One connection, counted (`Keys::connection`).
pub struct Connection {
    keys: Arc<Keys>,
    fingerprint: String,
}

impl Drop for Connection {
    fn drop(&mut self) {
        let mut c = self.keys.conns();
        if let Some(n) = c.get_mut(&self.fingerprint) {
            *n -= 1;
            if *n == 0 {
                c.remove(&self.fingerprint);
            }
        }
    }
}

/// The TLS side for one connection: chooses from its `Snapshot` and keeps
/// what it chose (`served`).
pub struct ConnResolver {
    snapshot: Snapshot,
    chosen: Mutex<Option<Served>>,
}

impl std::fmt::Debug for ConnResolver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnResolver").finish_non_exhaustive()
    }
}

impl ConnResolver {
    pub fn new(snapshot: Snapshot) -> Self {
        Self {
            snapshot,
            chosen: Mutex::new(None),
        }
    }

    /// What the handshake chose; None before it chose.
    pub fn served(&self) -> Option<Served> {
        self.chosen.lock_ok().clone()
    }
}

impl rustls::server::ResolvesServerCert for ConnResolver {
    fn resolve(&self, hello: rustls::server::ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        let (cert, served) = self.snapshot.choose(hello.server_name());
        *self.chosen.lock_ok() = Some(served);
        Some(cert)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("daedalus-rot-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn sni_of(i: &Identity) -> String {
        super::super::tls::server_name_for(identity::digest(i.public_key().as_bytes()))
    }

    #[test]
    fn a_rotation_starts_survives_a_restart_and_retires() {
        let dir = scratch("life");
        let keys = Keys::load(&dir).unwrap();
        let old = keys.forward();
        assert!(keys.info().is_none());
        assert!(keys.statement_for(&old.fingerprint()).is_none());
        let info = keys.start(Duration::from_secs(3600)).unwrap();
        assert_eq!(info.from_fingerprint, old.fingerprint());
        let new = keys.forward();
        assert_ne!(new.public_key_hex(), old.public_key_hex());
        // One at a time.
        assert!(keys.start(GRACE_MIN).unwrap_err().contains("already runs"));
        // The statement is the old key's, for the new one.
        let st = keys.statement_for(&old.fingerprint()).unwrap();
        assert_eq!(st.new_public_key, new.public_key_hex());
        assert!(identity::verify_rotation(
            old.public_key().as_bytes(),
            new.public_key().as_bytes(),
            &hex::decode(&st.signature).unwrap()
        ));
        assert!(keys.statement_for(&new.fingerprint()).is_none());
        // Who gets which key: the one they pin; the old key's connections
        // carry the statement.
        let snap = keys.snapshot();
        let served = |sni: Option<&str>| snap.choose(sni).1;
        assert_eq!(served(Some(&sni_of(&new))).fingerprint, new.fingerprint());
        assert_eq!(served(Some(&sni_of(&new))).statement, None);
        for s in [Some(sni_of(&old)), None] {
            let got = served(s.as_deref());
            assert_eq!(got.fingerprint, old.fingerprint());
            assert_eq!(got.statement.as_ref(), Some(&st));
        }
        // Counted by the key served.
        let keys = Arc::new(keys);
        let c = keys.connection(&served(None));
        assert_eq!(keys.info().unwrap().old_key_connections, 1);
        drop(c);
        assert_eq!(keys.info().unwrap().old_key_connections, 0);

        // A restart finds it as it was.
        drop(keys);
        let keys = Keys::load(&dir).unwrap();
        assert_eq!(keys.forward().public_key_hex(), new.public_key_hex());
        assert_eq!(keys.info().unwrap().from_fingerprint, old.fingerprint());
        assert!(!keys.tick(), "not due");

        // A snapshot taken before the retirement keeps serving what it
        // chose; the keys after it serve the new key alone.
        let before = keys.snapshot();
        assert!(keys.retire_now());
        assert_eq!(before.choose(None).1.fingerprint, old.fingerprint());
        assert!(keys.info().is_none());
        assert!(keys.statement_for(&old.fingerprint()).is_none());
        assert_eq!(
            keys.snapshot().choose(Some(&sni_of(&old))).1,
            Served {
                fingerprint: new.fingerprint(),
                statement: None
            }
        );
        assert!(!dir.join(NEXT_FILE).exists() && !dir.join(ROTATION_FILE).exists());
        drop(keys);
        let keys = Keys::load(&dir).unwrap();
        assert_eq!(keys.forward().public_key_hex(), new.public_key_hex());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_half_done_start_or_retire_heals_and_never_stops_the_controller() {
        let dir = scratch("heal");
        let keys = Keys::load(&dir).unwrap();
        let old = keys.forward();
        // A next key without its record: signed again, the rotation runs.
        let next = Identity::load_or_create_at(&dir.join(NEXT_FILE)).unwrap();
        drop(keys);
        let keys = Keys::load(&dir).unwrap();
        assert_eq!(keys.forward().public_key_hex(), next.public_key_hex());
        let st = keys.statement_for(&old.fingerprint()).unwrap();
        let written: Record =
            serde_json::from_str(&std::fs::read_to_string(dir.join(ROTATION_FILE)).unwrap())
                .unwrap();
        assert_eq!(written.signature, st.signature);
        // Deterministic: signed again, the same statement.
        assert_eq!(
            hex::encode(old.sign_rotation(next.public_key().as_bytes())),
            st.signature
        );
        drop(keys);
        // A torn record, and one signed by another key: signed again, the
        // period a readable record named kept.
        let retires = written.retires_at_unix;
        let mut forged = written.clone();
        forged.signature = hex::encode(next.sign_rotation(next.public_key().as_bytes()));
        std::fs::write(
            dir.join(ROTATION_FILE),
            serde_json::to_string(&forged).unwrap(),
        )
        .unwrap();
        let keys = Keys::load(&dir).unwrap();
        assert_eq!(keys.statement_for(&old.fingerprint()).unwrap(), st);
        drop(keys);
        let r: Record =
            serde_json::from_str(&std::fs::read_to_string(dir.join(ROTATION_FILE)).unwrap())
                .unwrap();
        assert_eq!(
            (r.signature.as_str(), r.retires_at_unix),
            (st.signature.as_str(), retires)
        );
        std::fs::write(dir.join(ROTATION_FILE), "{\"new_pub").unwrap();
        let keys = Keys::load(&dir).unwrap();
        assert_eq!(keys.statement_for(&old.fingerprint()).unwrap(), st);
        drop(keys);
        // Retired but stopped before the record went: done.
        std::fs::rename(dir.join(NEXT_FILE), dir.join(identity::FILE)).unwrap();
        let keys = Keys::load(&dir).unwrap();
        assert_eq!(keys.forward().public_key_hex(), next.public_key_hex());
        assert!(keys.info().is_none() && !dir.join(ROTATION_FILE).exists());
        drop(keys);
        // A next key that cannot be read (not a key): the current key alone.
        std::fs::write(dir.join(NEXT_FILE), b"short").unwrap();
        let keys = Keys::load(&dir).unwrap();
        assert_eq!(keys.forward().public_key_hex(), next.public_key_hex());
        assert!(keys.info().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fixed_key_never_rotates() {
        let keys = Keys::fixed(&Identity::from_seed([9; 32])).unwrap();
        assert!(keys.start(GRACE_DEFAULT).unwrap_err().contains("fixed"));
        assert!(!keys.tick());
    }
}
