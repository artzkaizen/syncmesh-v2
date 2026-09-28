//! A custody receipt: this peer holds these events, on disk, as of this storage incarnation
//! (book ch. 10, D28).
//!
//! Core map keys, frozen by `conformance/receipt-vectors.json`: `v`0 `holder`1 `author`2
//! `throughSeq`3 `incarnation`4 `issuedAt`5. The core names its own verifier: a receipt is checked
//! under the holder it names, so nobody can pass off another peer's receipt as their own or their
//! own under another's name. Delivery, never approval — holding an event is not accepting it.

use crate::cbor::{Key, MalformedCbor, Value, decode};
use crate::event::{PeerId, SeqNum};
use crate::identity::{Identity, verify};
use crate::signed::{Signed, SplitError, instant_ms, peer_from_bytes, sign_core, split};

const KEY_V: i64 = 0;
const KEY_HOLDER: i64 = 1;
const KEY_AUTHOR: i64 = 2;
const KEY_THROUGH_SEQ: i64 = 3;
const KEY_INCARNATION: i64 = 4;
const KEY_ISSUED_AT: i64 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustodyReceipt {
    /// The peer vouching that it holds these events.
    pub holder: PeerId,
    /// Whose events; a receipt covers one author's contiguous run.
    pub author: PeerId,
    /// Everything of `author` up to and including this sequence is held.
    pub through_seq: SeqNum,
    /// The holder's storage lineage: a device that lost its database announces a fresh one, so an
    /// author can tell "still holding" from "holding again, having lost what it had".
    pub incarnation: String,
    pub issued_at_ms: i64,
}

impl CustodyReceipt {
    pub const VERSION: i64 = 1;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptError {
    Cbor(MalformedCbor),
    Malformed(&'static str),
    /// The signature does not cover the received core, or is not the holder's.
    BadSignature,
}

impl std::fmt::Display for ReceiptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReceiptError::Cbor(e) => write!(f, "{e}"),
            ReceiptError::Malformed(m) => write!(f, "malformed receipt: {m}"),
            ReceiptError::BadSignature => {
                f.write_str("signature does not cover the received core, or is not the holder's")
            }
        }
    }
}

impl std::error::Error for ReceiptError {}

impl From<SplitError> for ReceiptError {
    fn from(e: SplitError) -> Self {
        match e {
            SplitError::Cbor(c) => ReceiptError::Cbor(c),
            SplitError::Malformed(m) => ReceiptError::Malformed(m),
        }
    }
}

fn malformed<T>(m: &'static str) -> Result<T, ReceiptError> {
    Err(ReceiptError::Malformed(m))
}

fn core_value(receipt: &CustodyReceipt) -> Value {
    Value::map([
        (Key::Int(KEY_V), Value::Int(CustodyReceipt::VERSION)),
        (
            Key::Int(KEY_HOLDER),
            Value::Bytes(receipt.holder.key_bytes().to_vec()),
        ),
        (
            Key::Int(KEY_AUTHOR),
            Value::Bytes(receipt.author.key_bytes().to_vec()),
        ),
        (
            Key::Int(KEY_THROUGH_SEQ),
            Value::Int(receipt.through_seq.get() as i64),
        ),
        (
            Key::Int(KEY_INCARNATION),
            Value::Text(receipt.incarnation.clone()),
        ),
        (Key::Int(KEY_ISSUED_AT), Value::Int(receipt.issued_at_ms)),
    ])
}

/// The core bytes a receipt signature covers.
pub fn encode_receipt(receipt: &CustodyReceipt) -> Vec<u8> {
    crate::cbor::encode(&core_value(receipt))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptRequest {
    pub author: PeerId,
    pub through_seq: SeqNum,
    pub incarnation: String,
    pub now_ms: i64,
}

/// Signs one as wire bytes `[core, sig]`; the holder is the signing identity, never a parameter.
pub fn issue_receipt(holder: &Identity, request: &ReceiptRequest) -> Vec<u8> {
    let receipt = CustodyReceipt {
        holder: holder.peer_id().clone(),
        author: request.author.clone(),
        through_seq: request.through_seq,
        incarnation: request.incarnation.clone(),
        issued_at_ms: request.now_ms,
    };
    sign_core(holder, &core_value(&receipt))
}

/// Decodes, then verifies the received core bytes under the holder the core names. Never panics.
pub fn verify_receipt(wire: &[u8]) -> Result<Signed<CustodyReceipt>, ReceiptError> {
    let (core, sig) = split(wire)?;
    let receipt = decode_receipt_core(&core)?;
    if !verify(&core, &sig, &receipt.holder.key_bytes()) {
        return Err(ReceiptError::BadSignature);
    }
    Ok(Signed {
        value: receipt,
        wire: wire.to_vec(),
        core,
        sig,
    })
}

/// Decodes a receipt core without judging its signature. Like the TypeScript it checks no version
/// and ignores keys it has no name for.
///
/// Two places are stricter than the TypeScript, which accepts any `typeof "number"`: `throughSeq`
/// must be a positive safe integer (the TypeScript casts whatever arrives to a `SeqNum`; every
/// issuer writes one), and `issuedAt` must be an integer `Temporal` can hold (the TypeScript would
/// throw inside `Instant.fromEpochMilliseconds` on anything else).
pub fn decode_receipt_core(core: &[u8]) -> Result<CustodyReceipt, ReceiptError> {
    let Value::Map(m) = decode(core).map_err(ReceiptError::Cbor)? else {
        return malformed("receipt core is not a map");
    };
    let get = |k: i64| m.get(&Key::Int(k));
    let (Some(Value::Bytes(holder)), Some(Value::Bytes(author))) =
        (get(KEY_HOLDER), get(KEY_AUTHOR))
    else {
        return malformed("receipt names a peer it cannot read");
    };
    let Some(through_seq) = (match get(KEY_THROUGH_SEQ) {
        Some(Value::Int(n)) if *n > 0 => SeqNum::parse(*n as u64),
        _ => None,
    }) else {
        return malformed("throughSeq is not a sequence");
    };
    let Some(Value::Text(incarnation)) = get(KEY_INCARNATION) else {
        return malformed("incarnation is not text");
    };
    let Some(issued_at_ms) = instant_ms(get(KEY_ISSUED_AT)) else {
        return malformed("issuedAt is not a timestamp");
    };
    Ok(CustodyReceipt {
        holder: peer_from_bytes(holder).map_err(ReceiptError::Malformed)?,
        author: peer_from_bytes(author).map_err(ReceiptError::Malformed)?,
        through_seq,
        incarnation: incarnation.clone(),
        issued_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cbor::encode;
    use crate::envelope::envelope;

    fn holder() -> Identity {
        Identity::from_seed(&[3; 32])
    }

    fn request() -> ReceiptRequest {
        ReceiptRequest {
            author: Identity::from_seed(&[4; 32]).peer_id().clone(),
            through_seq: SeqNum::parse(7).unwrap(),
            incarnation: "store-1".into(),
            now_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn round_trips_and_verifies_under_the_named_holder() {
        let wire = issue_receipt(&holder(), &request());
        let got = verify_receipt(&wire).unwrap();
        assert_eq!(&got.value.holder, holder().peer_id());
        assert_eq!(got.value.through_seq.get(), 7);
        assert_eq!(encode_receipt(&got.value), got.core);
    }

    #[test]
    fn someone_elses_signature_or_name_is_refused() {
        let wire = issue_receipt(&holder(), &request());
        let got = verify_receipt(&wire).unwrap();
        let impostor = Identity::from_seed(&[5; 32]);
        // the holder's core, the impostor's signature
        let forged = envelope(&got.core, &impostor.sign(&got.core));
        assert_eq!(verify_receipt(&forged), Err(ReceiptError::BadSignature));
        // the impostor's name, the holder's signature
        let renamed = encode_receipt(&CustodyReceipt {
            holder: impostor.peer_id().clone(),
            ..got.value.clone()
        });
        let misnamed = envelope(&renamed, &holder().sign(&renamed));
        assert_eq!(verify_receipt(&misnamed), Err(ReceiptError::BadSignature));
    }

    #[test]
    fn damage_is_a_value() {
        let key = holder().public_key().to_vec();
        let base = |k: i64, v: Value| {
            let mut m = vec![
                (Key::Int(1), Value::Bytes(key.clone())),
                (Key::Int(2), Value::Bytes(key.clone())),
                (Key::Int(3), Value::Int(1)),
                (Key::Int(4), Value::text("s")),
                (Key::Int(5), Value::Int(0)),
            ];
            m.push((Key::Int(k), v));
            let bytes = encode(&Value::map(m));
            envelope(&bytes, &holder().sign(&bytes))
        };
        let cases = [
            (1, Value::text("x"), "receipt names a peer it cannot read"),
            (3, Value::Int(0), "throughSeq is not a sequence"),
            (3, Value::Float(1.5), "throughSeq is not a sequence"),
            (4, Value::Int(4), "incarnation is not text"),
            (5, Value::Float(0.5), "issuedAt is not a timestamp"),
            (2, Value::Bytes(vec![1; 31]), crate::event::HEX_ID_EXPECTED),
        ];
        for (k, v, says) in cases {
            assert_eq!(
                verify_receipt(&base(k, v)),
                Err(ReceiptError::Malformed(says))
            );
        }
        // no version check, like the TypeScript: key 0 absent still verifies
        assert!(verify_receipt(&base(9, Value::Null)).is_ok());
        assert!(verify_receipt(&[0x01, 0x02]).is_err());
        assert!(matches!(
            verify_receipt(&[0x82, 0x41, 0x01, 0x40]),
            Err(ReceiptError::Cbor(_) | ReceiptError::Malformed(_))
        ));
    }
}
