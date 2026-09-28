//! A checkpoint certificate: what vouches for a snapshot (book ch. 4).
//!
//! A snapshot's rows arrive without per-event signatures, so a device that installs one holds
//! state it cannot prove by itself. The certificate is the authority's signature over *which*
//! state it is — a hash of the rows — and the coverage adopting it claims. A peer relays the
//! authority's certificate unchanged; it cannot re-sign rows it altered.
//!
//! Core map keys, frozen by `conformance/checkpoint-vectors.json`: `v`0 `partition`1 `stateHash`2
//! `coverage`3 `issuedAt`4 `issuer`5.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::cbor::{Key, MAX_SAFE_INTEGER, MalformedCbor, Value, cmp_utf16, decode};
use crate::event::{PartitionKey, PeerId};
use crate::hex::to_hex;
use crate::identity::{Identity, verify};
use crate::record::write_json_string;
use crate::signed::{Signed, SplitError, instant_ms, peer_from_bytes, sign_core, split};

const KEY_V: i64 = 0;
const KEY_PARTITION: i64 = 1;
const KEY_STATE_HASH: i64 = 2;
const KEY_COVERAGE: i64 = 3;
const KEY_ISSUED_AT: i64 = 4;
const KEY_ISSUER: i64 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointCertificate {
    /// The slice this checkpoint is for; `None` means the issuer's whole state.
    pub partition: Option<PartitionKey>,
    /// `checkpoint_hash` over the rows the checkpoint stands for. Held as the bytes that arrived,
    /// whatever their length, as the TypeScript holds them.
    pub state_hash: Vec<u8>,
    /// Per author, the highest sequence the state folds — the coverage adopting this claims.
    pub coverage: BTreeMap<PeerId, u64>,
    pub issued_at_ms: i64,
    pub issuer: PeerId,
}

impl CheckpointCertificate {
    pub const VERSION: i64 = 1;
}

/// One row as a checkpoint counts it: where it lives, and the record bytes the state store holds.
/// The bytes are hashed as they are, never decoded and re-encoded (see `record_codec`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointRow {
    pub table: String,
    pub key: String,
    pub record: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointError {
    Cbor(MalformedCbor),
    Malformed(&'static str),
    /// The signature does not cover the received core, or is not the issuer's.
    BadSignature,
    /// The rows do not hash to what the certificate says — a row was altered, dropped or added.
    Mismatch {
        expected: String,
        actual: String,
    },
}

impl std::fmt::Display for CheckpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CheckpointError::Cbor(e) => write!(f, "{e}"),
            CheckpointError::Malformed(m) => write!(f, "malformed checkpoint: {m}"),
            CheckpointError::BadSignature => {
                f.write_str("signature does not cover the received core, or is not the issuer's")
            }
            CheckpointError::Mismatch { expected, actual } => write!(
                f,
                "the rows do not hash to what this certificate vouches for: expected {expected}, got {actual}"
            ),
        }
    }
}

impl std::error::Error for CheckpointError {}

impl From<SplitError> for CheckpointError {
    fn from(e: SplitError) -> Self {
        match e {
            SplitError::Cbor(c) => CheckpointError::Cbor(c),
            SplitError::Malformed(m) => CheckpointError::Malformed(m),
        }
    }
}

fn malformed<T>(m: &'static str) -> Result<T, CheckpointError> {
    Err(CheckpointError::Malformed(m))
}

/// The state a certificate names: each row as the JSON triple `JSON.stringify([table, key,
/// hex(record)])`, the lines sorted as JavaScript sorts strings (UTF-16 code units), joined by
/// `\n`, then SHA-256. Sorted because two senders may page the same state in different orders;
/// JSON rather than a delimiter because tables and keys are app-chosen strings.
pub fn checkpoint_hash(rows: &[CheckpointRow]) -> [u8; 32] {
    let mut lines: Vec<String> = rows
        .iter()
        .map(|row| {
            let mut line = String::from("[");
            write_json_string(&mut line, &row.table);
            line.push(',');
            write_json_string(&mut line, &row.key);
            line.push(',');
            write_json_string(&mut line, &to_hex(&row.record));
            line.push(']');
            line
        })
        .collect();
    lines.sort_by(|a, b| cmp_utf16(a, b));
    Sha256::digest(lines.join("\n").as_bytes()).into()
}

fn core_value(certificate: &CheckpointCertificate) -> Value {
    let mut core = vec![
        (Key::Int(KEY_V), Value::Int(CheckpointCertificate::VERSION)),
        (
            Key::Int(KEY_STATE_HASH),
            Value::Bytes(certificate.state_hash.clone()),
        ),
        // keyed by the peer's own hex: CBOR map keys are text or integers, and a cursor map has
        // exactly this shape everywhere else in the system
        (
            Key::Int(KEY_COVERAGE),
            Value::Map(
                certificate
                    .coverage
                    .iter()
                    .map(|(peer, seq)| {
                        (Key::Text(peer.as_str().to_owned()), Value::Int(*seq as i64))
                    })
                    .collect(),
            ),
        ),
        (
            Key::Int(KEY_ISSUED_AT),
            Value::Int(certificate.issued_at_ms),
        ),
        (
            Key::Int(KEY_ISSUER),
            Value::Bytes(certificate.issuer.key_bytes().to_vec()),
        ),
    ];
    if let Some(p) = &certificate.partition {
        core.push((Key::Int(KEY_PARTITION), Value::Text(p.as_str().to_owned())));
    }
    Value::map(core)
}

/// The core bytes a certificate signature covers.
pub fn encode_checkpoint(certificate: &CheckpointCertificate) -> Vec<u8> {
    crate::cbor::encode(&core_value(certificate))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointRequest {
    pub partition: Option<PartitionKey>,
    pub state_hash: Vec<u8>,
    pub coverage: BTreeMap<PeerId, u64>,
    pub now_ms: i64,
}

/// Mints a signed certificate as wire bytes `[core, sig]`; the issuer is the signing identity.
pub fn issue_checkpoint(issuer: &Identity, request: &CheckpointRequest) -> Vec<u8> {
    let certificate = CheckpointCertificate {
        partition: request.partition.clone(),
        state_hash: request.state_hash.clone(),
        coverage: request.coverage.clone(),
        issued_at_ms: request.now_ms,
        issuer: issuer.peer_id().clone(),
    };
    sign_core(issuer, &core_value(&certificate))
}

/// Verifies the received core bytes under the `issuer` the caller was shipped with, decodes, then
/// — when rows are offered — checks they hash to the certified state. Never panics.
///
/// As in the TypeScript, the signature is judged under the caller's `issuer`, and the `issuer`
/// field inside the core is decoded but not compared with it: a core naming someone else but
/// signed by the expected authority still verifies.
pub fn verify_checkpoint(
    wire: &[u8],
    issuer: &PeerId,
    rows: Option<&[CheckpointRow]>,
) -> Result<Signed<CheckpointCertificate>, CheckpointError> {
    let (core, sig) = split(wire)?;
    if !verify(&core, &sig, &issuer.key_bytes()) {
        return Err(CheckpointError::BadSignature);
    }
    let certificate = decode_checkpoint_core(&core)?;
    if let Some(rows) = rows {
        let actual = to_hex(&checkpoint_hash(rows));
        let expected = to_hex(&certificate.state_hash);
        if actual != expected {
            return Err(CheckpointError::Mismatch { expected, actual });
        }
    }
    Ok(Signed {
        value: certificate,
        wire: wire.to_vec(),
        core,
        sig,
    })
}

/// Decodes a certificate core without judging its signature. Like the TypeScript it checks no
/// version and ignores keys it has no name for.
///
/// Stricter than the TypeScript in two places, both where it accepts any `typeof "number"`: a
/// coverage sequence must be a non-negative safe integer (it is a count of events), and `issuedAt`
/// must be an integer `Temporal` can hold (the TypeScript would throw inside
/// `Instant.fromEpochMilliseconds` on anything else).
pub fn decode_checkpoint_core(core: &[u8]) -> Result<CheckpointCertificate, CheckpointError> {
    let Value::Map(m) = decode(core).map_err(CheckpointError::Cbor)? else {
        return malformed("checkpoint core is not a map");
    };
    let get = |k: i64| m.get(&Key::Int(k));
    let Some(Value::Bytes(state_hash)) = get(KEY_STATE_HASH) else {
        return malformed("stateHash is not bytes");
    };
    let Some(Value::Bytes(issuer)) = get(KEY_ISSUER) else {
        return malformed("issuer is not a peer id");
    };
    let Some(issued_at_ms) = instant_ms(get(KEY_ISSUED_AT)) else {
        return malformed("issuedAt is not a timestamp");
    };
    let Some(Value::Map(entries)) = get(KEY_COVERAGE) else {
        return malformed("coverage is not a map");
    };
    let mut coverage = BTreeMap::new();
    for (peer, seq) in entries {
        let (Key::Text(peer), Value::Int(seq)) = (peer, seq) else {
            return malformed("coverage names a peer or a sequence it cannot read");
        };
        if !(0..=MAX_SAFE_INTEGER).contains(seq) {
            return malformed("coverage names a peer or a sequence it cannot read");
        }
        let peer = PeerId::parse(peer).map_err(|e| CheckpointError::Malformed(e.message))?;
        coverage.insert(peer, *seq as u64);
    }
    let issuer = peer_from_bytes(issuer).map_err(CheckpointError::Malformed)?;
    let partition = match get(KEY_PARTITION) {
        None => None,
        Some(Value::Text(p)) => {
            Some(PartitionKey::parse(p).map_err(|e| CheckpointError::Malformed(e.message))?)
        }
        Some(_) => return malformed("partition is not a key"),
    };
    Ok(CheckpointCertificate {
        partition,
        state_hash: state_hash.clone(),
        coverage,
        issued_at_ms,
        issuer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cbor::encode;
    use crate::envelope::envelope;

    fn authority() -> Identity {
        Identity::from_seed(&[1; 32])
    }

    fn rows() -> Vec<CheckpointRow> {
        let row = |table: &str, key: &str, record: &[u8]| CheckpointRow {
            table: table.into(),
            key: key.into(),
            record: record.to_vec(),
        };
        vec![
            row("notes", "n2", &[0xa1, 0x00, 0x01]),
            row("notes", "n1", &[0xa1, 0x00, 0x02]),
            row("tags", "t1", &[0xa0]),
        ]
    }

    fn mint() -> Vec<u8> {
        let mut coverage = BTreeMap::new();
        coverage.insert(Identity::from_seed(&[2; 32]).peer_id().clone(), 42);
        issue_checkpoint(
            &authority(),
            &CheckpointRequest {
                partition: None,
                state_hash: checkpoint_hash(&rows()).to_vec(),
                coverage,
                now_ms: 1_700_000_000_000,
            },
        )
    }

    #[test]
    fn verifies_and_carries_its_coverage_in_any_page_order() {
        let got = verify_checkpoint(&mint(), authority().peer_id(), Some(&rows())).unwrap();
        assert_eq!(
            got.value.coverage.values().copied().collect::<Vec<_>>(),
            [42]
        );
        let mut reversed = rows();
        reversed.reverse();
        assert_eq!(checkpoint_hash(&reversed), checkpoint_hash(&rows()));
        assert_eq!(encode_checkpoint(&got.value), got.core);
    }

    #[test]
    fn an_altered_or_dropped_row_is_a_mismatch() {
        let mut altered = rows();
        altered[0].record = vec![0xa0];
        assert!(matches!(
            verify_checkpoint(&mint(), authority().peer_id(), Some(&altered)),
            Err(CheckpointError::Mismatch { .. })
        ));
        assert!(matches!(
            verify_checkpoint(&mint(), authority().peer_id(), Some(&rows()[1..])),
            Err(CheckpointError::Mismatch { .. })
        ));
    }

    #[test]
    fn a_peer_cannot_mint_one_and_garbage_is_a_value() {
        let other = PeerId::parse(&"a".repeat(64)).unwrap();
        assert_eq!(
            verify_checkpoint(&mint(), &other, None),
            Err(CheckpointError::BadSignature)
        );
        assert!(verify_checkpoint(&[1, 2, 3], authority().peer_id(), None).is_err());
    }

    #[test]
    fn a_well_signed_core_with_the_wrong_shape_is_malformed() {
        let key = authority().public_key().to_vec();
        let with = |k: i64, v: Value| {
            let mut m = vec![
                (Key::Int(2), Value::Bytes(vec![0; 32])),
                (Key::Int(3), Value::map([])),
                (Key::Int(4), Value::Int(0)),
                (Key::Int(5), Value::Bytes(key.clone())),
            ];
            m.push((Key::Int(k), v));
            let bytes = encode(&Value::map(m));
            envelope(&bytes, &authority().sign(&bytes))
        };
        let peer_text = "a".repeat(64);
        let cases = [
            (2, Value::text("h"), "stateHash is not bytes"),
            (5, Value::text("p"), "issuer is not a peer id"),
            (4, Value::Float(0.5), "issuedAt is not a timestamp"),
            (3, Value::Array(vec![]), "coverage is not a map"),
            (
                3,
                Value::map([(Key::Int(1), Value::Int(1))]),
                "coverage names a peer or a sequence it cannot read",
            ),
            (
                3,
                Value::map([(Key::Text(peer_text.clone()), Value::Int(-1))]),
                "coverage names a peer or a sequence it cannot read",
            ),
            (
                3,
                Value::map([(Key::from("nope"), Value::Int(1))]),
                crate::event::HEX_ID_EXPECTED,
            ),
            (5, Value::Bytes(vec![0; 31]), crate::event::HEX_ID_EXPECTED),
            (1, Value::Int(1), "partition is not a key"),
            (1, Value::text("acme"), "expected kind:id"),
        ];
        for (k, v, says) in cases {
            assert_eq!(
                verify_checkpoint(&with(k, v), authority().peer_id(), None),
                Err(CheckpointError::Malformed(says)),
                "{says}"
            );
        }
        // no version check, like the TypeScript
        assert!(verify_checkpoint(&with(0, Value::Int(9)), authority().peer_id(), None).is_ok());
    }
}
