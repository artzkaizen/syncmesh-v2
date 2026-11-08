//! Document columns on the wire (RFC-0023 §5): the `doc` change (tag 6), the lineage a `replace()`
//! starts, and the one rule that decides between two of them. Frozen by
//! `conformance/doc-vectors.json`, which the TypeScript generates and this reproduces.
//!
//! `data` map keys: `column`0 `adapter`1 `lineage`2 `bytes`3 `blob`4 `genesis`5 `parent`6. Exactly
//! one of `bytes` and `blob`; unknown keys are skipped and never re-emitted.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::cbor::{Key, MAX_SAFE_INTEGER, Value};
use crate::event::{PeerId, SeqNum};
use crate::hex::to_hex;
use crate::hlc::Hlc;
use crate::record::{Cell, CellValue, JsonValue, RowRecord};
use crate::stamp::Stamp;
use crate::strategy::{MergeSpec, StrategyName};

const DOC_COLUMN: i64 = 0;
const DOC_ADAPTER: i64 = 1;
const DOC_LINEAGE: i64 = 2;
const DOC_BYTES: i64 = 3;
const DOC_BLOB: i64 = 4;
const DOC_GENESIS: i64 = 5;
const DOC_PARENT: i64 = 6;

/// The version of the lineage rule, `1` for the first-genesis tree (RFC-0023 §16.1), as the
/// TypeScript's `GENESIS_RULE`. A genesis carries it in key 5 — the last-writer-wins rule before it
/// wrote `true`, which this build decodes as [`DocChange::legacy`] and refuses at admission — and a
/// lineage cell carries it as its tag wherever the cell is kept outside events (snapshot pages,
/// repair records, persisted state), so a build meets another rule's cell as a version it does
/// not run ([`LineageCellRefused`]), never as the root.
pub const GENESIS_RULE: i64 = 1;

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
    /// Only on a genesis written under the lineage rule before RFC-0023 §16.1 — key 5 `true` rather
    /// than [`GENESIS_RULE`]. Decoded so a log that holds one still reads; refused at admission, and
    /// never folded.
    pub legacy: bool,
    /// Only on a genesis: the lineage it replaces, the one that won where it was written. `None`
    /// is the root. What [`winning_lineage`] walks.
    pub parent: Option<Id16>,
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
        data.push((
            Key::Int(DOC_GENESIS),
            if change.legacy {
                Value::Bool(true)
            } else {
                Value::Int(GENESIS_RULE)
            },
        ));
    }
    if let Some(parent) = change.parent {
        data.push((Key::Int(DOC_PARENT), Value::Bytes(parent.to_vec())));
    }
    Value::map(data)
}

/// A doc change from its `data` map. Refuses what no fold could take — no column, a malformed
/// adapter id, both or neither payload, a lineage or parent that is not 16 bytes, a `genesis` that
/// is neither [`GENESIS_RULE`] nor the `true` of the rule before it, a parent on anything but a
/// genesis — and skips keys it has no name for. A `true` genesis decodes as `legacy`, so a stored
/// log that holds one still reads; admission is what refuses it. Never panics.
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
    let (genesis, legacy) = match m.get(&Key::Int(DOC_GENESIS)) {
        None => (false, false),
        Some(Value::Bool(true)) => (true, true),
        Some(Value::Int(GENESIS_RULE)) => (true, false),
        Some(_) => return Err("genesis is 1, the lineage rule's version"),
    };
    let lineage = match m.get(&Key::Int(DOC_LINEAGE)) {
        None => None,
        present => Some(id16(present).ok_or("doc lineage is not 16 bytes")?),
    };
    let parent = match m.get(&Key::Int(DOC_PARENT)) {
        None => None,
        present => Some(id16(present).ok_or("doc parent is not 16 bytes")?),
    };
    if parent.is_some() && !genesis {
        return Err("only a genesis names the lineage it replaces");
    }
    Ok(DocChange {
        table,
        key,
        column,
        adapter,
        lineage,
        update,
        genesis,
        legacy,
        parent,
    })
}

/// One `replace()` as the lineage cell keeps it: the lineage it started, the lineage it replaced
/// (`None`, the root) and the genesis's stamp.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Genesis {
    pub lineage: Id16,
    pub parent: Option<Id16>,
    pub stamp: Stamp,
}

impl Genesis {
    /// Which of two goes first: the smaller stamp, then the smaller lineage, then the root parent.
    fn first(&self, other: &Genesis) -> std::cmp::Ordering {
        self.stamp
            .cmp(&other.stamp)
            .then_with(|| self.lineage.cmp(&other.lineage))
            .then_with(|| self.parent.cmp(&other.parent))
    }

    /// The cell entry: `[parent | null, ms, logical, peer]`, keyed by the lineage.
    fn entry(&self) -> JsonValue {
        JsonValue::Array(vec![
            self.parent
                .map_or(JsonValue::Null, |p| JsonValue::Text(lineage_text(&p))),
            JsonValue::Number(self.stamp.hlc.ms as f64),
            JsonValue::Number(f64::from(self.stamp.hlc.logical)),
            JsonValue::Text(self.stamp.peer.as_str().to_owned()),
        ])
    }
}

/// 32 lowercase hex characters as a 16-byte id, or `None`.
fn id16_text(hex: &str) -> Option<Id16> {
    if hex.len() != 32
        || !hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    crate::hex::from_hex(hex).ok()?.try_into().ok()
}

/// A count the TypeScript reads back as a safe integer in `0..=max`.
fn count(v: &JsonValue, max: f64) -> Option<f64> {
    match v {
        JsonValue::Number(n) if n.fract() == 0.0 && (0.0..=max).contains(n) => Some(*n),
        _ => None,
    }
}

fn genesis_of(lineage: &str, entry: &JsonValue) -> Option<Genesis> {
    let lineage = id16_text(lineage)?;
    let JsonValue::Array(fields) = entry else {
        return None;
    };
    let [parent, ms, logical, peer] = fields.as_slice() else {
        return None;
    };
    let parent = match parent {
        JsonValue::Null => None,
        JsonValue::Text(hex) => Some(id16_text(hex)?),
        _ => return None,
    };
    let JsonValue::Text(peer) = peer else {
        return None;
    };
    let ms = count(ms, MAX_SAFE_INTEGER as f64)?;
    let logical = count(logical, f64::from(u32::MAX))?;
    Some(Genesis {
        lineage,
        parent,
        stamp: Stamp::new(
            Hlc::new(ms as i64, logical as u32),
            PeerId::parse(peer).ok()?,
        ),
    })
}

/// The version a lineage cell is tagged with: the head of `[version, geneses]`, or `None` for a
/// cell with no tag — one written before cells were versioned, the lineage id the last-writer-wins
/// rule kept, or a value that is no cell at all.
fn cell_version(value: &CellValue) -> Option<i64> {
    let CellValue::Array(items) = value else {
        return None;
    };
    count(items.first()?, MAX_SAFE_INTEGER as f64).map(|n| n as i64)
}

/// The geneses half of a cell tagged [`GENESIS_RULE`], or `None` for any other value.
fn rule_geneses(value: &CellValue) -> Option<&BTreeMap<String, JsonValue>> {
    match value {
        CellValue::Array(items)
            if items.len() == 2 && cell_version(value) == Some(GENESIS_RULE) =>
        {
            match &items[1] {
                JsonValue::Object(held) => Some(held),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Every genesis a lineage cell holds, by lineage id, as the TypeScript's `cellGeneses`. Within a
/// cell of this rule's version an entry not in the rule's shape is skipped entry by entry, on every
/// peer alike; a cell of another version holds nothing this rule reads, and
/// [`parse_lineage_cells`] refuses it where it enters.
pub fn geneses_of(value: Option<&CellValue>) -> Vec<Genesis> {
    let Some(held) = value.and_then(rule_geneses) else {
        return Vec::new();
    };
    held.iter()
        .filter_map(|(lineage, entry)| genesis_of(lineage, entry))
        .collect()
}

/// A lineage cell that arrived outside an event — a snapshot page, a repair record, persisted state
/// — tagged with a version of the lineage rule this build does not run (RFC-0023 §16.1), as the
/// TypeScript's `LineageCellRefused`. `version` is `None` for a cell with no tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineageCellRefused {
    pub table: String,
    pub key: String,
    pub column: String,
    pub version: Option<i64>,
}

impl std::fmt::Display for LineageCellRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let found = match self.version {
            None => "a lineage cell with no version".to_owned(),
            Some(GENESIS_RULE) => {
                format!("a lineage cell tagged {GENESIS_RULE} in a shape that version never writes")
            }
            Some(v) => format!("a lineage cell of version {v}"),
        };
        write!(
            f,
            "{}/{}.{}: {found}; this build runs version {GENESIS_RULE}",
            self.table, self.key, self.column
        )
    }
}

impl std::error::Error for LineageCellRefused {}

/// Checks every declared doc column's cell in `rows` against the lineage rule this build runs, as
/// the TypeScript's `parseLineageCells`: the first cell not tagged [`GENESIS_RULE`] is refused, so
/// a caller joins none of the rows rather than read it as the root or merge it by another rule. A
/// column absent from a record is the root and passes.
pub fn parse_lineage_cells<'a>(
    rows: impl IntoIterator<Item = (&'a str, &'a str, &'a RowRecord)>,
    docs: &DocColumns,
) -> Result<(), LineageCellRefused> {
    for (table, key, record) in rows {
        let Some(columns) = docs.get(table) else {
            continue;
        };
        for column in columns.keys() {
            let Some(cell) = record.cells.get(column) else {
                continue;
            };
            if rule_geneses(&cell.value).is_none() {
                return Err(LineageCellRefused {
                    table: table.to_owned(),
                    key: key.to_owned(),
                    column: column.clone(),
                    version: cell_version(&cell.value),
                });
            }
        }
    }
    Ok(())
}

/// The lineage a set of geneses settles on — **the one place the lineage rule lives** (RFC-0023
/// §5.3, decided in §16.1 on 2026-11-08: first genesis wins), as the TypeScript's
/// `winningLineage`. Among the geneses that replaced one lineage the smallest stamp wins; the walk
/// starts at the root and follows each winner's winning child until nothing replaced it. A function
/// of the set alone, so every arrival order and batching lands on one lineage.
pub fn winning_lineage(geneses: &[Genesis]) -> Option<Id16> {
    let mut children: BTreeMap<Option<Id16>, &Genesis> = BTreeMap::new();
    for genesis in geneses {
        match children.get(&genesis.parent) {
            Some(best) if genesis.first(best) != std::cmp::Ordering::Less => {}
            _ => {
                children.insert(genesis.parent, genesis);
            }
        }
    }
    let mut walked = std::collections::BTreeSet::new();
    let mut at = None;
    while let Some(next) = children.get(&at) {
        // one parent per genesis keeps the walk a path, but a peer can still name a cycle
        if !walked.insert(next.lineage) {
            break;
        }
        at = Some(next.lineage);
    }
    at
}

/// How two lineage cells join: the union of their geneses by lineage id, the first by stamp kept
/// where one lineage appears twice; the cell's stamp is the later of the two. A lattice join, as
/// the TypeScript's `lineageRule`.
pub fn lineage_rule(incoming: Cell, current: Option<Cell>) -> Cell {
    let mut held: BTreeMap<Id16, Genesis> = geneses_of(current.as_ref().map(|c| &c.value))
        .into_iter()
        .map(|g| (g.lineage, g))
        .collect();
    for genesis in geneses_of(Some(&incoming.value)) {
        match held.get(&genesis.lineage) {
            Some(kept) if genesis.first(kept) != std::cmp::Ordering::Less => {}
            _ => {
                held.insert(genesis.lineage, genesis);
            }
        }
    }
    let stamp = match current {
        Some(c) if incoming.stamp <= c.stamp => c.stamp,
        _ => incoming.stamp,
    };
    let geneses = held
        .values()
        .map(|g| (lineage_text(&g.lineage), g.entry()))
        .collect();
    Cell {
        value: tagged(geneses),
        stamp,
    }
}

/// A cell's value: `[GENESIS_RULE, { lineage → [parent | null, ms, logical, peer] }]`.
fn tagged(geneses: BTreeMap<String, JsonValue>) -> CellValue {
    CellValue::Array(vec![
        JsonValue::Number(GENESIS_RULE as f64),
        JsonValue::Object(geneses),
    ])
}

/// The lineage cell a genesis writes: the one genesis, stamped with it.
pub fn lineage_cell(genesis: &Genesis) -> Cell {
    Cell {
        value: tagged(BTreeMap::from([(
            lineage_text(&genesis.lineage),
            genesis.entry(),
        )])),
        stamp: genesis.stamp.clone(),
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

/// The lineage a record's doc column is on: the winner of the geneses its cell holds (see
/// [`winning_lineage`]), or `None` for the root.
pub fn lineage_of(record: Option<&RowRecord>, column: &str) -> Option<Id16> {
    winning_lineage(&geneses_of(record?.cells.get(column).map(|c| &c.value)))
}

/// A lineage id as the TypeScript holds it, 32 lowercase hex characters.
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
    fn a_cell_of_another_rules_version_is_refused_never_read_as_the_root() {
        let docs = DocColumns::from([(
            "notes".to_owned(),
            BTreeMap::from([("content".to_owned(), "loro@1".to_owned())]),
        )]);
        let peer = PeerId::parse(&"ab".repeat(32)).unwrap();
        let held = lineage_cell(&Genesis {
            lineage: [0xa1; 16],
            parent: None,
            stamp: Stamp::new(Hlc::new(1, 0), peer),
        });
        let CellValue::Array(tagged) = &held.value else {
            panic!("a lineage cell is tagged with its rule's version");
        };
        let geneses = CellValue::from(tagged[1].clone());
        let version_two = CellValue::Array(vec![JsonValue::Number(2.0), tagged[1].clone()]);
        let with = |value: CellValue| RowRecord {
            cells: BTreeMap::from([(
                "content".to_owned(),
                Cell {
                    value,
                    stamp: held.stamp.clone(),
                },
            )]),
            ..RowRecord::default()
        };
        let verdict = |value: CellValue| {
            let record = with(value);
            parse_lineage_cells([("notes", "n1", &record)], &docs).map_err(|e| e.version)
        };
        assert_eq!(verdict(held.value.clone()), Ok(()));
        assert_eq!(geneses_of(Some(&held.value)).len(), 1);
        for (value, version) in [
            (geneses, None),
            (CellValue::text(&lineage_text(&[0xa1; 16])), None),
            (version_two, Some(2)),
        ] {
            assert!(geneses_of(Some(&value)).is_empty());
            assert_eq!(verdict(value), Err(version));
        }
        let record = with(CellValue::Null);
        assert!(parse_lineage_cells([("other", "n1", &record)], &docs).is_ok());
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
        assert!(
            with(vec![(Key::Int(DOC_GENESIS), Value::Bool(true))])
                .is_ok_and(|d| d.genesis && d.legacy)
        );
        assert!(with(vec![(Key::Int(DOC_GENESIS), Value::Int(2))]).is_err());
        assert!(with(vec![(Key::Int(DOC_GENESIS), Value::Int(1))]).is_ok_and(|d| d.genesis));
        assert!(with(vec![(Key::Int(DOC_PARENT), Value::Bytes(vec![0; 16]))]).is_err());
        assert!(
            with(vec![
                (Key::Int(DOC_GENESIS), Value::Int(1)),
                (Key::Int(DOC_PARENT), Value::Bytes(vec![0; 15]))
            ])
            .is_err()
        );
        assert!(
            with(vec![
                (Key::Int(DOC_GENESIS), Value::Int(1)),
                (Key::Int(DOC_PARENT), Value::Bytes(vec![7; 16]))
            ])
            .is_ok_and(|d| d.parent == Some([7; 16]))
        );
        assert!(doc_from_cbor("t".into(), "k".into(), None).is_err());
    }
}
