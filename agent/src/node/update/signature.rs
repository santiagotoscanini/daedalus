//! The release manifest's signature, against the keys compiled in.

use anyhow::{bail, Context, Result};
use ed25519_dalek::{Signature, VerifyingKey};

use super::*;

/// What a manifest signature covers besides the manifest: a context of its
/// own, so a signature made with the release key over anything else — a
/// binary, under the per-asset scheme the manifest replaced — is never one
/// over a manifest.
pub const MANIFEST_CONTEXT: &[u8] = b"daedalus-agent release manifest v1\0";

/// The keys a release may be signed with (`RELEASE_PUBLIC_KEYS`), parsed.
pub fn verifying_keys() -> Result<Vec<VerifyingKey>> {
    RELEASE_PUBLIC_KEYS
        .iter()
        .map(|hex_key| {
            let raw = hex::decode(hex_key).context("public key hex")?;
            let arr: [u8; 32] = raw.as_slice().try_into().context("public key length")?;
            VerifyingKey::from_bytes(&arr).context("public key bytes")
        })
        .collect()
}

/// Check a raw ed25519 signature (64 bytes, as `openssl pkeyutl -sign
/// -rawin` writes it) over `MANIFEST_CONTEXT` then the manifest's bytes,
/// against any of `keys`.
pub fn verify_manifest(manifest: &[u8], sig: &[u8], keys: &[VerifyingKey]) -> Result<()> {
    let sig = Signature::from_slice(sig).context("the signature is not 64 bytes")?;
    let mut signed = Vec::with_capacity(MANIFEST_CONTEXT.len() + manifest.len());
    signed.extend_from_slice(MANIFEST_CONTEXT);
    signed.extend_from_slice(manifest);
    if keys.iter().any(|k| k.verify_strict(&signed, &sig).is_ok()) {
        Ok(())
    } else {
        bail!("the manifest's signature matches no release key")
    }
}
