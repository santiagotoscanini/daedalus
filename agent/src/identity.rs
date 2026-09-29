//! The machine's key: an ed25519 keypair made on first start, kept in the
//! data directory, and the only credential the agent ever presents.
//!
//! The box keys everything it knows about a machine on the public half, so
//! the private half IS the machine's identity: a copy of the file on another
//! computer would let it impersonate this one. On Windows the seed is
//! wrapped with DPAPI under the machine's scope before it touches disk, so a
//! copy is useless on any other computer — but any process on THIS machine
//! can unwrap it, so keeping local users out rests on the file's ACL (see
//! `os::create_private`, util.rs `write_atomic`). Elsewhere the seed is a plain file,
//! mode 0600, which is the ordinary SSH-key posture (os/unix.rs). How the
//! seed is sealed and written is `os::{seal, unseal}` and `util::write_atomic`.
//!
//! The controller has one too, made the same way in its own data directory:
//! it is what the machines pin (link/). Both ends show a key as its
//! FINGERPRINT — SHA-256 of the public key, lowercase hex in groups of four
//! (`fingerprint`) — and a machine's node id is the first sixteen hex
//! characters of the same digest. The key signs nothing but the link's
//! certificate and TLS handshake (link/cert.rs, link/crypto.rs) — and, for
//! the controller's, the one statement that hands its trust to a new key
//! (`sign_rotation`, under a context of its own; link/rotation.rs).

use std::path::Path;

use anyhow::{bail, Context, Result};
use ed25519_dalek::{SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::os::{seal, unseal};
use crate::paths::data_dir;

pub const FILE: &str = "identity.key";

#[derive(Clone)]
pub struct Identity {
    key: SigningKey,
}

impl Identity {
    /// Load the key from the data directory, or make one and keep it there.
    pub fn load_or_create() -> Result<Self> {
        Self::load_or_create_at(&data_dir().join(FILE))
    }

    /// The same, at `path`.
    pub fn load_or_create_at(path: &Path) -> Result<Self> {
        if path.exists() {
            // A key someone else could have planted is not this machine's.
            crate::private::check_owner(path)?;
            // And one others could read is not a secret (T4): refused on
            // unix; on Windows, where an older agent left it under the data
            // directory's inherited grants, made private first.
            crate::os::ensure_private(path)?;
            let sealed =
                std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
            let seed = unseal(&sealed).context("the identity file could not be opened")?;
            let arr: [u8; 32] = seed.as_slice().try_into().context("identity seed length")?;
            return Ok(Self::from_seed(arr));
        }
        let key = SigningKey::generate(&mut rand_core::OsRng);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).context("creating the data directory")?;
        }
        crate::util::write_atomic(path, &seal(key.as_bytes())?, crate::util::Access::Private)
            .with_context(|| format!("writing {}", path.display()))?;
        tracing::info!(path = %path.display(), "made this machine's identity key");
        Ok(Self { key })
    }

    /// A key from its 32-byte seed.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(&seed),
        }
    }

    pub fn public_key(&self) -> VerifyingKey {
        self.key.verifying_key()
    }

    pub fn public_key_hex(&self) -> String {
        hex::encode(self.public_key().as_bytes())
    }

    /// What the box calls this machine: sixteen hex characters of SHA-256(pubkey).
    pub fn node_id(&self) -> String {
        node_id_of(self.public_key().as_bytes())
    }

    /// The key as people compare it (module doc).
    pub fn fingerprint(&self) -> String {
        fingerprint(self.public_key().as_bytes())
    }

    /// The key itself, for the link's certificate and handshake (link/).
    pub(crate) fn signing_key(&self) -> &SigningKey {
        &self.key
    }

    /// Load the key at `path`, which must exist and be trusted.
    pub fn load_at(path: &Path) -> Result<Self> {
        if !path.exists() {
            bail!("{} does not exist", path.display());
        }
        Self::load_or_create_at(path)
    }

    /// The controller's rotation statement (link/rotation.rs): this key
    /// vouching for `new`, over `rotation_message`.
    pub fn sign_rotation(&self, new: &[u8; 32]) -> [u8; 64] {
        use ed25519_dalek::Signer;
        self.key
            .sign(&rotation_message(self.public_key().as_bytes(), new))
            .to_bytes()
    }
}

/// What a rotation statement signs: a context of its own, so no signature
/// the key makes for anything else can pass for one, then the old key and
/// the new.
pub fn rotation_message(old: &[u8; 32], new: &[u8; 32]) -> Vec<u8> {
    let mut m = b"daedalus-agent controller key rotation v1\0".to_vec();
    m.extend_from_slice(old);
    m.extend_from_slice(new);
    m
}

/// Whether `signature` is `old`'s statement that `new` succeeds it.
pub fn verify_rotation(old: &[u8; 32], new: &[u8; 32], signature: &[u8]) -> bool {
    let (Ok(key), Ok(sig)) = (
        VerifyingKey::from_bytes(old),
        ed25519_dalek::Signature::from_slice(signature),
    ) else {
        return false;
    };
    old != new && key.verify_strict(&rotation_message(old, new), &sig).is_ok()
}

/// SHA-256 of a public key.
pub fn digest(public_key: &[u8; 32]) -> [u8; 32] {
    Sha256::digest(public_key).into()
}

/// The node id of a public key: sixteen hex characters of its digest.
pub fn node_id_of(public_key: &[u8; 32]) -> String {
    hex::encode(digest(public_key))[..16].to_string()
}

/// A digest as people read it: lowercase hex, four characters to a group,
/// the groups joined by `:` — `3f2a:9c01:…`, sixteen groups.
pub fn format_fingerprint(digest: &[u8; 32]) -> String {
    let hex = hex::encode(digest);
    hex.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).expect("hex is ASCII"))
        .collect::<Vec<_>>()
        .join(":")
}

/// A public key's fingerprint (module doc).
pub fn fingerprint(public_key: &[u8; 32]) -> String {
    format_fingerprint(&digest(public_key))
}

/// A fingerprint as typed or pasted — groups joined by `:`, `-` or spaces,
/// or none; either case — back to the digest.
pub fn parse_fingerprint(text: &str) -> Result<[u8; 32]> {
    let hex: String = text
        .chars()
        .filter(|c| !matches!(c, ':' | '-' | ' '))
        .collect::<String>()
        .to_ascii_lowercase();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("a fingerprint is 64 hex characters (SHA-256 of the key), not {text:?}");
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(&hex, &mut out).context("fingerprint")?;
    Ok(out)
}

/// A public key given as 64 hex characters.
pub fn parse_public_key(text: &str) -> Result<[u8; 32]> {
    let text = text.trim().to_ascii_lowercase();
    let mut out = [0u8; 32];
    if text.len() != 64 || hex::decode_to_slice(&text, &mut out).is_err() {
        bail!("a public key is 64 hex characters, not {text:?}");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_key_has_an_id_and_a_hex_form() {
        let id = Identity {
            key: SigningKey::generate(&mut rand_core::OsRng),
        };
        assert_eq!(id.node_id().len(), 16);
        assert_eq!(id.public_key_hex().len(), 64);
    }

    #[test]
    fn a_fingerprint_reads_back_and_starts_with_the_node_id() {
        let id = Identity::from_seed([7; 32]);
        let fp = id.fingerprint();
        assert_eq!(fp.len(), 64 + 15);
        assert_eq!(fp.split(':').count(), 16);
        assert_eq!(fp.replace(':', "")[..16], id.node_id());
        let d = digest(id.public_key().as_bytes());
        assert_eq!(parse_fingerprint(&fp).unwrap(), d);
        assert_eq!(
            parse_fingerprint(&fp.to_uppercase().replace(':', " ")).unwrap(),
            d
        );
        assert_eq!(parse_fingerprint(&fp.replace(':', "")).unwrap(), d);
        assert!(parse_fingerprint("abc").is_err());
        assert!(parse_fingerprint(&"g".repeat(64)).is_err());
        assert_eq!(
            parse_public_key(&id.public_key_hex()).unwrap(),
            *id.public_key().as_bytes()
        );
        assert!(parse_public_key("00").is_err());
    }

    #[test]
    fn only_the_old_key_can_vouch_for_the_new_one() {
        let old = Identity::from_seed([1; 32]);
        let new = Identity::from_seed([2; 32]);
        let other = Identity::from_seed([3; 32]);
        let (o, n) = (*old.public_key().as_bytes(), *new.public_key().as_bytes());
        let sig = old.sign_rotation(&n);
        assert!(verify_rotation(&o, &n, &sig));
        // Another key's statement, the new key's own, a statement for
        // another key, a key rotated to itself, a torn signature: no.
        assert!(!verify_rotation(&o, &n, &other.sign_rotation(&n)));
        assert!(!verify_rotation(&o, &n, &new.sign_rotation(&n)));
        assert!(!verify_rotation(&o, other.public_key().as_bytes(), &sig));
        assert!(!verify_rotation(&o, &o, &old.sign_rotation(&o)));
        assert!(!verify_rotation(&o, &n, &sig[..63]));
        // A signature over the bare keys, without the context, is not one.
        use ed25519_dalek::Signer;
        let mut bare = o.to_vec();
        bare.extend_from_slice(&n);
        assert!(!verify_rotation(&o, &n, &old.key.sign(&bare).to_bytes()));
    }
}
