//! A device: its Ed25519 keypair. The public key is the peer id; the seed never leaves the device.

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

use crate::event::PeerId;
use crate::hex::to_hex;

pub const SEED_LENGTH: usize = 32;

/// Clone is cheap and deliberate: a device holds one key and hands it to its engine, its link and
/// its presence tier, which is three owners of one secret, not three secrets.
#[derive(Clone)]
pub struct Identity {
    signing: SigningKey,
    peer_id: PeerId,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("peer_id", &self.peer_id)
            .finish_non_exhaustive()
    }
}

impl Identity {
    pub fn from_seed(seed: &[u8; SEED_LENGTH]) -> Identity {
        let signing = SigningKey::from_bytes(seed);
        let peer_id = PeerId::parse(&to_hex(signing.verifying_key().as_bytes()))
            .expect("a public key is 32 bytes, which is 64 hex characters");
        Identity { signing, peer_id }
    }

    pub fn peer_id(&self) -> &PeerId {
        &self.peer_id
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    pub fn sign(&self, bytes: &[u8]) -> [u8; 64] {
        self.signing.sign(bytes).to_bytes()
    }
}

/// Never panics: a malformed signature or key is simply not valid.
pub fn verify(bytes: &[u8], signature: &[u8], public_key: &[u8]) -> bool {
    let Ok(key) = <[u8; 32]>::try_from(public_key) else {
        return false;
    };
    let Ok(sig) = <[u8; 64]>::try_from(signature) else {
        return false;
    };
    let Ok(verifying) = VerifyingKey::from_bytes(&key) else {
        return false;
    };
    verifying
        .verify(bytes, &Signature::from_bytes(&sig))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signs_and_verifies_under_its_own_peer_id() {
        let id = Identity::from_seed(&[7u8; 32]);
        let sig = id.sign(b"hello");
        let key = crate::hex::from_hex(id.peer_id().as_str()).unwrap();
        assert!(verify(b"hello", &sig, &key));
        assert!(!verify(b"hellp", &sig, &key));
        assert!(!verify(b"hello", &sig[..63], &key));
    }
}
