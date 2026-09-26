//! A join proves the key it names (`relay/src/proof.ts`, D33).
//!
//! The peer id *is* an Ed25519 public key, so the room sends a fresh challenge as the first frame
//! on every socket and the join carries the key's signature over
//! `"syncmesh/relay/join/v2" ‖ nonce ‖ core`. Fresh per socket, so a captured proof opens nothing
//! later; over the body ([`crate::relay_frames::join_core`]), so a machine in the middle cannot
//! re-cursor the join it forwards; domain separated, so the signature cannot be lifted from a link
//! hello or an event, nor lifted out to stand in for one.
//!
//! The nonce is the caller's: this crate holds no random source, so each platform brings its own.

use crate::event::PeerId;
use crate::identity::{Identity, verify};

pub const NONCE_BYTES: usize = 32;

pub const CONTEXT: &[u8] = b"syncmesh/relay/join/v2";

fn signed_bytes(nonce: &[u8], core: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(CONTEXT.len() + nonce.len() + core.len());
    out.extend_from_slice(CONTEXT);
    out.extend_from_slice(nonce);
    out.extend_from_slice(core);
    out
}

/// The proof a device puts on its join: its own key over the room's challenge and the join's core.
pub fn prove_join(identity: &Identity, nonce: &[u8], core: &[u8]) -> [u8; 64] {
    identity.sign(&signed_bytes(nonce, core))
}

/// Never panics: a proof that does not verify against the key the join names is simply not one.
pub fn verify_join_proof(peer: &PeerId, nonce: &[u8], core: &[u8], proof: &[u8]) -> bool {
    verify(&signed_bytes(nonce, core), proof, &peer.key_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay_frames::join_core;

    #[test]
    fn a_proof_opens_its_own_socket_and_no_other() {
        let device = Identity::from_seed(&[5; 32]);
        let core = join_core(&[2], device.peer_id(), &[], None);
        let proof = prove_join(&device, &[1; NONCE_BYTES], &core);
        assert!(verify_join_proof(
            device.peer_id(),
            &[1; NONCE_BYTES],
            &core,
            &proof
        ));
        // replayed onto a socket that challenged with a different nonce
        assert!(!verify_join_proof(
            device.peer_id(),
            &[2; NONCE_BYTES],
            &core,
            &proof
        ));
        // re-cursored in flight
        let moved = join_core(
            &[2],
            device.peer_id(),
            &[(
                device.peer_id().clone(),
                crate::event::SeqNum::parse(1).unwrap(),
            )],
            None,
        );
        assert!(!verify_join_proof(
            device.peer_id(),
            &[1; NONCE_BYTES],
            &moved,
            &proof
        ));
        // named by someone else
        let other = Identity::from_seed(&[6; 32]);
        assert!(!verify_join_proof(
            other.peer_id(),
            &[1; NONCE_BYTES],
            &core,
            &proof
        ));
        // and a proof of the wrong length is not a panic
        assert!(!verify_join_proof(
            device.peer_id(),
            &[1; NONCE_BYTES],
            &core,
            &proof[..10]
        ));
    }
}
