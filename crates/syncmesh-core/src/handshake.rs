//! The link handshake (`transport/src/handshake.ts`): what a sniffer may learn from a link, and
//! what it may not.
//!
//! Events carry their own signatures, so nothing here is what makes a write trustworthy. What it
//! adds is confidentiality on media shared with strangers — a radio, an access point. Two frames,
//! one per direction, crossing without waiting: each end signs a fresh X25519 public key with the
//! Ed25519 key that *is* its peer id, and both derive the session keys from the pair. Signing is
//! what stops a machine in the middle; the key being fresh per link is what stops a stolen device
//! reading yesterday's traffic.
//!
//! Randomness is the caller's — the ephemeral secret and every seal nonce are parameters — so the
//! crate stays free of a random source and every byte here is reproducible from the vectors.

use chacha20poly1305::aead::Aead;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::event::PeerId;
use crate::hex::to_hex;
use crate::identity::{Identity, verify};

/// A signed offer of an ephemeral key. Both ends send one, unprompted, and neither waits.
pub const HELLO: u8 = 0x01;
/// A frame under the session key: nonce, then ciphertext and its tag.
pub const SEALED: u8 = 0x02;

pub const KEY_BYTES: usize = 32;
const SIG_BYTES: usize = 64;
pub const NONCE_BYTES: usize = 24;
const TAG_BYTES: usize = 16;

pub const HELLO_BYTES: usize = 1 + KEY_BYTES * 2 + SIG_BYTES;
/// What sealing costs on the wire: the kind, the nonce, and Poly1305's tag.
pub const SEAL_OVERHEAD: usize = 1 + NONCE_BYTES + TAG_BYTES;

/// Domain separation: the signature says "this ephemeral key is mine, for a link session" and
/// cannot be lifted from anywhere else the same Ed25519 key signs.
pub const CONTEXT: &[u8] = b"syncmesh/link/hello/v1";
pub const INFO: &[u8] = b"syncmesh/link/session/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeFailed {
    NotAHello { length: usize },
    BadSignature,
    Reflected,
    UnusableEphemeral,
    NotSealed,
    DidNotOpen,
    TooLarge,
}

impl std::fmt::Display for HandshakeFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandshakeFailed::NotAHello { length } => {
                write!(f, "expected a {HELLO_BYTES}-byte hello, got {length} bytes")
            }
            HandshakeFailed::BadSignature => {
                f.write_str("the hello was not signed by the key it claims")
            }
            HandshakeFailed::Reflected => f.write_str("the hello is our own, reflected back"),
            HandshakeFailed::UnusableEphemeral => {
                f.write_str("the peer offered an unusable ephemeral key")
            }
            HandshakeFailed::NotSealed => f.write_str("not a sealed frame"),
            HandshakeFailed::DidNotOpen => {
                f.write_str("the frame did not open under the session key")
            }
            HandshakeFailed::TooLarge => f.write_str("the plaintext is too large to seal"),
        }
    }
}

impl std::error::Error for HandshakeFailed {}

/// A peer's opening frame, once its signature has been checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hello {
    /// The frame as it travelled; both ends hash the pair, so the exact bytes matter.
    pub frame: [u8; HELLO_BYTES],
    pub peer_id: PeerId,
    /// The Ed25519 key the signature was checked against, which is what the peer id is made of.
    pub public_key: [u8; KEY_BYTES],
    /// This link's X25519 key, discarded when the link ends.
    pub ephemeral: [u8; KEY_BYTES],
}

/// One direction each: a key is used to seal or to open, never both.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionKeys {
    pub seal: [u8; KEY_BYTES],
    pub open: [u8; KEY_BYTES],
}

impl std::fmt::Debug for SessionKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionKeys { .. }")
    }
}

fn signed_bytes(public_key: &[u8; KEY_BYTES], ephemeral: &[u8; KEY_BYTES]) -> Vec<u8> {
    let mut out = Vec::with_capacity(CONTEXT.len() + KEY_BYTES * 2);
    out.extend_from_slice(CONTEXT);
    out.extend_from_slice(public_key);
    out.extend_from_slice(ephemeral);
    out
}

/// The X25519 public key for a secret, clamped as RFC 7748 (and `@noble/curves`) clamp it.
pub fn ephemeral_public(secret: &[u8; KEY_BYTES]) -> [u8; KEY_BYTES] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

pub fn write_hello(identity: &Identity, secret: &[u8; KEY_BYTES]) -> Hello {
    let public_key = identity.public_key();
    let ephemeral = ephemeral_public(secret);
    let signature = identity.sign(&signed_bytes(&public_key, &ephemeral));
    let mut frame = [0u8; HELLO_BYTES];
    frame[0] = HELLO;
    frame[1..1 + KEY_BYTES].copy_from_slice(&public_key);
    frame[1 + KEY_BYTES..1 + KEY_BYTES * 2].copy_from_slice(&ephemeral);
    frame[1 + KEY_BYTES * 2..].copy_from_slice(&signature);
    Hello {
        frame,
        peer_id: identity.peer_id().clone(),
        public_key,
        ephemeral,
    }
}

/// Never panics: a frame that is not a well-signed hello is simply not one.
pub fn read_hello(frame: &[u8]) -> Result<Hello, HandshakeFailed> {
    let not_a_hello = HandshakeFailed::NotAHello {
        length: frame.len(),
    };
    let frame: [u8; HELLO_BYTES] = frame.try_into().map_err(|_| not_a_hello.clone())?;
    if frame[0] != HELLO {
        return Err(not_a_hello);
    }
    let mut public_key = [0u8; KEY_BYTES];
    let mut ephemeral = [0u8; KEY_BYTES];
    public_key.copy_from_slice(&frame[1..1 + KEY_BYTES]);
    ephemeral.copy_from_slice(&frame[1 + KEY_BYTES..1 + KEY_BYTES * 2]);
    let signature = &frame[1 + KEY_BYTES * 2..];
    if !verify(
        &signed_bytes(&public_key, &ephemeral),
        signature,
        &public_key,
    ) {
        return Err(HandshakeFailed::BadSignature);
    }
    // 32 bytes always spell a well-formed peer id; the TypeScript's "no usable peer id" refusal
    // has no input that reaches it once the signature has verified
    let peer_id = PeerId::parse(&to_hex(&public_key)).map_err(|_| HandshakeFailed::BadSignature)?;
    Ok(Hello {
        frame,
        peer_id,
        public_key,
        ephemeral,
    })
}

/// The session keys, from our secret and the two hellos.
///
/// Both ends compute the same thing from facts both hold, so there is nothing to negotiate. The
/// transcript — the two hellos, lower peer id first — is the HKDF salt: a machine in the middle
/// that swapped either frame ends with a different key from at least one side. The directions
/// are separate keys chosen by peer id order, so both ends agree without asking.
pub fn session_keys(
    secret: &[u8; KEY_BYTES],
    ours: &Hello,
    theirs: &Hello,
) -> Result<SessionKeys, HandshakeFailed> {
    if ours.peer_id == theirs.peer_id {
        return Err(HandshakeFailed::Reflected);
    }
    let shared = StaticSecret::from(*secret).diffie_hellman(&PublicKey::from(theirs.ephemeral));
    // `@noble/curves` throws on an all-zero shared secret (a low-order point); so do we, as a value
    if !shared.was_contributory() {
        return Err(HandshakeFailed::UnusableEphemeral);
    }
    let first = ours.peer_id < theirs.peer_id;
    let (low, high) = if first {
        (&ours.frame, &theirs.frame)
    } else {
        (&theirs.frame, &ours.frame)
    };
    let mut transcript = Vec::with_capacity(HELLO_BYTES * 2);
    transcript.extend_from_slice(low);
    transcript.extend_from_slice(high);
    let mut okm = [0u8; KEY_BYTES * 2];
    Hkdf::<Sha256>::new(Some(&transcript), shared.as_bytes())
        .expand(INFO, &mut okm)
        .map_err(|_| HandshakeFailed::UnusableEphemeral)?;
    let mut lower = [0u8; KEY_BYTES];
    let mut upper = [0u8; KEY_BYTES];
    lower.copy_from_slice(&okm[..KEY_BYTES]);
    upper.copy_from_slice(&okm[KEY_BYTES..]);
    Ok(if first {
        SessionKeys {
            seal: lower,
            open: upper,
        }
    } else {
        SessionKeys {
            seal: upper,
            open: lower,
        }
    })
}

/// One frame under the session key. The nonce must be fresh per frame — 24 random bytes is wide
/// enough that counting them buys nothing — and is the caller's to draw.
/// Only a plaintext past the cipher's 256 GiB limit fails, which no frame on any link can be.
pub fn seal(
    key: &[u8; KEY_BYTES],
    plaintext: &[u8],
    nonce: &[u8; NONCE_BYTES],
) -> Result<Vec<u8>, HandshakeFailed> {
    let body = XChaCha20Poly1305::new(key.into())
        .encrypt(XNonce::from_slice(nonce), plaintext)
        .map_err(|_| HandshakeFailed::TooLarge)?;
    let mut frame = Vec::with_capacity(1 + NONCE_BYTES + body.len());
    frame.push(SEALED);
    frame.extend_from_slice(nonce);
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// Never panics: a frame that does not open under this key is one this link did not send.
pub fn unseal(key: &[u8; KEY_BYTES], frame: &[u8]) -> Result<Vec<u8>, HandshakeFailed> {
    if frame.len() < SEAL_OVERHEAD || frame[0] != SEALED {
        return Err(HandshakeFailed::NotSealed);
    }
    XChaCha20Poly1305::new(key.into())
        .decrypt(
            XNonce::from_slice(&frame[1..1 + NONCE_BYTES]),
            &frame[1 + NONCE_BYTES..],
        )
        .map_err(|_| HandshakeFailed::DidNotOpen)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reflected_hello_is_refused() {
        let a = Identity::from_seed(&[1; 32]);
        let hello = write_hello(&a, &[2; 32]);
        assert_eq!(
            session_keys(&[2; 32], &hello, &hello),
            Err(HandshakeFailed::Reflected)
        );
    }

    #[test]
    fn a_low_order_ephemeral_is_unusable() {
        let a = Identity::from_seed(&[1; 32]);
        let b = Identity::from_seed(&[3; 32]);
        let ours = write_hello(&a, &[2; 32]);
        let mut theirs = write_hello(&b, &[4; 32]);
        theirs.ephemeral = [0; 32]; // the identity point: every product is zero
        assert_eq!(
            session_keys(&[2; 32], &ours, &theirs),
            Err(HandshakeFailed::UnusableEphemeral)
        );
    }

    #[test]
    fn short_or_mistagged_frames_are_values() {
        assert_eq!(
            read_hello(&[]),
            Err(HandshakeFailed::NotAHello { length: 0 })
        );
        let mut hello = write_hello(&Identity::from_seed(&[1; 32]), &[2; 32]).frame;
        hello[0] = SEALED;
        assert!(matches!(
            read_hello(&hello),
            Err(HandshakeFailed::NotAHello { .. })
        ));
        assert_eq!(
            unseal(&[0; 32], &[SEALED; 40]),
            Err(HandshakeFailed::NotSealed)
        );
        assert_eq!(
            unseal(&[0; 32], &[HELLO; 41]),
            Err(HandshakeFailed::NotSealed)
        );
        assert_eq!(
            unseal(&[0; 32], &[SEALED; 41]),
            Err(HandshakeFailed::DidNotOpen)
        );
    }
}
