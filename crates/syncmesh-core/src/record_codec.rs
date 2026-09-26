//! A row record as the state store holds it, and as a checkpoint counts it:
//! `[cells[[column, value, stamp]], writeStamp | null, deleteStamp | null, partition | null]`,
//! every stamp as `[ms, logical, peer]` with the peer as its 32 key bytes.
//!
//! Cells go out in column order by UTF-8 bytes, because `RowRecord` holds them in a `BTreeMap`.
//! The TypeScript writes them in its `Map`'s insertion order instead, so the same record can have
//! two encodings; neither side signs a record, but a checkpoint hashes them, so a checkpoint's
//! rows are carried as the bytes they arrived in (`CheckpointRow::record`) and never re-encoded.

use crate::cbor::{Value, decode, encode};
use crate::event::PartitionKey;
use crate::hlc::Hlc;
use crate::record::{Cell, RowRecord};
use crate::row_codec::{cell_from_cbor, cell_to_cbor};
use crate::signed::{peer_from_bytes, safe_non_negative};
use crate::stamp::Stamp;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MalformedRecord {
    pub message: &'static str,
}

impl std::fmt::Display for MalformedRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "malformed record: {}", self.message)
    }
}

impl std::error::Error for MalformedRecord {}

fn malformed<T>(message: &'static str) -> Result<T, MalformedRecord> {
    Err(MalformedRecord { message })
}

fn stamp_to_cbor(stamp: &Stamp) -> Value {
    Value::Array(vec![
        Value::Int(stamp.hlc.ms),
        Value::Int(stamp.hlc.logical as i64),
        Value::Bytes(stamp.peer.key_bytes().to_vec()),
    ])
}

fn optional(stamp: Option<&Stamp>) -> Value {
    stamp.map_or(Value::Null, stamp_to_cbor)
}

pub fn encode_record(record: &RowRecord) -> Vec<u8> {
    let cells = record
        .cells
        .iter()
        .map(|(column, cell)| {
            Value::Array(vec![
                Value::Text(column.clone()),
                cell_to_cbor(&cell.value),
                stamp_to_cbor(&cell.stamp),
            ])
        })
        .collect();
    encode(&Value::Array(vec![
        Value::Array(cells),
        optional(record.write_stamp.as_ref()),
        optional(record.delete_stamp.as_ref()),
        record
            .partition
            .as_ref()
            .map_or(Value::Null, |p| Value::Text(p.clone())),
    ]))
}

/// Never panics; every fault, from truncated CBOR to a bad partition, is a `MalformedRecord`.
pub fn decode_record(bytes: &[u8]) -> Result<RowRecord, MalformedRecord> {
    let value = decode(bytes).map_err(|e| MalformedRecord { message: e.message })?;
    let Some([cells, write, delete, partition]) = value.as_array() else {
        return malformed("record is not a quadruple");
    };
    let Value::Array(cells) = cells else {
        return malformed("cells are not an array");
    };
    let mut record = RowRecord::default();
    for entry in cells {
        let Some([column, value, stamp]) = entry.as_array() else {
            return malformed("cell is not a triple");
        };
        let Value::Text(column) = column else {
            return malformed("column name is not text");
        };
        let value = cell_from_cbor(value).map_err(|e| MalformedRecord { message: e.message })?;
        let stamp = stamp_from_cbor(stamp)?;
        record.cells.insert(column.clone(), Cell { value, stamp });
    }
    record.write_stamp = optional_stamp(write)?;
    record.delete_stamp = optional_stamp(delete)?;
    record.partition = match partition {
        Value::Null => None,
        Value::Text(p) => Some(
            PartitionKey::parse(p)
                .map_err(|e| MalformedRecord { message: e.message })?
                .as_str()
                .to_owned(),
        ),
        _ => return malformed("partition is not text"),
    };
    Ok(record)
}

fn optional_stamp(value: &Value) -> Result<Option<Stamp>, MalformedRecord> {
    match value {
        Value::Null => Ok(None),
        other => stamp_from_cbor(other).map(Some),
    }
}

fn stamp_from_cbor(value: &Value) -> Result<Stamp, MalformedRecord> {
    let Some([ms, logical, peer]) = value.as_array() else {
        return malformed("stamp is not a triple");
    };
    let (Some(ms), Some(logical)) = (
        safe_non_negative(Some(ms)),
        safe_non_negative(Some(logical)),
    ) else {
        return malformed("stamp clock is not a pair of integers");
    };
    let Value::Bytes(peer) = peer else {
        return malformed("stamp peer is not bytes");
    };
    // the TypeScript counter is any safe integer; this clock's is a u32, as the event codec's is
    let Ok(logical) = u32::try_from(logical) else {
        return malformed("logical counter too large");
    };
    let peer = peer_from_bytes(peer).map_err(|message| MalformedRecord { message })?;
    Ok(Stamp::new(Hlc::new(ms, logical), peer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::PeerId;
    use crate::record::{CellValue, JsonValue};

    fn stamp(ms: i64, logical: u32) -> Stamp {
        Stamp::new(
            Hlc::new(ms, logical),
            PeerId::parse(&"a".repeat(64)).unwrap(),
        )
    }

    fn record() -> RowRecord {
        let mut r = RowRecord::default();
        let mut o = std::collections::BTreeMap::new();
        o.insert("b".to_owned(), JsonValue::Number(1.0));
        let cells = [
            ("title", CellValue::text("hi"), stamp(1, 0)),
            (
                "tags",
                CellValue::Array(vec![JsonValue::Text("a".into()), JsonValue::Object(o)]),
                stamp(2, 3),
            ),
            ("blob", CellValue::Bytes(vec![1, 2]), stamp(3, 0)),
            ("gone", CellValue::Null, stamp(4, 0)),
        ];
        for (c, value, stamp) in cells {
            r.cells.insert(c.to_owned(), Cell { value, stamp });
        }
        r.write_stamp = Some(stamp(1, 0));
        r.delete_stamp = Some(stamp(0, 0));
        r
    }

    #[test]
    fn round_trips_cells_nested_json_bytes_and_both_stamps_byte_identically() {
        let bytes = encode_record(&record());
        let back = decode_record(&bytes).unwrap();
        assert_eq!(back, record());
        assert_eq!(encode_record(&back), bytes);
        let empty = decode_record(&encode_record(&RowRecord::default())).unwrap();
        assert_eq!(empty, RowRecord::default());
        let mut placed = record();
        placed.partition = Some("org:acme".into());
        assert_eq!(decode_record(&encode_record(&placed)).unwrap(), placed);
    }

    #[test]
    fn damage_is_a_malformed_record_never_a_panic() {
        assert!(decode_record(&[0x83, 0x00, 0xf6, 0xf6]).is_err());
        assert!(decode_record(&[0xff, 0x01]).is_err());
        let bytes = encode_record(&record());
        for n in 0..bytes.len() {
            assert!(decode_record(&bytes[..n]).is_err());
        }
        let quad = |cells: Value, partition: Value| {
            encode(&Value::Array(vec![
                cells,
                Value::Null,
                Value::Null,
                partition,
            ]))
        };
        let refuse = |bytes: Vec<u8>, says: &str| {
            assert_eq!(decode_record(&bytes).unwrap_err().message, says);
        };
        refuse(quad(Value::Int(1), Value::Null), "cells are not an array");
        refuse(
            quad(Value::Array(vec![Value::Array(vec![])]), Value::Null),
            "cell is not a triple",
        );
        refuse(
            quad(Value::Array(vec![]), Value::Int(1)),
            "partition is not text",
        );
        refuse(
            quad(Value::Array(vec![]), Value::text("acme")),
            "expected kind:id",
        );
        let stamped = |stamp: Value| {
            quad(
                Value::Array(vec![Value::Array(vec![
                    Value::text("c"),
                    Value::Null,
                    stamp,
                ])]),
                Value::Null,
            )
        };
        refuse(stamped(Value::Null), "stamp is not a triple");
        refuse(
            stamped(Value::Array(vec![
                Value::Int(-1),
                Value::Int(0),
                Value::Bytes(vec![0; 32]),
            ])),
            "stamp clock is not a pair of integers",
        );
        refuse(
            stamped(Value::Array(vec![
                Value::Int(1),
                Value::Int(0),
                Value::text("p"),
            ])),
            "stamp peer is not bytes",
        );
        refuse(
            stamped(Value::Array(vec![
                Value::Int(1),
                Value::Int(0),
                Value::Bytes(vec![0; 3]),
            ])),
            crate::event::HEX_ID_EXPECTED,
        );
    }
}
