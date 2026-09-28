//! Document columns on the wire (RFC-0023 §5): the `doc` change (tag 6), the lineage a `replace()`
//! starts, and the one rule that decides between two of them. Frozen by
//! `conformance/doc-vectors.json`, which the TypeScript generates and this reproduces.
//!
//! `data` map keys: `column`0 `adapter`1 `lineage`2 `bytes`3 `blob`4 `genesis`5. Exactly one of
//! `bytes` and `blob`; unknown keys are skipped and never re-emitted.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::cbor::{Key, MAX_SAFE_INTEGER, Value};
use crate::event::{PeerId, SeqNum};
use crate::hex::to_hex;
use crate::record::Cell;
use crate::strategy::{MergeSpec, StrategyName};

const DOC_COLUMN: i64 = 0;
const DOC_ADAPTER: i64 = 1;
const DOC_LINEAGE: i64 = 2;
const DOC_BYTES: i64 = 3;
const DOC_BLOB: i64 = 4;
const DOC_GENESIS: i64 = 5;

/// A lineage or an action: 16 bytes on the wire, 32 lowercase hex characters wherever it is text.
pub type Id16 = [u8; 16];

/// An update carried by D18 instead of inline: the SHA-256 of its bytes and its length.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocBlobRef {
    pub hash: [u8; 32],
    pub size: u64,
}

/// The update's bytes, inline or by reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocUpdate {
    Bytes(Vec<u8>),
    Blob(DocBlobRef),
}

impl DocUpdate {
    /// The update's length in bytes, whichever way it travels.
    pub fn size(&self) -> u64 {
        match self {
            DocUpdate::Bytes(b) => b.len() as u64,
            DocUpdate::Blob(r) => r.size,
        }
    }
}

/// One update to one document column. Order-free at the fold: its only effect on state is the
/// lineage cell a genesis sets; the update itself belongs to the doc log and is never read here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocChange {
    pub table: String,
    pub key: String,
    pub column: String,
    /// `name@major`, e.g. `loro@1`.
    pub adapter: String,
    /// `None` is the root lineage. A genesis always names the lineage it starts.
    pub lineage: Option<Id16>,
    pub update: DocUpdate,
    /// Only on a `replace()`: the update is the new lineage's whole snapshot.
    pub genesis: bool,
}

/// `^[a-z][a-z0-9-]*@[1-9][0-9]*$` — the adapter id's whole grammar, as the TypeScript's `parseAdapterId`.
pub fn is_adapter_id(s: &str) -> bool {
    let Some((name, major)) = s.split_once('@') else {
        return false;
    };
    let mut name_bytes = name.bytes();
    let name_ok = name_bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && name_bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let mut major_bytes = major.bytes();
    let major_ok = major_bytes
        .next()
        .is_some_and(|b| (b'1'..=b'9').contains(&b))
        && major_bytes.all(|b| b.is_ascii_digit());
    name_ok && major_ok
}

/// One doc change, named: the author's key, the sequence as a big-endian u64 and the change's
/// index in its event as a big-endian u32 — 44 fixed-width bytes.
pub fn doc_change_id(peer: &PeerId, seq: SeqNum, index: u32) -> [u8; 44] {
    let mut out = [0u8; 44];
    out[..32].copy_from_slice(&peer.key_bytes());
    out[32..40].copy_from_slice(&seq.get().to_be_bytes());
    out[40..].copy_from_slice(&index.to_be_bytes());
    out
}

/// `sha256("syncmesh/doc-lineage" ‖ doc_change_id)[..16]` — the lineage a genesis must name
/// (RFC-0023 §5.3). A receiver recomputes it and refuses a genesis that names anything else.
pub fn derive_lineage(peer: &PeerId, seq: SeqNum, index: u32) -> Id16 {
    let mut hasher = Sha256::new();
    hasher.update(b"syncmesh/doc-lineage");
    hasher.update(doc_change_id(peer, seq, index));
    let hash = hasher.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&hash[..16]);
    out
}

/// A 16-byte id from a CBOR value, or `None` for anything else — lenient where the reader must be.
pub fn id16(v: Option<&Value>) -> Option<Id16> {
    match v {
        Some(Value::Bytes(b)) => b.as_slice().try_into().ok(),
        _ => None,
    }
}

pub(crate) fn blob_to_cbor(blob: &DocBlobRef) -> Value {
    Value::Array(vec![
        Value::Bytes(blob.hash.to_vec()),
        Value::Int(blob.size as i64),
    ])
}

pub(crate) fn blob_from_cbor(v: Option<&Value>) -> Result<DocBlobRef, &'static str> {
    let Some(Value::Array(pair)) = v else {
        return Err("blob is not [hash, size]");
    };
    let [Value::Bytes(hash), size] = pair.as_slice() else {
        return Err("blob is not [hash, size]");
    };
    let hash: [u8; 32] = hash
        .as_slice()
        .try_into()
        .map_err(|_| "blob hash is not 32 bytes")?;
    match size {
        Value::Int(n) if (0..=MAX_SAFE_INTEGER).contains(n) => Ok(DocBlobRef {
            hash,
            size: *n as u64,
        }),
        _ => Err("blob size is not an integer"),
    }
}

/// A doc change's `data` map.
pub fn doc_data_to_cbor(change: &DocChange) -> Value {
    let mut data = vec![
        (Key::Int(DOC_COLUMN), Value::Text(change.column.clone())),
        (Key::Int(DOC_ADAPTER), Value::Text(change.adapter.clone())),
    ];
    if let Some(lineage) = change.lineage {
        data.push((Key::Int(DOC_LINEAGE), Value::Bytes(lineage.to_vec())));
    }
    data.push(match &change.update {
        DocUpdate::Bytes(b) => (Key::Int(DOC_BYTES), Value::Bytes(b.clone())),
        DocUpdate::Blob(r) => (Key::Int(DOC_BLOB), blob_to_cbor(r)),
    });
    if change.genesis {
        data.push((Key::Int(DOC_GENESIS), Value::Bool(true)));
    }
    Value::map(data)
}

/// A doc change from its `data` map. Refuses what no fold could take — no column, a malformed
/// adapter id, both or neither payload, a lineage that is not 16 bytes, a `genesis` that is not
/// `true` — and skips keys it has no name for. Never panics.
pub fn doc_from_cbor(
    table: String,
    key: String,
    v: Option<&Value>,
) -> Result<DocChange, &'static str> {
    let Some(Value::Map(m)) = v else {
        return Err("doc data is not a map");
    };
    let column = match m.get(&Key::Int(DOC_COLUMN)) {
        Some(Value::Text(c)) if !c.is_empty() => c.clone(),
        _ => return Err("doc column is not text"),
    };
    let adapter = match m.get(&Key::Int(DOC_ADAPTER)) {
        Some(Value::Text(a)) if is_adapter_id(a) => a.clone(),
        Some(Value::Text(_)) => return Err("doc adapter: expected `name@major`"),
        _ => return Err("doc adapter is not text"),
    };
    let update = match (m.get(&Key::Int(DOC_BYTES)), m.get(&Key::Int(DOC_BLOB))) {
        (Some(Value::Bytes(b)), None) => DocUpdate::Bytes(b.clone()),
        (Some(_), None) => return Err("doc bytes are not bytes"),
        (None, blob @ Some(_)) => DocUpdate::Blob(blob_from_cbor(blob)?),
        _ => return Err("a doc change carries exactly one of bytes and blob"),
    };
    let genesis = match m.get(&Key::Int(DOC_GENESIS)) {
        None => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return Err("genesis is only ever true"),
    };
    let lineage = match m.get(&Key::Int(DOC_LINEAGE)) {
        None => None,
        present => Some(id16(present).ok_or("doc lineage is not 16 bytes")?),
    };
    Ok(DocChange {
        table,
        key,
        column,
        adapter,
        lineage,
        update,
        genesis,
    })
}

/// How two geneses of one document resolve — **the one place the lineage rule lives** (RFC-0023
/// §5.3, open decision §16.1). Last-writer-wins today, as the TypeScript's `lineageRule`; the
/// alternative the owner is weighing is first-genesis-wins. Whatever it becomes it must stay a
/// lattice join, or peers folding the same geneses in different orders keep different documents.
pub fn lineage_rule(incoming: Cell, current: Option<Cell>) -> Cell {
    match current {
        Some(current) if incoming.stamp <= current.stamp => current,
        _ => incoming,
    }
}

/// table → column → adapter id: where a mesh declares its doc columns.
pub type DocColumns = BTreeMap<String, BTreeMap<String, String>>;

/// The merge spec with every doc column's cell under the lineage rule — what every join of a
/// record must be given, so a doc column is never joined by whatever row rule is the default.
pub fn with_doc_columns(merge: Option<&MergeSpec>, docs: &DocColumns) -> MergeSpec {
    let mut joined = merge.cloned().unwrap_or_default();
    for (table, columns) in docs {
        let rules = joined.entry(table.clone()).or_default();
        for column in columns.keys() {
            rules.insert(column.clone(), StrategyName::Lineage);
        }
    }
    joined
}

/// The lineage a record's doc column is on: the winning genesis's, or `None` for the root. A cell
/// holding anything but 32 lowercase hex characters reads as the root, on every peer alike.
pub fn lineage_of(record: Option<&crate::record::RowRecord>, column: &str) -> Option<Id16> {
    let crate::record::CellValue::Text(hex) = &record?.cells.get(column)?.value else {
        return None;
    };
    if hex.len() != 32
        || !hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    crate::hex::from_hex(hex).ok()?.try_into().ok()
}

/// The lineage cell's value: the id as the TypeScript holds it, 32 lowercase hex characters.
pub fn lineage_text(lineage: &Id16) -> String {
    to_hex(lineage)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_ids_name_their_major() {
        for good in ["loro@1", "automerge@3", "y-js@12"] {
            assert!(is_adapter_id(good), "{good}");
        }
        for bad in [
            "loro", "loro@0", "Loro@1", "loro@1.2", "@1", "loro@", "1oro@1",
        ] {
            assert!(!is_adapter_id(bad), "{bad}");
        }
    }

    #[test]
    fn the_change_id_is_fixed_width_big_endian() {
        let peer = PeerId::parse(&"ab".repeat(32)).unwrap();
        let id = doc_change_id(&peer, SeqNum::parse(0x0102).unwrap(), 0x0304);
        assert_eq!(to_hex(&id[32..]), "000000000000010200000304");
        assert_ne!(
            derive_lineage(&peer, SeqNum::parse(1).unwrap(), 0),
            derive_lineage(&peer, SeqNum::parse(1).unwrap(), 1)
        );
    }

    #[test]
    fn a_malformed_data_map_is_a_value_not_a_panic() {
        let base = || {
            vec![
                (Key::Int(DOC_COLUMN), Value::text("content")),
                (Key::Int(DOC_ADAPTER), Value::text("loro@1")),
                (Key::Int(DOC_BYTES), Value::Bytes(vec![1])),
            ]
        };
        let with = |extra: Vec<(Key, Value)>| {
            let mut m = base();
            m.extend(extra);
            doc_from_cbor("t".into(), "k".into(), Some(&Value::map(m)))
        };
        assert!(with(vec![]).is_ok());
        assert!(with(vec![(Key::Int(99), Value::text("newer"))]).is_ok());
        assert!(
            with(vec![(
                Key::Int(DOC_BLOB),
                blob_to_cbor(&DocBlobRef {
                    hash: [0; 32],
                    size: 1
                })
            )])
            .is_err()
        );
        assert!(with(vec![(Key::Int(DOC_LINEAGE), Value::Bytes(vec![0; 15]))]).is_err());
        assert!(with(vec![(Key::Int(DOC_GENESIS), Value::Bool(false))]).is_err());
        assert!(doc_from_cbor("t".into(), "k".into(), None).is_err());
    }
}
