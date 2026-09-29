//! The release signature, against the key compiled in.

use anyhow::{Context, Result};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use super::*;

pub(super) fn verifying_key() -> Result<VerifyingKey> {
    let raw = hex::decode(RELEASE_PUBLIC_KEY_HEX).context("public key hex")?;
    let arr: [u8; 32] = raw.as_slice().try_into().context("public key length")?;
    VerifyingKey::from_bytes(&arr).context("public key bytes")
}

/// Check a raw ed25519 signature (64 bytes, as `openssl pkeyutl -sign
/// -rawin` writes it) over the asset's bytes.
pub fn verify(asset: &[u8], sig: &[u8]) -> Result<()> {
    let sig = Signature::from_slice(sig).context("signature is not 64 bytes")?;
    verifying_key()?
        .verify(asset, &sig)
        .map_err(|_| anyhow::anyhow!("signature does not match the release key"))
}
