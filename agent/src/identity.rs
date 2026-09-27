//! The machine's key: an ed25519 keypair made on first start, kept in the
//! data directory, and the only credential the agent ever presents.
//!
//! The box keys everything it knows about a machine on the public half, so
//! the private half IS the machine's identity: a copy of the file on another
//! computer would let it impersonate this one. On Windows the seed is
//! wrapped with DPAPI under the machine's scope before it touches disk, so a
//! copy is useless on any other computer — but any process on THIS machine
//! can unwrap it, so keeping local users out rests on the file's ACL (see
//! `write_private`, os/windows/mod.rs). Elsewhere the seed is a plain file,
//! mode 0600, which is the ordinary SSH-key posture (os/unix.rs). How the
//! seed is sealed and written is `os::{seal, unseal, write_private}`.
//!
//! Signing is over bytes the caller hands in; see hello.rs for what is
//! signed and why it is the serialised string and not the value.

use anyhow::{Context, Result};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::config::data_dir;
use crate::os::{seal, unseal, write_private};

const FILE: &str = "identity.key";

pub struct Identity {
    key: SigningKey,
}

impl Identity {
    /// Load the key, or make one and keep it.
    pub fn load_or_create() -> Result<Self> {
        let path = data_dir().join(FILE);
        if path.exists() {
            let sealed =
                std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
            let seed = unseal(&sealed).context("the identity file could not be opened")?;
            let arr: [u8; 32] = seed.as_slice().try_into().context("identity seed length")?;
            return Ok(Self {
                key: SigningKey::from_bytes(&arr),
            });
        }
        let key = SigningKey::generate(&mut rand_core::OsRng);
        std::fs::create_dir_all(data_dir()).context("creating the data directory")?;
        write_private(&path, &seal(key.as_bytes())?)?;
        tracing::info!(path = %path.display(), "made this machine's identity key");
        Ok(Self { key })
    }

    pub fn public_key(&self) -> VerifyingKey {
        self.key.verifying_key()
    }

    pub fn public_key_hex(&self) -> String {
        hex::encode(self.public_key().as_bytes())
    }

    /// What the box calls this machine: sixteen hex characters of SHA-256(pubkey).
    pub fn node_id(&self) -> String {
        hex::encode(Sha256::digest(self.public_key().as_bytes()))[..16].to_string()
    }

    pub fn sign_hex(&self, bytes: &[u8]) -> String {
        hex::encode(self.key.sign(bytes).to_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    #[test]
    fn signs_what_the_box_will_verify() {
        let key = SigningKey::generate(&mut rand_core::OsRng);
        let id = Identity { key };
        let sig = id.sign_hex(b"payload");
        let sig = ed25519_dalek::Signature::from_slice(&hex::decode(sig).unwrap()).unwrap();
        assert!(id.public_key().verify(b"payload", &sig).is_ok());
        assert_eq!(id.node_id().len(), 16);
        assert_eq!(id.public_key_hex().len(), 64);
    }
}
