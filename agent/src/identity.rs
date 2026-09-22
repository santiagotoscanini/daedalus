//! The machine's key: an ed25519 keypair made on first start, kept in the
//! data directory, and the only credential the agent ever presents.
//!
//! The box keys everything it knows about a machine on the public half, so
//! the private half IS the machine's identity: a copy of the file on another
//! computer would let it impersonate this one. On Windows the seed is
//! wrapped with DPAPI under the machine's scope before it touches disk — the
//! file is only readable back on this machine, by a process on it (and the
//! service runs as SYSTEM, so ordinary users still cannot). Elsewhere the
//! seed is a plain file, mode 0600, which is the ordinary SSH-key posture.
//!
//! Signing is over bytes the caller hands in; see hello.rs for what is
//! signed and why it is the serialised string and not the value.

use anyhow::{Context, Result};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::config::data_dir;

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

fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("writing {}", path.display()))?;
        std::io::Write::write_all(&mut f, bytes)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        // ProgramData\daedalus-agent is created by the installer running as an
        // administrator, so it inherits an ACL ordinary users cannot read; the
        // DPAPI wrapping is the layer that matters here.
        std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))
    }
}

#[cfg(windows)]
fn seal(seed: &[u8]) -> Result<Vec<u8>> {
    dpapi::protect(seed)
}
#[cfg(windows)]
fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    dpapi::unprotect(sealed)
}
#[cfg(not(windows))]
fn seal(seed: &[u8]) -> Result<Vec<u8>> {
    Ok(seed.to_vec())
}
#[cfg(not(windows))]
fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    Ok(sealed.to_vec())
}

#[cfg(windows)]
mod dpapi {
    use anyhow::{Context, Result};
    use windows::core::w;
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_LOCAL_MACHINE,
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr().cast_mut(),
        }
    }

    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: the blob was allocated by DPAPI and is freed exactly once here.
        unsafe {
            let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(out.pbData.cast())));
            v
        }
    }

    pub fn protect(seed: &[u8]) -> Result<Vec<u8>> {
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: input blob points at `seed` for the call's duration.
        unsafe {
            CryptProtectData(
                &blob(seed),
                w!("daedalus-agent identity"),
                None,
                None,
                None,
                CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .context("DPAPI protect")?;
        }
        Ok(take(out))
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>> {
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as above.
        unsafe {
            CryptUnprotectData(
                &blob(sealed),
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .context("DPAPI unprotect")?;
        }
        Ok(take(out))
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
