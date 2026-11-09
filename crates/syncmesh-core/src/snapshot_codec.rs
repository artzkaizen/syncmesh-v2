//! A page of snapshot rows (`wire/src/snapshot-codec.ts`, RFC-0019): what one `snap-chunk`
//! carries. `[version, peers, tables, partitions, rows]`, where a row is
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

const VERSION: i64 = 1;

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
    encode(&Value::Array(vec![
        Value::Int(VERSION),
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
    ]))
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

/// Reads one page back. Never panics; every fault is a [`MalformedSnapshot`].
pub fn decode_snapshot_rows(bytes: &[u8]) -> Result<Vec<SnapshotRow>, MalformedSnapshot> {
    let value = decode(bytes).or_else(|e| malformed(e.message))?;
    let Some([version, peers, tables, partitions, rows]) = value.as_array() else {
        return malformed("snapshot is not a quintuple");
    };
    if version.as_int() != Some(VERSION) {
        return malformed(format!("snapshot version is not {VERSION}"));
    }
    let dicts = read_dictionaries(peers, tables, partitions)?;
    let Some(rows) = rows.as_array() else {
        return malformed("rows are not an array");
    };
    rows.iter().map(|row| read_row(row, &dicts)).collect()
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
