//! What the four signed cores share beyond the `[core, sig]` envelope: the verified value kept
//! beside the exact bytes it arrived in, and the small readers each decoder would otherwise repeat.
//!
//! A verified grant, receipt, link or checkpoint is held with its arrival bytes because a decoder
//! drops keys it has no name for (every core is additive), so a re-encode of what it read can be
//! shorter than what was signed. Anything that forwards one — a relay passing grants on — must
//! send `wire`, never an encode of `value`.

use crate::cbor::{MAX_SAFE_INTEGER, MalformedCbor, Value, encode};
use crate::envelope::{WireError, envelope, split_envelope};
use crate::event::{HEX_ID_EXPECTED, PeerId};
use crate::hex::to_hex;
use crate::identity::Identity;

/// A decoded core that passed its signature check, beside the bytes that check was made over.
#[derive(Debug, Clone, PartialEq)]
pub struct Signed<T> {
    pub value: T,
    /// The `[core, sig]` envelope exactly as received.
    pub wire: Vec<u8>,
    /// The core bytes the signature covers — not a re-encode of `value`.
    pub core: Vec<u8>,
    pub sig: Vec<u8>,
}

/// Why an envelope did not split, in the two shapes every core's error enum already has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SplitError {
    Cbor(MalformedCbor),
    Malformed(&'static str),
}

/// The shared split, reported so each module can fold it into its own closed error type, the way
/// the TypeScript maps `MalformedEnvelope` onto `MalformedGrant`, `MalformedLink` and the rest.
pub(crate) fn split(wire: &[u8]) -> Result<(Vec<u8>, Vec<u8>), SplitError> {
    split_envelope(wire).map_err(|e| match e {
        WireError::Cbor(c) => SplitError::Cbor(c),
        WireError::Envelope(m) | WireError::Event(m) => SplitError::Malformed(m),
        // splitting never judges a signature; kept total rather than unreachable
        WireError::BadSignature => SplitError::Malformed("expected [core, sig]"),
    })
}

/// Encodes a core map, signs the bytes and wraps both — `encodeCbor([core, identity.sign(core)])`.
pub(crate) fn sign_core(identity: &Identity, core: &Value) -> Vec<u8> {
    let bytes = encode(core);
    envelope(&bytes, &identity.sign(&bytes))
}

/// A peer id from the 32 raw key bytes a core carries it as; any other length is malformed.
pub(crate) fn peer_from_bytes(bytes: &[u8]) -> Result<PeerId, &'static str> {
    PeerId::parse(&to_hex(bytes)).map_err(|_| HEX_ID_EXPECTED)
}

/// `Number.isSafeInteger(v) && v >= 0` — what the TypeScript calls `isMs` / `isSafeNonNegative`.
pub(crate) fn safe_non_negative(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Int(n)) if (0..=MAX_SAFE_INTEGER).contains(n) => Some(*n),
        _ => None,
    }
}

/// The widest epoch-millisecond value `Temporal.Instant.fromEpochMilliseconds` accepts.
const MAX_INSTANT_MS: i64 = 8_640_000_000_000_000;

/// A `typeof v === "number"` timestamp that the TypeScript then hands to
/// `Temporal.Instant.fromEpochMilliseconds`. That call throws on a fraction or on anything past
/// ±8.64e15, so the TypeScript decoder would throw there; this one refuses the same inputs as a
/// value instead, and accepts every integer the TypeScript would have turned into an instant.
pub(crate) fn instant_ms(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Int(n)) if n.unsigned_abs() <= MAX_INSTANT_MS as u64 => Some(*n),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readers_refuse_what_the_typescript_would_not_hold() {
        assert_eq!(safe_non_negative(Some(&Value::Int(0))), Some(0));
        assert_eq!(safe_non_negative(Some(&Value::Int(-1))), None);
        assert_eq!(safe_non_negative(Some(&Value::Float(1.5))), None);
        assert_eq!(safe_non_negative(None), None);
        assert_eq!(instant_ms(Some(&Value::Int(-5))), Some(-5));
        assert_eq!(instant_ms(Some(&Value::Int(MAX_INSTANT_MS + 1))), None);
        assert_eq!(instant_ms(Some(&Value::Float(0.5))), None);
        assert!(peer_from_bytes(&[0; 31]).is_err());
        assert!(peer_from_bytes(&[0; 32]).is_ok());
        assert!(matches!(split(&[0x80]), Err(SplitError::Malformed(_))));
        assert!(matches!(split(&[0xff]), Err(SplitError::Cbor(_))));
    }
}
