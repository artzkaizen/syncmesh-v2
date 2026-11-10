//! A page of snapshot rows (`wire/src/snapshot-codec.ts`, RFC-0019): what one `snap-chunk`
//! carries. `[1, peers, tables, partitions, rows]`, or with the checkpoints of the rows' documents
//! (RFC-0023 §5.5, E30 P5) `[2, peers, tables, partitions, rows, checkpoints, complete]`, where a
//! checkpoint is `[producerIndex, envelope, snapshot]` and its producer joins the peers dictionary
//! after every peer the rows name. A row is
//! `[tableIndex, key, writeStamp, deleteStamp, partitionIndex, cells]`, a cell is
//! `[columnIndex, value]` when it sits at the row's write stamp and `[columnIndex, value, stamp]`
//! when it does not, and a stamp is `[ms, logical, peerIndex]`.
//!
//! Peers, tables, each table's columns and partitions are dictionaries, indexed in the order they
//! are first seen. A row's cells go out in column order, as the TypeScript writes them since gaps
//! U34, so a holder in either runtime serves one row as the same bytes. Either decodes a page whose
//! cells arrive in any order (a holder built before U34), and a checkpoint hashes the decoded record
//! in column order whatever order it arrived in.

use std::collections::BTreeMap;

use crate::cbor::{Value, decode, encode};
use crate::event::{PartitionKey, PeerId};
use crate::hlc::Hlc;
use crate::record::{Cell, RowRecord};
use crate::row_codec::{cell_from_cbor, cell_to_cbor};
use crate::signed::{peer_from_bytes, safe_non_negative};
use crate::stamp::Stamp;

/// A page of rows alone.
const ROWS_VERSION: i64 = 1;
/// A page of rows and the checkpoints that stand for their documents.
const DOCS_VERSION: i64 = 2;

/// A document's checkpoint as a page carries it (RFC-0023 §5.5): the signed `DocCheckpoint`
/// envelope, whose producer signed it, and the snapshot bytes its key 7 names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageCheckpoint {
    pub producer: PeerId,
    pub checkpoint: Vec<u8>,
    pub snapshot: Vec<u8>,
}

/// The checkpoints one page carries. `complete` is the sender's word that every document of the
/// page's rows it holds anything of has one here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageDocs {
    pub checkpoints: Vec<PageCheckpoint>,
    pub complete: bool,
}

/// One page: its rows, and its documents when the sender put them in (version 2).
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotPage {
    pub rows: Vec<SnapshotRow>,
    pub docs: Option<PageDocs>,
}

/// One addressed row of a snapshot, the kernel's `KeyedRecord`.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotRow {
    pub table: String,
    pub key: String,
    pub record: RowRecord,
}

impl SnapshotRow {
    pub fn new(table: impl Into<String>, key: impl Into<String>, record: RowRecord) -> SnapshotRow {
        SnapshotRow {
            table: table.into(),
            key: key.into(),
            record,
        }
    }

    /// The record as `encode_record` writes it, cells in column order: what a checkpoint
    /// certificate hashes, as the TypeScript's `encodeRecord` writes the same record.
    pub fn record_bytes(&self) -> Vec<u8> {
        crate::record_codec::encode_record(&self.record)
    }
}

/// The page is not one this build can read, and the first reason why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MalformedSnapshot {
    pub message: String,
}

impl std::fmt::Display for MalformedSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "malformed snapshot: {}", self.message)
    }
}

impl std::error::Error for MalformedSnapshot {}

fn malformed<T>(message: impl Into<String>) -> Result<T, MalformedSnapshot> {
    Err(MalformedSnapshot {
        message: message.into(),
    })
}

/// Assigns each distinct value an index the first time it is seen.
struct Dictionary<T: Ord + Clone> {
    indexes: BTreeMap<T, usize>,
    values: Vec<T>,
}

impl<T: Ord + Clone> Dictionary<T> {
    fn new() -> Dictionary<T> {
        Dictionary {
            indexes: BTreeMap::new(),
            values: Vec::new(),
        }
    }

    fn of(&mut self, value: &T) -> usize {
        if let Some(&held) = self.indexes.get(value) {
            return held;
        }
        self.indexes.insert(value.clone(), self.values.len());
        self.values.push(value.clone());
        self.values.len() - 1
    }
}

fn index(i: usize) -> Value {
    Value::Int(i as i64)
}

fn stamp_out(stamp: &Stamp, peers: &mut Dictionary<PeerId>) -> Value {
    Value::Array(vec![
        Value::Int(stamp.hlc.ms),
        Value::Int(i64::from(stamp.hlc.logical)),
        index(peers.of(&stamp.peer)),
    ])
}

/// One page of rows, in the order given. Never fails: every row this crate holds encodes.
pub fn encode_snapshot_rows(rows: &[SnapshotRow]) -> Vec<u8> {
    encode_snapshot_page(rows, None)
}

/// [`encode_snapshot_rows`], and with `docs` version 2. Never fails.
pub fn encode_snapshot_page(rows: &[SnapshotRow], docs: Option<&PageDocs>) -> Vec<u8> {
    let mut peers: Dictionary<PeerId> = Dictionary::new();
    let mut tables: Dictionary<String> = Dictionary::new();
    let mut partitions: Dictionary<String> = Dictionary::new();
    let mut columns: Vec<Dictionary<String>> = Vec::new();
    let mut encoded = Vec::with_capacity(rows.len());
    for row in rows {
        let table_index = tables.of(&row.table);
        if columns.len() <= table_index {
            columns.push(Dictionary::new());
        }
        let record = &row.record;
        let mut cells = Vec::with_capacity(record.cells.len());
        for (column, cell) in &record.cells {
            let name = index(columns[table_index].of(column));
            // the row's write stamp covers the ordinary case: only a cell some later write moved
            // carries a stamp of its own
            if record.write_stamp.as_ref() == Some(&cell.stamp) {
                cells.push(Value::Array(vec![name, cell_to_cbor(&cell.value)]));
            } else {
                let stamp = stamp_out(&cell.stamp, &mut peers);
                cells.push(Value::Array(vec![name, cell_to_cbor(&cell.value), stamp]));
            }
        }
        let write = record
            .write_stamp
            .as_ref()
            .map_or(Value::Null, |s| stamp_out(s, &mut peers));
        let delete = record
            .delete_stamp
            .as_ref()
            .map_or(Value::Null, |s| stamp_out(s, &mut peers));
        let partition = record
            .partition
            .as_ref()
            .map_or(Value::Null, |p| index(partitions.of(p)));
        encoded.push(Value::Array(vec![
            index(table_index),
            Value::Text(row.key.clone()),
            write,
            delete,
            partition,
            Value::Array(cells),
        ]));
    }
    let tables = tables
        .values
        .iter()
        .enumerate()
        .map(|(i, table)| {
            let names = columns
                .get(i)
                .map(|d| d.values.iter().map(|c| Value::Text(c.clone())).collect())
                .unwrap_or_default();
            Value::Array(vec![Value::Text(table.clone()), Value::Array(names)])
        })
        .collect();
    // after the rows: a producer joins the peers dictionary behind every peer they name
    let tail = docs.map(|docs| {
        let checkpoints = docs
            .checkpoints
            .iter()
            .map(|c| {
                Value::Array(vec![
                    index(peers.of(&c.producer)),
                    Value::Bytes(c.checkpoint.clone()),
                    Value::Bytes(c.snapshot.clone()),
                ])
            })
            .collect();
        [Value::Array(checkpoints), Value::Bool(docs.complete)]
    });
    let mut page = vec![
        Value::Int(if docs.is_some() {
            DOCS_VERSION
        } else {
            ROWS_VERSION
        }),
        Value::Array(
            peers
                .values
                .iter()
                .map(|p| Value::Bytes(p.key_bytes().to_vec()))
                .collect(),
        ),
        Value::Array(tables),
        Value::Array(
            partitions
                .values
                .iter()
                .map(|p| Value::Text(p.clone()))
                .collect(),
        ),
        Value::Array(encoded),
    ];
    if let Some(tail) = tail {
        page.extend(tail);
    }
    encode(&Value::Array(page))
}

struct Dictionaries {
    peers: Vec<PeerId>,
    tables: Vec<(String, Vec<String>)>,
    partitions: Vec<String>,
}

fn at<'a, T>(list: &'a [T], value: &Value, what: &str) -> Result<&'a T, MalformedSnapshot> {
    let Some(i) = safe_non_negative(Some(value)) else {
        return malformed(format!("{what} index is not an integer"));
    };
    match list.get(i as usize) {
        Some(found) => Ok(found),
        None => malformed(format!("{what} index is out of range")),
    }
}

fn read_dictionaries(
    peers: &Value,
    tables: &Value,
    partitions: &Value,
) -> Result<Dictionaries, MalformedSnapshot> {
    let Some(peers) = peers.as_array() else {
        return malformed("peers are not an array");
    };
    let peers = peers
        .iter()
        .map(|p| match p.as_bytes() {
            Some(bytes) => peer_from_bytes(bytes).or_else(malformed),
            None => malformed("peer id is not bytes"),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Some(tables) = tables.as_array() else {
        return malformed("tables are not an array");
    };
    let tables = tables
        .iter()
        .map(|entry| {
            let Some([table, names]) = entry.as_array() else {
                return malformed("table is not a pair");
            };
            let Some(table) = table.as_text() else {
                return malformed("table name is not text");
            };
            let Some(names) = names.as_array() else {
                return malformed("columns are not an array");
            };
            let names = names
                .iter()
                .map(|n| match n.as_text() {
                    Some(n) => Ok(n.to_owned()),
                    None => malformed("column name is not text"),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok((table.to_owned(), names))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Some(partitions) = partitions.as_array() else {
        return malformed("partitions are not an array");
    };
    let partitions = partitions
        .iter()
        .map(|p| match p.as_text() {
            Some(p) => PartitionKey::parse(p)
                .map(|k| k.as_str().to_owned())
                .or_else(|e| malformed(e.message)),
            None => malformed("partition is not text"),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Dictionaries {
        peers,
        tables,
        partitions,
    })
}

fn read_stamp(value: &Value, peers: &[PeerId]) -> Result<Stamp, MalformedSnapshot> {
    let Some([ms, logical, peer]) = value.as_array() else {
        return malformed("stamp is not a triple");
    };
    let (Some(ms), Some(logical)) = (
        safe_non_negative(Some(ms)),
        safe_non_negative(Some(logical)),
    ) else {
        return malformed("stamp clock is not a pair of integers");
    };
    let Ok(logical) = u32::try_from(logical) else {
        return malformed("stamp counter is out of range");
    };
    if safe_non_negative(Some(peer)).is_none() {
        return malformed("stamp peer is not an index");
    }
    let peer = at(peers, peer, "stamp peer")?;
    Ok(Stamp::new(Hlc::new(ms, logical), peer.clone()))
}

fn optional_stamp(value: &Value, peers: &[PeerId]) -> Result<Option<Stamp>, MalformedSnapshot> {
    match value {
        Value::Null => Ok(None),
        other => read_stamp(other, peers).map(Some),
    }
}

fn read_row(row: &Value, dicts: &Dictionaries) -> Result<SnapshotRow, MalformedSnapshot> {
    let Some([table, key, write, delete, partition, cells]) = row.as_array() else {
        return malformed("row is not a sextuple");
    };
    let (table, names) = at(&dicts.tables, table, "table")?;
    let Some(key) = key.as_text() else {
        return malformed("row key is not text");
    };
    let write_stamp = optional_stamp(write, &dicts.peers)?;
    let delete_stamp = optional_stamp(delete, &dicts.peers)?;
    let Some(cells) = cells.as_array() else {
        return malformed("cells are not an array");
    };
    let mut record = RowRecord::default();
    for cell in cells {
        let (column, value, stamp) = match cell.as_array() {
            Some([column, value]) => (column, value, None),
            Some([column, value, stamp]) => (column, value, Some(stamp)),
            _ => return malformed("cell is not a pair or a triple"),
        };
        let column = at(names, column, "column")?;
        let value = cell_from_cbor(value).or_else(|e| malformed(e.message))?;
        // a cell with no stamp of its own sits at the row's write stamp
        let stamp = match stamp {
            Some(stamp) => read_stamp(stamp, &dicts.peers)?,
            None => match &write_stamp {
                Some(w) => w.clone(),
                None => return malformed("a cell has no stamp and neither has its row"),
            },
        };
        record.cells.insert(column.clone(), Cell { value, stamp });
    }
    record.write_stamp = write_stamp;
    record.delete_stamp = delete_stamp;
    record.partition = match partition {
        Value::Null => None,
        index => Some(at(&dicts.partitions, index, "partition")?.clone()),
    };
    Ok(SnapshotRow::new(table.clone(), key, record))
}

/// Reads one page's rows back, whichever version carried them. Never panics; every fault is a
/// [`MalformedSnapshot`].
pub fn decode_snapshot_rows(bytes: &[u8]) -> Result<Vec<SnapshotRow>, MalformedSnapshot> {
    decode_snapshot_page(bytes).map(|page| page.rows)
}

/// Reads one page of either version back: its rows, and on version 2 its documents.
pub fn decode_snapshot_page(bytes: &[u8]) -> Result<SnapshotPage, MalformedSnapshot> {
    let value = decode(bytes).or_else(|e| malformed(e.message))?;
    let Some(fields) = value.as_array() else {
        return malformed("snapshot is not an array");
    };
    let version = fields.first().and_then(Value::as_int);
    let (head, tail) = match (version, fields.len()) {
        (Some(ROWS_VERSION), 5) => fields.split_at(5),
        (Some(ROWS_VERSION), _) => return malformed("snapshot is not a quintuple"),
        (Some(DOCS_VERSION), 7) => fields.split_at(5),
        (Some(DOCS_VERSION), _) => return malformed("snapshot with documents is not a septuple"),
        _ => {
            return malformed(format!(
                "snapshot version is not {ROWS_VERSION} or {DOCS_VERSION}"
            ));
        }
    };
    let [_, peers, tables, partitions, rows] = head else {
        return malformed("snapshot is not a quintuple");
    };
    let dicts = read_dictionaries(peers, tables, partitions)?;
    let Some(rows) = rows.as_array() else {
        return malformed("rows are not an array");
    };
    let rows = rows
        .iter()
        .map(|row| read_row(row, &dicts))
        .collect::<Result<Vec<_>, _>>()?;
    let docs = match tail {
        [] => None,
        [checkpoints, complete] => Some(read_page_docs(checkpoints, complete, &dicts.peers)?),
        _ => return malformed("snapshot with documents is not a septuple"),
    };
    Ok(SnapshotPage { rows, docs })
}

fn read_page_docs(
    checkpoints: &Value,
    complete: &Value,
    peers: &[PeerId],
) -> Result<PageDocs, MalformedSnapshot> {
    let Value::Bool(complete) = complete else {
        return malformed("completeness is not a boolean");
    };
    let Some(entries) = checkpoints.as_array() else {
        return malformed("checkpoints are not an array");
    };
    let checkpoints = entries
        .iter()
        .map(|entry| {
            let Some([producer, checkpoint, snapshot]) = entry.as_array() else {
                return malformed("checkpoint is not a triple");
            };
            if safe_non_negative(Some(producer)).is_none() {
                return malformed("checkpoint producer is not an index");
            }
            let producer = at(peers, producer, "checkpoint producer")?.clone();
            let Some(checkpoint) = checkpoint.as_bytes() else {
                return malformed("checkpoint is not bytes");
            };
            let Some(snapshot) = snapshot.as_bytes() else {
                return malformed("checkpoint snapshot is not bytes");
            };
            Ok(PageCheckpoint {
                producer,
                checkpoint: checkpoint.to_vec(),
                snapshot: snapshot.to_vec(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PageDocs {
        checkpoints,
        complete: *complete,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::CellValue;

    fn peer(n: u8) -> PeerId {
        PeerId::parse(&crate::hex::to_hex(&[n; 32])).unwrap()
    }

    fn stamp(ms: i64, p: u8) -> Stamp {
        Stamp::new(Hlc::new(ms, 0), peer(p))
    }

    #[test]
    fn a_page_round_trips_and_only_a_moved_cell_carries_a_stamp() {
        let mut record = RowRecord {
            write_stamp: Some(stamp(10, 1)),
            partition: Some("org:acme".into()),
            ..RowRecord::default()
        };
        record.cells.insert(
            "title".into(),
            Cell {
                value: CellValue::text("a"),
                stamp: stamp(10, 1),
            },
        );
        record.cells.insert(
            "done".into(),
            Cell {
                value: CellValue::Bool(true),
                stamp: stamp(5, 2),
            },
        );
        let tomb = RowRecord {
            write_stamp: Some(stamp(1, 1)),
            delete_stamp: Some(stamp(2, 2)),
            ..RowRecord::default()
        };
        let rows = vec![
            SnapshotRow::new("tasks", "t1", record),
            SnapshotRow::new("tasks", "t2", tomb),
        ];
        let bytes = encode_snapshot_rows(&rows);
        let back = decode_snapshot_rows(&bytes).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].record, rows[0].record);
        assert_eq!(back[1].record, rows[1].record);
        assert_eq!(encode_snapshot_rows(&back), bytes);
    }

    #[test]
    fn a_page_with_documents_round_trips_and_its_rows_read_alone() {
        let record = RowRecord {
            write_stamp: Some(stamp(10, 1)),
            ..RowRecord::default()
        };
        let rows = vec![SnapshotRow::new("notes", "n1", record)];
        let docs = PageDocs {
            checkpoints: vec![PageCheckpoint {
                producer: peer(9),
                checkpoint: vec![1, 2],
                snapshot: vec![3],
            }],
            complete: true,
        };
        let bytes = encode_snapshot_page(&rows, Some(&docs));
        let back = decode_snapshot_page(&bytes).unwrap();
        assert_eq!(back.docs.as_ref(), Some(&docs));
        assert_eq!(encode_snapshot_page(&back.rows, back.docs.as_ref()), bytes);
        assert_eq!(decode_snapshot_rows(&bytes).unwrap(), rows);
        // a page without documents is version 1, byte for byte
        assert_eq!(
            encode_snapshot_page(&rows, None),
            encode_snapshot_rows(&rows)
        );
        assert_eq!(
            decode_snapshot_page(&encode_snapshot_rows(&rows))
                .unwrap()
                .docs,
            None
        );
    }

    #[test]
    fn a_malformed_checkpoint_entry_is_a_value() {
        let page = |entries: Value, complete: Value| {
            encode(&Value::Array(vec![
                Value::Int(2),
                Value::Array(vec![Value::Bytes(vec![7; 32])]),
                Value::Array(vec![]),
                Value::Array(vec![]),
                Value::Array(vec![]),
                entries,
                complete,
            ]))
        };
        let message = |entries: Value, complete: Value| match decode_snapshot_page(&page(
            entries, complete,
        )) {
            Ok(_) => "read".to_owned(),
            Err(e) => e.message,
        };
        let entry = |i: i64| {
            Value::Array(vec![
                Value::Int(i),
                Value::Bytes(vec![1]),
                Value::Bytes(vec![2]),
            ])
        };
        assert_eq!(
            message(Value::Array(vec![entry(0)]), Value::Bool(true)),
            "read"
        );
        assert_eq!(
            message(Value::Array(vec![entry(1)]), Value::Bool(true)),
            "checkpoint producer index is out of range"
        );
        assert_eq!(
            message(Value::text("x"), Value::Bool(true)),
            "checkpoints are not an array"
        );
        assert_eq!(
            message(Value::Array(vec![]), Value::Int(1)),
            "completeness is not a boolean"
        );
        let short = encode(&Value::Array(vec![
            Value::Int(2),
            Value::Array(vec![]),
            Value::Array(vec![]),
            Value::Array(vec![]),
            Value::Array(vec![]),
        ]));
        assert_eq!(
            decode_snapshot_page(&short).unwrap_err().message,
            "snapshot with documents is not a septuple"
        );
    }

    #[test]
    fn foreign_bytes_are_a_value_never_a_panic() {
        for bytes in [&[][..], &[0x80], &[0x85, 0x02, 0x80, 0x80, 0x80, 0x80]] {
            assert!(decode_snapshot_rows(bytes).is_err());
        }
        // a cell with no stamp on a row with none
        let row = Value::Array(vec![
            Value::Int(0),
            Value::text("k"),
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Array(vec![Value::Array(vec![Value::Int(0), Value::Null])]),
        ]);
        let page = encode(&Value::Array(vec![
            Value::Int(1),
            Value::Array(vec![]),
            Value::Array(vec![Value::Array(vec![
                Value::text("t"),
                Value::Array(vec![Value::text("c")]),
            ])]),
            Value::Array(vec![]),
            Value::Array(vec![row]),
        ]));
        assert_eq!(
            decode_snapshot_rows(&page).unwrap_err().message,
            "a cell has no stamp and neither has its row"
        );
    }
}
