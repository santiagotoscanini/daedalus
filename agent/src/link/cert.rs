//! The certificate each end of the link presents, and the one thing ever
//! read back from a peer's: its ed25519 public key.
//!
//! TLS wants a certificate; the link has no CA and trusts keys, not names
//! (link/mod.rs). So each agent makes a minimal self-signed X.509 v3
//! certificate from its identity key — subject and issuer
//! `CN=daedalus-agent <node id>`, valid from 2026 to the RFC 5280 "no
//! expiry" date, no extensions — written by the small DER writer below and
//! signed with the same key. It is regenerated at every start and never
//! stored: the key is the identity, the certificate is its envelope.
//!
//! Reading a peer's goes through webpki's parser (`ParsedCertificate`), and
//! takes its SubjectPublicKeyInfo only if it is an ed25519 key. The
//! certificate's own signature is not checked and need not be: the peer
//! proves it holds the key by signing the handshake with it (TLS 1.3's
//! CertificateVerify, which the verifiers in tls.rs check), and whether the
//! key is the right one is the pin's business.

use anyhow::{bail, Result};
use ed25519_dalek::Signer;
use rustls::pki_types::CertificateDer;
use sha2::{Digest, Sha256};

use super::crypto::SPKI_PREFIX;

/// A DER element: tag, length, contents.
fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let n = content.len();
    if n < 0x80 {
        out.push(n as u8);
    } else {
        let bytes = n.to_be_bytes();
        let skip = bytes.iter().take_while(|b| **b == 0).count();
        out.push(0x80 | (bytes.len() - skip) as u8);
        out.extend_from_slice(&bytes[skip..]);
    }
    out.extend_from_slice(content);
    out
}

fn seq(parts: &[&[u8]]) -> Vec<u8> {
    tlv(0x30, &parts.concat())
}

/// `1.3.101.112`, id-Ed25519, as an AlgorithmIdentifier without parameters.
const ED25519_ALG: [u8; 7] = [0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70];
/// `2.5.4.3`, commonName.
const CN_OID: [u8; 5] = [0x06, 0x03, 0x55, 0x04, 0x03];

/// A self-signed certificate for `key`, as DER.
pub fn self_signed(key: &ed25519_dalek::SigningKey) -> CertificateDer<'static> {
    let public = key.verifying_key().to_bytes();
    let digest = Sha256::digest(public);
    // A positive serial from the key: eight bytes, top bit clear, never zero.
    let mut serial = digest[..8].to_vec();
    serial[0] = (serial[0] & 0x7f) | 0x01;
    let name = {
        let cn = format!("daedalus-agent {}", hex::encode(&digest[..8]));
        let attr = seq(&[&CN_OID, &tlv(0x0c, cn.as_bytes())]);
        seq(&[&tlv(0x31, &attr)])
    };
    let validity = seq(&[&tlv(0x17, b"260101000000Z"), &tlv(0x18, b"99991231235959Z")]);
    let mut spki = SPKI_PREFIX.to_vec();
    spki.extend_from_slice(&public);
    let tbs = seq(&[
        // [0] EXPLICIT version: v3.
        &tlv(0xa0, &tlv(0x02, &[0x02])),
        &tlv(0x02, &serial),
        &ED25519_ALG,
        &name,
        &validity,
        &name,
        &spki,
    ]);
    let signature = key.sign(&tbs).to_bytes();
    let mut bits = vec![0u8];
    bits.extend_from_slice(&signature);
    CertificateDer::from(seq(&[&tbs, &ED25519_ALG, &tlv(0x03, &bits)]))
}

/// The ed25519 key a peer's certificate carries; an error for anything that
/// is not a certificate, or whose key is of another kind.
pub fn public_key_of(cert: &CertificateDer<'_>) -> Result<[u8; 32]> {
    let parsed = match rustls::server::ParsedCertificate::try_from(cert) {
        Ok(p) => p,
        Err(e) => bail!("not a certificate: {e}"),
    };
    let spki = parsed.subject_public_key_info();
    match spki.as_ref().strip_prefix(&SPKI_PREFIX[..]) {
        Some(key) if key.len() == 32 => Ok(key.try_into().expect("32 bytes")),
        _ => bail!("the certificate's key is not an ed25519 key"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_certificate_parses_and_carries_the_key() {
        let key = ed25519_dalek::SigningKey::generate(&mut rand_core::OsRng);
        let cert = self_signed(&key);
        assert_eq!(
            public_key_of(&cert).unwrap(),
            key.verifying_key().to_bytes()
        );
        // Deterministic: ed25519 signatures are, and nothing else varies.
        assert_eq!(self_signed(&key), cert);
        assert!(public_key_of(&CertificateDer::from(vec![0x30, 0x00])).is_err());
    }

    #[test]
    fn long_lengths_use_the_long_form() {
        assert_eq!(tlv(0x04, &[1; 3]), [0x04, 3, 1, 1, 1]);
        let long = tlv(0x04, &[0; 200]);
        assert_eq!(&long[..3], &[0x04, 0x81, 200]);
        let longer = tlv(0x04, &[0; 300]);
        assert_eq!(&longer[..4], &[0x04, 0x82, 0x01, 0x2c]);
    }
}
