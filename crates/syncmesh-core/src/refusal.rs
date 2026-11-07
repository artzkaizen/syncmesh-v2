//! A refusal receipt: this peer has the author's `(peer, seq)`, will not fold it, and names the
//! bucket and the verdict's tag (D32) — the refusing twin of a [`crate::receipt::CustodyReceipt`].
//!
//! Core map keys, frozen by `conformance/refusal-vectors.json`: `v`0 `refuser`1 `author`2 `seq`3
//! `reason`4 `verdict`5 `issuedAt`6. Verified under the refuser the core names, like a receipt.
//! Information, never a veto; no free text — the verdict is a tag, and a sentence is malformed.

use crate::cbor::{Key, Value, decode};
use crate::event::{PeerId, SeqNum};
use crate::identity::{Identity, verify};
use crate::receipt::ReceiptError;
use crate::signed::{Signed, instant_ms, peer_from_bytes, safe_non_negative, sign_core, split};

const KEY_V: i64 = 0;
const KEY_REFUSER: i64 = 1;
const KEY_AUTHOR: i64 = 2;
const KEY_SEQ: i64 = 3;
const KEY_REASON: i64 = 4;
const KEY_VERDICT: i64 = 5;
const KEY_ISSUED_AT: i64 = 6;

/// Why a build could not take an event, in the three buckets a later build can act on (D13).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuarantineReason {
    /// The refuser is on an older build: a table it has no definition for.
    UnknownTable,
    /// The refuser is on an older build: a change kind it cannot apply.
    UnknownKind,
    /// The ladder said no.
    Refused,
}

impl QuarantineReason {
    pub fn as_str(self) -> &'static str {
        match self {
            QuarantineReason::UnknownTable => "unknown-table",
            QuarantineReason::UnknownKind => "unknown-kind",
            QuarantineReason::Refused => "refused",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "unknown-table" => Some(QuarantineReason::UnknownTable),
            "unknown-kind" => Some(QuarantineReason::UnknownKind),
            "refused" => Some(QuarantineReason::Refused),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusalReceipt {
    /// Who parked the event; the signature is checked against this key.
    pub refuser: PeerId,
    pub author: PeerId,
    /// One event, not a run.
    pub seq: SeqNum,
    pub reason: QuarantineReason,
    /// The `ValidationError` tag — `GrantStale`, `PolicyDenied`, … — never prose.
    pub verdict: String,
    pub issued_at_ms: i64,
}

impl RefusalReceipt {
    pub const VERSION: i64 = 1;
}

/// `^[A-Z][A-Za-z0-9]{0,63}$` — the TypeScript's `VERDICT_TAG`.
pub fn is_verdict_tag(s: &str) -> bool {
    let bytes = s.as_bytes();
    matches!(bytes.first(), Some(b'A'..=b'Z'))
        && bytes.len() <= 64
        && bytes.iter().all(|b| b.is_ascii_alphanumeric())
}

fn core_value(refusal: &RefusalReceipt) -> Value {
    Value::map([
        (Key::Int(KEY_V), Value::Int(RefusalReceipt::VERSION)),
        (
            Key::Int(KEY_REFUSER),
            Value::Bytes(refusal.refuser.key_bytes().to_vec()),
        ),
        (
            Key::Int(KEY_AUTHOR),
            Value::Bytes(refusal.author.key_bytes().to_vec()),
        ),
        (Key::Int(KEY_SEQ), Value::Int(refusal.seq.get() as i64)),
        (Key::Int(KEY_REASON), Value::text(refusal.reason.as_str())),
        (Key::Int(KEY_VERDICT), Value::Text(refusal.verdict.clone())),
        (Key::Int(KEY_ISSUED_AT), Value::Int(refusal.issued_at_ms)),
    ])
}

/// The core bytes a refusal signature covers.
pub fn encode_refusal(refusal: &RefusalReceipt) -> Vec<u8> {
    crate::cbor::encode(&core_value(refusal))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusalRequest {
    pub author: PeerId,
    pub seq: SeqNum,
    pub reason: QuarantineReason,
    pub verdict: String,
    pub now_ms: i64,
}

/// Signs one as wire bytes `[core, sig]`; the refuser is the signing identity, never a parameter.
///
/// # Panics
/// If `verdict` is not a tag — a sentence here is a definition mistake, as in the TypeScript.
pub fn issue_refusal(refuser: &Identity, request: &RefusalRequest) -> Vec<u8> {
    assert!(
        is_verdict_tag(&request.verdict),
        "a refusal verdict is a tag, not {:?}",
        request.verdict
    );
    let refusal = RefusalReceipt {
        refuser: refuser.peer_id().clone(),
        author: request.author.clone(),
        seq: request.seq,
        reason: request.reason,
        verdict: request.verdict.clone(),
        issued_at_ms: request.now_ms,
    };
    sign_core(refuser, &core_value(&refusal))
}

/// Decodes, then verifies the received core bytes under the refuser the core names. Never panics.
pub fn verify_refusal(wire: &[u8]) -> Result<Signed<RefusalReceipt>, ReceiptError> {
    let (core, sig) = split(wire)?;
    let refusal = decode_refusal_core(&core)?;
    if !verify(&core, &sig, &refusal.refuser.key_bytes()) {
        return Err(ReceiptError::BadSignature);
    }
    Ok(Signed {
        value: refusal,
        wire: wire.to_vec(),
        core,
        sig,
    })
}

fn malformed<T>(m: &'static str) -> Result<T, ReceiptError> {
    Err(ReceiptError::Malformed(m))
}

/// Decodes a refusal core without judging its signature; checks no version and ignores keys it
/// has no name for, like the TypeScript.
pub fn decode_refusal_core(core: &[u8]) -> Result<RefusalReceipt, ReceiptError> {
    let Value::Map(m) = decode(core).map_err(ReceiptError::Cbor)? else {
        return malformed("refusal core is not a map");
    };
    let get = |k: i64| m.get(&Key::Int(k));
    let (Some(Value::Bytes(refuser)), Some(Value::Bytes(author))) =
        (get(KEY_REFUSER), get(KEY_AUTHOR))
    else {
        return malformed("refusal names a peer it cannot read");
    };
    let Some(n) = safe_non_negative(get(KEY_SEQ)) else {
        return malformed("seq is not a sequence");
    };
    let Some(reason) = (match get(KEY_REASON) {
        Some(Value::Text(s)) => QuarantineReason::parse(s),
        _ => None,
    }) else {
        return malformed("reason is not a quarantine reason");
    };
    let Some(verdict) = (match get(KEY_VERDICT) {
        Some(Value::Text(s)) if is_verdict_tag(s) => Some(s.clone()),
        _ => None,
    }) else {
        return malformed("verdict is not a tag");
    };
    let Some(issued_at_ms) = instant_ms(get(KEY_ISSUED_AT)) else {
        return malformed("issuedAt is not a timestamp");
    };
    let refuser = peer_from_bytes(refuser).map_err(ReceiptError::Malformed)?;
    let author = peer_from_bytes(author).map_err(ReceiptError::Malformed)?;
    let Some(seq) = SeqNum::parse(n as u64) else {
        return malformed("seq is not a sequence");
    };
    Ok(RefusalReceipt {
        refuser,
        author,
        seq,
        reason,
        verdict,
        issued_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::envelope;

    fn refuser() -> Identity {
        Identity::from_seed(&[3; 32])
    }

    fn request() -> RefusalRequest {
        RefusalRequest {
            author: Identity::from_seed(&[4; 32]).peer_id().clone(),
            seq: SeqNum::parse(7).unwrap(),
            reason: QuarantineReason::Refused,
            verdict: "GrantStale".into(),
            now_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn round_trips_and_verifies_under_the_named_refuser() {
        let wire = issue_refusal(&refuser(), &request());
        let got = verify_refusal(&wire).unwrap();
        assert_eq!(&got.value.refuser, refuser().peer_id());
        assert_eq!(got.value.seq.get(), 7);
        assert_eq!(got.value.verdict, "GrantStale");
        assert_eq!(encode_refusal(&got.value), got.core);
    }

    #[test]
    fn someone_elses_signature_or_name_is_refused() {
        let got = verify_refusal(&issue_refusal(&refuser(), &request())).unwrap();
        let impostor = Identity::from_seed(&[5; 32]);
        let forged = envelope(&got.core, &impostor.sign(&got.core));
        assert_eq!(verify_refusal(&forged), Err(ReceiptError::BadSignature));
        let renamed = encode_refusal(&RefusalReceipt {
            refuser: impostor.peer_id().clone(),
            ..got.value.clone()
        });
        let misnamed = envelope(&renamed, &refuser().sign(&renamed));
        assert_eq!(verify_refusal(&misnamed), Err(ReceiptError::BadSignature));
    }

    #[test]
    fn prose_and_unknown_reasons_are_malformed() {
        let got = verify_refusal(&issue_refusal(&refuser(), &request())).unwrap();
        let prose = encode_refusal(&RefusalReceipt {
            verdict: "click here".into(),
            ..got.value.clone()
        });
        let signed = envelope(&prose, &refuser().sign(&prose));
        assert_eq!(
            verify_refusal(&signed),
            Err(ReceiptError::Malformed("verdict is not a tag"))
        );
        assert!(!is_verdict_tag("grantStale"));
        assert!(!is_verdict_tag(""));
        assert!(!is_verdict_tag(&format!("A{}", "b".repeat(64))));
        assert!(is_verdict_tag(&format!("A{}", "b".repeat(63))));
        assert!(verify_refusal(&[0x01, 0x02]).is_err());
    }

    #[test]
    #[should_panic(expected = "a refusal verdict is a tag")]
    fn issuing_prose_panics() {
        issue_refusal(
            &refuser(),
            &RefusalRequest {
                verdict: "your grant expired".into(),
                ..request()
            },
        );
    }
}
