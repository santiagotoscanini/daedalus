//! The primitives rustls runs the controller link on, all pure Rust: one
//! TLS 1.3 suite (`TLS13_CHACHA20_POLY1305_SHA256`), one key exchange
//! (X25519) and one signature scheme (ed25519) — the only kind of key an
//! agent has. rustls does the protocol; this file hands it the maths from
//! the RustCrypto and dalek crates (`chacha20poly1305`, `sha2`, `hmac`,
//! `x25519-dalek`, `ed25519-dalek`) and the OS's random numbers.
//!
//! Why not rustls' ring provider: ring is C and assembly, built by a C
//! compiler for each target, and the gate checks the Windows and macOS
//! builds from a Linux container that has no such compiler for them (and
//! the crate's rule is that no C crypto library is cross-compiled to check
//! a target). The suite is the one ring's provider offers under the same
//! name; the record layer below follows ring's provider line for line
//! (nonce from the IV and sequence number, the TLS 1.3 additional data, the
//! content type appended inside the ciphertext), and a test on Linux runs a
//! handshake and a record in each direction between this provider and
//! ring's, so a mistake here cannot hide behind both ends sharing it.

use std::sync::Arc;

use chacha20poly1305::aead::{AeadInPlace, KeyInit};
use chacha20poly1305::ChaCha20Poly1305;
use ed25519_dalek::Signer as _;
use hmac::Mac;
use rustls::crypto::cipher::{
    make_tls13_aad, AeadKey, InboundOpaqueMessage, InboundPlainMessage, Iv, MessageDecrypter,
    MessageEncrypter, Nonce, OutboundOpaqueMessage, OutboundPlainMessage, PrefixedPayload,
    Tls13AeadAlgorithm, UnsupportedOperationError,
};
use rustls::crypto::{
    hash, hmac as rhmac, tls13::HkdfUsingHmac, ActiveKeyExchange, CryptoProvider, GetRandomFailed,
    KeyProvider, SecureRandom, SharedSecret, SupportedKxGroup, WebPkiSupportedAlgorithms,
};
use rustls::pki_types::{
    alg_id, AlgorithmIdentifier, InvalidSignature, PrivateKeyDer, SignatureVerificationAlgorithm,
    SubjectPublicKeyInfoDer,
};
use rustls::sign::{Signer, SigningKey};
use rustls::{
    CipherSuite, CipherSuiteCommon, ConnectionTrafficSecrets, ContentType, Error, NamedGroup,
    ProtocolVersion, SignatureAlgorithm, SignatureScheme, SupportedCipherSuite, Tls13CipherSuite,
};
use sha2::Digest;
use zeroize::{Zeroize, Zeroizing};

/// The provider every link connection is built with (tls.rs).
pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(CryptoProvider {
        cipher_suites: vec![TLS13_CHACHA20_POLY1305_SHA256],
        kx_groups: vec![&X25519],
        signature_verification_algorithms: ALGORITHMS,
        secure_random: &OsRandom,
        key_provider: &Ed25519Keys,
    })
}

// ── the suite ─────────────────────────────────────────────────────────────

pub static TLS13_CHACHA20_POLY1305_SHA256: SupportedCipherSuite =
    SupportedCipherSuite::Tls13(&Tls13CipherSuite {
        common: CipherSuiteCommon {
            suite: CipherSuite::TLS13_CHACHA20_POLY1305_SHA256,
            hash_provider: &Sha256,
            // RFC 8446 §5.5: ChaCha20-Poly1305 has no practical limit.
            confidentiality_limit: u64::MAX,
        },
        hkdf_provider: &HkdfUsingHmac(&HmacSha256),
        aead_alg: &ChaChaAead,
        quic: None,
    });

struct Sha256;

impl hash::Hash for Sha256 {
    fn start(&self) -> Box<dyn hash::Context> {
        Box::new(Sha256Context(sha2::Sha256::new()))
    }

    fn hash(&self, data: &[u8]) -> hash::Output {
        hash::Output::new(&sha2::Sha256::digest(data))
    }

    fn output_len(&self) -> usize {
        32
    }

    fn algorithm(&self) -> hash::HashAlgorithm {
        hash::HashAlgorithm::SHA256
    }
}

struct Sha256Context(sha2::Sha256);

impl hash::Context for Sha256Context {
    fn fork_finish(&self) -> hash::Output {
        hash::Output::new(&self.0.clone().finalize())
    }

    fn fork(&self) -> Box<dyn hash::Context> {
        Box::new(Sha256Context(self.0.clone()))
    }

    fn finish(self: Box<Self>) -> hash::Output {
        hash::Output::new(&self.0.finalize())
    }

    fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }
}

type HmacSha256Impl = hmac::Hmac<sha2::Sha256>;

struct HmacSha256;

impl rhmac::Hmac for HmacSha256 {
    fn with_key(&self, key: &[u8]) -> Box<dyn rhmac::Key> {
        // HMAC takes a key of any length.
        Box::new(HmacKey(
            <HmacSha256Impl as Mac>::new_from_slice(key).expect("HMAC accepts any key length"),
        ))
    }

    fn hash_output_len(&self) -> usize {
        32
    }
}

struct HmacKey(HmacSha256Impl);

impl rhmac::Key for HmacKey {
    fn sign_concat(&self, first: &[u8], middle: &[&[u8]], last: &[u8]) -> rhmac::Tag {
        let mut mac = self.0.clone();
        mac.update(first);
        for m in middle {
            mac.update(m);
        }
        mac.update(last);
        rhmac::Tag::new(&mac.finalize().into_bytes())
    }

    fn tag_len(&self) -> usize {
        32
    }
}

const TAG_LEN: usize = 16;

struct ChaChaAead;

impl Tls13AeadAlgorithm for ChaChaAead {
    fn encrypter(&self, key: AeadKey, iv: Iv) -> Box<dyn MessageEncrypter> {
        Box::new(ChaChaRecords {
            cipher: ChaCha20Poly1305::new_from_slice(key.as_ref())
                .expect("rustls hands over a key of key_len() bytes"),
            iv,
        })
    }

    fn decrypter(&self, key: AeadKey, iv: Iv) -> Box<dyn MessageDecrypter> {
        Box::new(ChaChaRecords {
            cipher: ChaCha20Poly1305::new_from_slice(key.as_ref())
                .expect("rustls hands over a key of key_len() bytes"),
            iv,
        })
    }

    fn key_len(&self) -> usize {
        32
    }

    fn extract_keys(
        &self,
        key: AeadKey,
        iv: Iv,
    ) -> Result<ConnectionTrafficSecrets, UnsupportedOperationError> {
        Ok(ConnectionTrafficSecrets::Chacha20Poly1305 { key, iv })
    }
}

/// One direction's record protection.
struct ChaChaRecords {
    cipher: ChaCha20Poly1305,
    iv: Iv,
}

impl MessageEncrypter for ChaChaRecords {
    fn encrypt(
        &mut self,
        msg: OutboundPlainMessage<'_>,
        seq: u64,
    ) -> Result<OutboundOpaqueMessage, Error> {
        let total_len = self.encrypted_payload_len(msg.payload.len());
        let mut payload = PrefixedPayload::with_capacity(total_len);
        let nonce = Nonce::new(&self.iv, seq).0;
        let aad = make_tls13_aad(total_len);
        payload.extend_from_chunks(&msg.payload);
        payload.extend_from_slice(&msg.typ.to_array());
        let tag = self
            .cipher
            .encrypt_in_place_detached((&nonce).into(), &aad, payload.as_mut())
            .map_err(|_| Error::EncryptError)?;
        payload.extend_from_slice(&tag);
        Ok(OutboundOpaqueMessage::new(
            ContentType::ApplicationData,
            ProtocolVersion::TLSv1_2,
            payload,
        ))
    }

    fn encrypted_payload_len(&self, payload_len: usize) -> usize {
        payload_len + 1 + TAG_LEN
    }
}

impl MessageDecrypter for ChaChaRecords {
    fn decrypt<'a>(
        &mut self,
        mut msg: InboundOpaqueMessage<'a>,
        seq: u64,
    ) -> Result<InboundPlainMessage<'a>, Error> {
        let payload = &mut msg.payload;
        let Some(plain_len) = payload.len().checked_sub(TAG_LEN) else {
            return Err(Error::DecryptError);
        };
        let nonce = Nonce::new(&self.iv, seq).0;
        let aad = make_tls13_aad(payload.len());
        let mut tag = [0u8; TAG_LEN];
        tag.copy_from_slice(&payload[plain_len..]);
        self.cipher
            .decrypt_in_place_detached(
                (&nonce).into(),
                &aad,
                &mut payload[..plain_len],
                (&tag).into(),
            )
            .map_err(|_| Error::DecryptError)?;
        payload.truncate(plain_len);
        msg.into_tls13_unpadded_message()
    }
}

// ── key exchange ──────────────────────────────────────────────────────────

#[derive(Debug)]
struct X25519Group;

static X25519: X25519Group = X25519Group;

impl SupportedKxGroup for X25519Group {
    /// A fresh secret from the OS; a failing RNG is an error, not a panic.
    fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, Error> {
        use rand_core::RngCore;
        let mut secret = Zeroizing::new([0u8; 32]);
        rand_core::OsRng
            .try_fill_bytes(&mut secret[..])
            .map_err(|_| Error::FailedToGetRandomBytes)?;
        Ok(Box::new(X25519Exchange::from_secret(secret)))
    }

    fn name(&self) -> NamedGroup {
        NamedGroup::X25519
    }
}

/// One exchange: the secret scalar (wiped when dropped) and its public
/// share. RFC 7748's function directly, so the tests can drive it with
/// the RFC's own scalars.
struct X25519Exchange {
    secret: Zeroizing<[u8; 32]>,
    public: [u8; 32],
}

impl X25519Exchange {
    fn from_secret(secret: Zeroizing<[u8; 32]>) -> Self {
        let public = x25519_dalek::x25519(*secret, x25519_dalek::X25519_BASEPOINT_BYTES);
        Self { secret, public }
    }
}

impl ActiveKeyExchange for X25519Exchange {
    fn complete(self: Box<Self>, peer_pub_key: &[u8]) -> Result<SharedSecret, Error> {
        let peer: [u8; 32] = peer_pub_key
            .try_into()
            .map_err(|_| Error::from(rustls::PeerMisbehaved::InvalidKeyShare))?;
        let shared = Zeroizing::new(x25519_dalek::x25519(*self.secret, peer));
        // RFC 8446 §7.4.2 / RFC 7748 §6.1: an all-zero result is a
        // small-order peer key. Checked without an early exit.
        if shared.iter().fold(0u8, |acc, b| acc | b) == 0 {
            return Err(rustls::PeerMisbehaved::InvalidKeyShare.into());
        }
        Ok(SharedSecret::from(&shared[..]))
    }

    fn pub_key(&self) -> &[u8] {
        &self.public
    }

    fn group(&self) -> NamedGroup {
        NamedGroup::X25519
    }
}

// ── randomness ────────────────────────────────────────────────────────────

#[derive(Debug)]
struct OsRandom;

impl SecureRandom for OsRandom {
    fn fill(&self, buf: &mut [u8]) -> Result<(), GetRandomFailed> {
        use rand_core::RngCore;
        rand_core::OsRng
            .try_fill_bytes(buf)
            .map_err(|_| GetRandomFailed)
    }
}

// ── ed25519: signing, verifying, loading ──────────────────────────────────

/// ed25519 as webpki and the handshake verify it.
#[derive(Debug)]
struct Ed25519Verify;

static ED25519_VERIFY: Ed25519Verify = Ed25519Verify;

const ALGORITHMS: WebPkiSupportedAlgorithms = WebPkiSupportedAlgorithms {
    all: &[&ED25519_VERIFY],
    mapping: &[(SignatureScheme::ED25519, &[&ED25519_VERIFY])],
};

impl SignatureVerificationAlgorithm for Ed25519Verify {
    fn verify_signature(
        &self,
        public_key: &[u8],
        message: &[u8],
        signature: &[u8],
    ) -> Result<(), InvalidSignature> {
        verify_ed25519(public_key, message, signature)
            .then_some(())
            .ok_or(InvalidSignature)
    }

    fn public_key_alg_id(&self) -> AlgorithmIdentifier {
        alg_id::ED25519
    }

    fn signature_alg_id(&self) -> AlgorithmIdentifier {
        alg_id::ED25519
    }
}

/// A strict ed25519 check (no malleable signatures, no small-order keys).
pub fn verify_ed25519(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let Ok(key) = <[u8; 32]>::try_from(public_key) else {
        return false;
    };
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&key) else {
        return false;
    };
    let Ok(sig) = ed25519_dalek::Signature::from_slice(signature) else {
        return false;
    };
    key.verify_strict(message, &sig).is_ok()
}

/// The fixed PKCS#8 v1 prefix of an ed25519 private key (RFC 8410 §7): the
/// 32-byte seed follows it.
pub const PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// The fixed SubjectPublicKeyInfo prefix of an ed25519 public key (RFC 8410
/// §4): the 32-byte key follows it.
pub const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// An ed25519 seed as PKCS#8, the form rustls loads keys in.
pub fn pkcs8(seed: &[u8; 32]) -> Vec<u8> {
    let mut der = PKCS8_PREFIX.to_vec();
    der.extend_from_slice(seed);
    der
}

/// An ed25519 public key as SubjectPublicKeyInfo DER.
pub fn spki(public_key: &[u8; 32]) -> Vec<u8> {
    let mut der = SPKI_PREFIX.to_vec();
    der.extend_from_slice(public_key);
    der
}

/// Loads ed25519 keys, in the PKCS#8 form `pkcs8` writes; nothing else — an
/// agent has no other kind of key.
#[derive(Debug)]
struct Ed25519Keys;

impl KeyProvider for Ed25519Keys {
    fn load_private_key(
        &self,
        key_der: PrivateKeyDer<'static>,
    ) -> Result<Arc<dyn SigningKey>, Error> {
        let PrivateKeyDer::Pkcs8(der) = key_der else {
            return Err(Error::General(
                "only an ed25519 key in PKCS#8 is loaded here".into(),
            ));
        };
        let mut der = der;
        let seed: Option<Zeroizing<[u8; 32]>> = der
            .secret_pkcs8_der()
            .strip_prefix(&PKCS8_PREFIX[..])
            .and_then(|s| <[u8; 32]>::try_from(s).ok())
            .map(Zeroizing::new);
        // The DER held the seed: wiped here, the one copy rustls handed over.
        der.zeroize();
        let seed = seed.ok_or_else(|| Error::General("not an ed25519 PKCS#8 key".into()))?;
        // ed25519-dalek wipes its own copy when the key is dropped.
        Ok(Arc::new(Ed25519Key(Arc::new(
            ed25519_dalek::SigningKey::from_bytes(&seed),
        ))))
    }
}

/// An identity key, as rustls signs the handshake with it.
#[derive(Clone)]
struct Ed25519Key(Arc<ed25519_dalek::SigningKey>);

impl std::fmt::Debug for Ed25519Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the seed.
        write!(
            f,
            "Ed25519Key({})",
            hex::encode(self.0.verifying_key().as_bytes())
        )
    }
}

impl SigningKey for Ed25519Key {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        offered
            .contains(&SignatureScheme::ED25519)
            .then(|| Box::new(self.clone()) as Box<dyn Signer>)
    }

    fn public_key(&self) -> Option<SubjectPublicKeyInfoDer<'_>> {
        Some(SubjectPublicKeyInfoDer::from(spki(
            self.0.verifying_key().as_bytes(),
        )))
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::ED25519
    }
}

impl Signer for Ed25519Key {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, Error> {
        Ok(self.0.sign(message).to_bytes().to_vec())
    }

    fn scheme(&self) -> SignatureScheme {
        SignatureScheme::ED25519
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_through_their_der_forms() {
        let key = ed25519_dalek::SigningKey::generate(&mut rand_core::OsRng);
        let loaded = Ed25519Keys
            .load_private_key(PrivateKeyDer::Pkcs8(pkcs8(key.as_bytes()).into()))
            .unwrap();
        let spki_der = loaded.public_key().unwrap();
        assert_eq!(spki_der.as_ref(), &spki(key.verifying_key().as_bytes())[..]);
        let signer = loaded.choose_scheme(&[SignatureScheme::ED25519]).unwrap();
        let sig = signer.sign(b"m").unwrap();
        assert!(verify_ed25519(key.verifying_key().as_bytes(), b"m", &sig));
        assert!(!verify_ed25519(key.verifying_key().as_bytes(), b"n", &sig));
        assert!(loaded
            .choose_scheme(&[SignatureScheme::ECDSA_NISTP256_SHA256])
            .is_none());
        assert!(Ed25519Keys
            .load_private_key(PrivateKeyDer::Pkcs8(vec![0u8; 48].into()))
            .is_err());
    }

    #[test]
    fn hmac_matches_rfc_4231_case_2() {
        use rustls::crypto::hmac::Hmac as _;
        let tag = HmacSha256
            .with_key(b"Jefe")
            .sign(&[b"what do ya want ", b"for nothing?"]);
        assert_eq!(
            hex::encode(tag.as_ref()),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn a_small_order_share_is_refused() {
        let kx = X25519.start().unwrap();
        assert!(kx.complete(&[0u8; 32]).is_err());
        let kx = X25519.start().unwrap();
        assert!(kx.complete(&[1u8; 31]).is_err());
    }

    fn unhex<const N: usize>(s: &str) -> [u8; N] {
        let mut out = [0u8; N];
        hex::decode_to_slice(s.replace([' ', '\n'], ""), &mut out).unwrap();
        out
    }

    /// RFC 8439 §2.8.2: the AEAD itself, key, nonce, AAD and all.
    #[test]
    fn chacha20_poly1305_matches_rfc_8439() {
        let key: [u8; 32] =
            unhex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
        let nonce: [u8; 12] = unhex("070000004041424344454647");
        let aad: [u8; 12] = unhex("50515253c0c1c2c3c4c5c6c7");
        let plain = b"Ladies and Gentlemen of the class of '99: \
            If I could offer you only one tip for the future, sunscreen would be it.";
        let cipher: [u8; 114] = unhex(
            "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6\
             3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36\
             92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc\
             3ff4def08e4b7a9de576d26586cec64b6116",
        );
        let tag: [u8; 16] = unhex("1ae10b594f09e26a7e902ecbd0600691");
        let c = ChaCha20Poly1305::new_from_slice(&key).unwrap();
        let mut buf = plain.to_vec();
        let got = c
            .encrypt_in_place_detached((&nonce).into(), &aad, &mut buf)
            .unwrap();
        assert_eq!(buf, cipher);
        assert_eq!(got.as_slice(), tag);
        c.decrypt_in_place_detached((&nonce).into(), &aad, &mut buf, (&tag).into())
            .unwrap();
        assert_eq!(buf, plain);
    }

    /// RFC 7748 §6.1, through this provider's own exchange.
    #[test]
    fn x25519_matches_rfc_7748() {
        let alice = unhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
        let bob = unhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
        let alice_pub: [u8; 32] =
            unhex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
        let bob_pub: [u8; 32] =
            unhex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
        let shared: [u8; 32] =
            unhex("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
        let a = Box::new(X25519Exchange::from_secret(Zeroizing::new(alice)));
        let b = Box::new(X25519Exchange::from_secret(Zeroizing::new(bob)));
        assert_eq!(a.pub_key(), alice_pub);
        assert_eq!(b.pub_key(), bob_pub);
        assert_eq!(a.complete(&bob_pub).unwrap().secret_bytes(), shared);
        assert_eq!(b.complete(&alice_pub).unwrap().secret_bytes(), shared);
    }

    /// RFC 8032 §7.1 test 1 (the empty message), through the key rustls
    /// loads and the check the handshake runs.
    #[test]
    fn ed25519_matches_rfc_8032_test_1() {
        let seed = unhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
        let public: [u8; 32] =
            unhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        let sig: [u8; 64] = unhex(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155\
             5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        );
        let key = Ed25519Keys
            .load_private_key(PrivateKeyDer::Pkcs8(pkcs8(&seed).into()))
            .unwrap();
        assert_eq!(key.public_key().unwrap().as_ref(), &spki(&public)[..]);
        let signer = key.choose_scheme(&[SignatureScheme::ED25519]).unwrap();
        assert_eq!(signer.sign(b"").unwrap(), sig);
        assert!(verify_ed25519(&public, b"", &sig));
        let mut bad = sig;
        bad[63] ^= 1;
        assert!(!verify_ed25519(&public, b"", &bad));
    }

    /// One record sealed at `seq`, as rustls would write it: the payload
    /// (content type inside, tag after), ready to be opened.
    fn seal(key: &[u8; 32], iv: &[u8; 12], seq: u64, plain: &[u8]) -> Vec<u8> {
        let mut enc = ChaChaAead.encrypter(AeadKey::from(*key), Iv::from(*iv));
        let msg = OutboundPlainMessage {
            typ: ContentType::ApplicationData,
            version: ProtocolVersion::TLSv1_2,
            payload: rustls::crypto::cipher::OutboundChunks::Single(plain),
        };
        enc.encrypt(msg, seq).unwrap().payload.as_ref().to_vec()
    }

    fn open(key: &[u8; 32], iv: &[u8; 12], seq: u64, sealed: &mut [u8]) -> Result<Vec<u8>, Error> {
        let mut dec = ChaChaAead.decrypter(AeadKey::from(*key), Iv::from(*iv));
        let msg = InboundOpaqueMessage::new(
            ContentType::ApplicationData,
            ProtocolVersion::TLSv1_2,
            sealed,
        );
        dec.decrypt(msg, seq).map(|m| m.payload.to_vec())
    }

    #[test]
    fn a_tampered_record_or_a_wrong_sequence_number_does_not_open() {
        let (key, iv) = ([7u8; 32], [9u8; 12]);
        let sealed = seal(&key, &iv, 5, b"hello");
        assert_eq!(sealed.len(), 5 + 1 + TAG_LEN);
        assert_eq!(open(&key, &iv, 5, &mut sealed.clone()).unwrap(), b"hello");
        let mut tag_flipped = sealed.clone();
        *tag_flipped.last_mut().unwrap() ^= 1;
        assert_eq!(
            open(&key, &iv, 5, &mut tag_flipped).unwrap_err(),
            Error::DecryptError
        );
        let mut body_flipped = sealed.clone();
        body_flipped[0] ^= 1;
        assert_eq!(
            open(&key, &iv, 5, &mut body_flipped).unwrap_err(),
            Error::DecryptError
        );
        assert_eq!(
            open(&key, &iv, 6, &mut sealed.clone()).unwrap_err(),
            Error::DecryptError
        );
        assert_eq!(
            open(&key, &iv, 5, &mut sealed[..TAG_LEN - 1].to_vec()).unwrap_err(),
            Error::DecryptError
        );
    }
}
