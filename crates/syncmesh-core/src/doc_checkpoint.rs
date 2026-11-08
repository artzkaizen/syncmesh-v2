//! `DocCheckpoint` (RFC-0023 §5.5): the signed snapshot record a joiner below a compaction floor,
//! or an opaque authority, installs in place of a document's history. Not `checkpoint.rs`'s
//! certificate, which vouches for a whole state; this one vouches for one document's snapshot.
//!
//! Core keys: `table`0 `key`1 `column`2 `adapter`3 `lineage`4 `covers`5 `version`6 `snapshot`7
//! `derived`8 `at`9. `covers` travels as `[[peer bstr(32), seq], …]` ascending by peer — the
//! canonical CBOR keys a map by integer or text only — and a decoder refuses any other order.

use std::collections::BTreeMap;

use crate::cbor::{Key, MalformedCbor, Value, decode, encode};
use crate::doc::{DocBlobRef, Id16, blob_from_cbor, blob_to_cbor, id16, is_adapter_id};
use crate::envelope::envelope;
use crate::event::{PeerId, SeqNum};
use crate::hlc::Hlc;
use crate::identity::{Identity, verify};
use crate::record::Row;
use crate::row_codec::{row_from_cbor, row_to_cbor};
use crate::signed::{SplitError, peer_from_bytes, safe_non_negative, split};

const TABLE: i64 = 0;
const KEY: i64 = 1;
const COLUMN: i64 = 2;
const ADAPTER: i64 = 3;
const LINEAGE: i64 = 4;
const COVERS: i64 = 5;
const VERSION: i64 = 6;
const SNAPSHOT: i64 = 7;
const DERIVED: i64 = 8;
const AT: i64 = 9;

#[derive(Debug, Clone, PartialEq)]
pub struct DocCheckpoint {
    pub table: String,
    pub key: String,
    pub column: String,
    pub adapter: String,
    /// `None` is the root lineage.
    pub lineage: Option<Id16>,
    /// Every doc change of this document at or below these is folded into the snapshot.
    pub covers: BTreeMap<PeerId, SeqNum>,
    /// The adapter's own encoding of the snapshot's version.
    pub version: Vec<u8>,
    /// The snapshot bytes, by reference (D18) — never inline.
    pub snapshot: DocBlobRef,
    /// The derived columns' values at this version, for hosts that cannot compute them.
    pub derived: Row,
    pub at: Hlc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocCheckpointError {
    Cbor(MalformedCbor),
    Malformed(&'static str),
    /// The producer's signature does not cover the received core.
    BadSignature,
}

impl std::fmt::Display for DocCheckpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocCheckpointError::Cbor(e) => write!(f, "{e}"),
            DocCheckpointError::Malformed(m) => write!(f, "malformed doc checkpoint: {m}"),
            DocCheckpointError::BadSignature => {
                f.write_str("the producer's signature does not cover the core")
            }
        }
    }
}

impl std::error::Error for DocCheckpointError {}

/// The checkpoint core, the bytes a producer signs.
pub fn encode_doc_checkpoint_core(cp: &DocCheckpoint) -> Vec<u8> {
    // a peer id's hex order is its bytes' order, which is the order `covers` is frozen in
    let covers = cp
        .covers
        .iter()
        .map(|(peer, seq)| {
            Value::Array(vec![
                Value::Bytes(peer.key_bytes().to_vec()),
                Value::Int(seq.get() as i64),
            ])
        })
        .collect();
    let mut core = vec![
        (Key::Int(TABLE), Value::Text(cp.table.clone())),
        (Key::Int(KEY), Value::Text(cp.key.clone())),
        (Key::Int(COLUMN), Value::Text(cp.column.clone())),
        (Key::Int(ADAPTER), Value::Text(cp.adapter.clone())),
        (Key::Int(COVERS), Value::Array(covers)),
        (Key::Int(VERSION), Value::Bytes(cp.version.clone())),
        (Key::Int(SNAPSHOT), blob_to_cbor(&cp.snapshot)),
        (Key::Int(DERIVED), row_to_cbor(&cp.derived)),
        (
            Key::Int(AT),
            Value::Array(vec![Value::Int(cp.at.ms), Value::Int(cp.at.logical as i64)]),
        ),
    ];
    if let Some(lineage) = cp.lineage {
        core.push((Key::Int(LINEAGE), Value::Bytes(lineage.to_vec())));
    }
    encode(&Value::map(core))
}

fn covers_from_cbor(v: Option<&Value>) -> Result<BTreeMap<PeerId, SeqNum>, &'static str> {
    let Some(Value::Array(pairs)) = v else {
        return Err("covers is not an array");
    };
    let mut covers = BTreeMap::new();
    let mut previous: Option<PeerId> = None;
    for pair in pairs {
        let Value::Array(pair) = pair else {
            return Err("a cover is not a pair");
        };
        let [Value::Bytes(peer), seq] = pair.as_slice() else {
            return Err("a cover is not a [peer, seq] pair");
        };
        let peer = peer_from_bytes(peer)?;
        // one order, no repeats: the same covers must be the same bytes
        if previous.as_ref().is_some_and(|p| *p >= peer) {
            return Err("covers are not in ascending peer order");
        }
        let seq = safe_non_negative(Some(seq))
            .and_then(|n| SeqNum::parse(n as u64))
            .ok_or("a cover's seq is not a positive integer")?;
        previous = Some(peer.clone());
        covers.insert(peer, seq);
    }
    Ok(covers)
}

/// Decodes a checkpoint core; ignores unknown keys. Never panics.
pub fn decode_doc_checkpoint_core(core: &[u8]) -> Result<DocCheckpoint, DocCheckpointError> {
    let malformed = DocCheckpointError::Malformed;
    let Value::Map(m) = decode(core).map_err(DocCheckpointError::Cbor)? else {
        return Err(malformed("checkpoint core is not a map"));
    };
    let text = |k: i64| match m.get(&Key::Int(k)) {
        Some(Value::Text(s)) => Ok(s.clone()),
        _ => Err(malformed("table, key and column are text")),
    };
    let (table, key, column) = (text(TABLE)?, text(KEY)?, text(COLUMN)?);
    let adapter = match m.get(&Key::Int(ADAPTER)) {
        Some(Value::Text(a)) if is_adapter_id(a) => a.clone(),
        _ => return Err(malformed("adapter is not `name@major`")),
    };
    let lineage = match m.get(&Key::Int(LINEAGE)) {
        None => None,
        present => Some(id16(present).ok_or(malformed("lineage is not 16 bytes"))?),
    };
    let Some(Value::Bytes(version)) = m.get(&Key::Int(VERSION)) else {
        return Err(malformed("version is not bytes"));
    };
    let Some(Value::Array(at)) = m.get(&Key::Int(AT)) else {
        return Err(malformed("at is not a pair"));
    };
    let (2, Some(ms), Some(logical)) = (
        at.len(),
        safe_non_negative(at.first()),
        safe_non_negative(at.get(1)),
    ) else {
        return Err(malformed("at is not two integers"));
    };
    let logical = u32::try_from(logical).map_err(|_| malformed("logical counter too large"))?;
    Ok(DocCheckpoint {
        table,
        key,
        column,
        adapter,
        lineage,
        covers: covers_from_cbor(m.get(&Key::Int(COVERS))).map_err(malformed)?,
        version: version.clone(),
        snapshot: blob_from_cbor(m.get(&Key::Int(SNAPSHOT))).map_err(malformed)?,
        derived: row_from_cbor(m.get(&Key::Int(DERIVED))).map_err(|e| malformed(e.message))?,
        at: Hlc::new(ms, logical),
    })
}

/// The `[core, sig]` envelope of a checkpoint signed by `producer`.
pub fn sign_doc_checkpoint(cp: &DocCheckpoint, producer: &Identity) -> Vec<u8> {
    let core = encode_doc_checkpoint_core(cp);
    envelope(&core, &producer.sign(&core))
}

/// `[core, sig]` → the checkpoint, only if `producer`'s signature covers the received core. The
/// core does not name its producer, so the caller says whose signature it expects.
pub fn decode_doc_checkpoint(
    wire: &[u8],
    producer: &PeerId,
) -> Result<DocCheckpoint, DocCheckpointError> {
    let (core, sig) = split(wire).map_err(|e| match e {
        SplitError::Cbor(c) => DocCheckpointError::Cbor(c),
        SplitError::Malformed(m) => DocCheckpointError::Malformed(m),
    })?;
    let checkpoint = decode_doc_checkpoint_core(&core)?;
    if !verify(&core, &sig, &producer.key_bytes()) {
        return Err(DocCheckpointError::BadSignature);
    }
    Ok(checkpoint)
}
