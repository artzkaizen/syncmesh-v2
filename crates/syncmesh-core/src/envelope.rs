//! The `[core, sig]` envelope: the one shape every signed thing on this wire starts from.

use crate::cbor::{MalformedCbor, Value, decode, encode};
use crate::event::SyncEvent;
use crate::event_codec::{EventDecodeError, decode_event_core, encode_event_core};
use crate::identity::{Identity, verify};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    Cbor(MalformedCbor),
    Envelope(&'static str),
    Event(&'static str),
    BadSignature,
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::Cbor(e) => write!(f, "{e}"),
            WireError::Envelope(m) => write!(f, "malformed envelope: {m}"),
            WireError::Event(m) => write!(f, "malformed event: {m}"),
            WireError::BadSignature => f.write_str("signature does not cover the received core"),
        }
    }
}

impl std::error::Error for WireError {}

impl From<EventDecodeError> for WireError {
    fn from(e: EventDecodeError) -> Self {
        match e {
            EventDecodeError::Cbor(c) => WireError::Cbor(c),
            EventDecodeError::Malformed(m) => WireError::Event(m),
        }
    }
}

/// Split but unjudged: a caller that decides anything from the core must go on to verify.
pub fn split_envelope(wire: &[u8]) -> Result<(Vec<u8>, Vec<u8>), WireError> {
    let outer = decode(wire).map_err(WireError::Cbor)?;
    let Value::Array(items) = outer else {
        return Err(WireError::Envelope("expected [core, sig]"));
    };
    let [Value::Bytes(core), Value::Bytes(sig)] = items.as_slice() else {
        return Err(WireError::Envelope(if items.len() == 2 {
            "core and sig must be byte strings"
        } else {
            "expected [core, sig]"
        }));
    };
    Ok((core.clone(), sig.clone()))
}

pub fn envelope(core: &[u8], sig: &[u8]) -> Vec<u8> {
    encode(&Value::Array(vec![
        Value::Bytes(core.to_vec()),
        Value::Bytes(sig.to_vec()),
    ]))
}

/// An event beside the exact core bytes its signature covers and the envelope they came in.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedEvent {
    pub event: SyncEvent,
    pub wire: Vec<u8>,
    pub core: Vec<u8>,
    pub sig: Vec<u8>,
}

pub fn sign_event(event: SyncEvent, identity: &Identity) -> VerifiedEvent {
    let core = encode_event_core(&event);
    let sig = identity.sign(&core).to_vec();
    let wire = envelope(&core, &sig);
    VerifiedEvent {
        event,
        wire,
        core,
        sig,
    }
}

/// `[core, sig]` → the event, only if the signature covers the received core bytes. Never panics.
pub fn decode_and_verify(wire: &[u8]) -> Result<VerifiedEvent, WireError> {
    let (core, sig) = split_envelope(wire)?;
    let event = decode_event_core(&core)?;
    if !verify(&core, &sig, &event.peer_id.key_bytes()) {
        return Err(WireError::BadSignature);
    }
    Ok(VerifiedEvent {
        event,
        wire: wire.to_vec(),
        core,
        sig,
    })
}

/// A held event as `[core, sig]` to forward: the held core goes out verbatim, never a re-encode,
/// because the decoder drops keys it has no name for and the author's signature would then cover
/// bytes nobody sent. `None` when no signature was ever held — nobody but the author can sign.
pub fn relay_envelope(
    event: &SyncEvent,
    core: Option<&[u8]>,
    sig: Option<&[u8]>,
) -> Option<Vec<u8>> {
    let sig = sig?;
    Some(match core {
        Some(core) => envelope(core, sig),
        None => envelope(&encode_event_core(event), sig),
    })
}
