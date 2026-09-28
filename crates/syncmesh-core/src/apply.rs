//! The fold: one change or one whole record joined into the state. Every step is a max-based join,
//! so any order and any replay of the same changes converge.

use std::collections::BTreeMap;

use crate::event::{Change, PartitionKey};
use crate::record::{Cell, Row, RowRecord};
use crate::stamp::Stamp;
use crate::state::State;
use crate::strategy::{MergeSpec, StrategyName, join};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unfoldable {
    pub tag: u64,
}

fn later(a: Option<Stamp>, b: Option<Stamp>) -> Option<Stamp> {
    match (a, b) {
        (None, b) => b,
        (a, None) => a,
        (Some(a), Some(b)) => Some(if a > b { a } else { b }),
    }
}

fn stamp_all(row: &Row, stamp: &Stamp) -> BTreeMap<String, Cell> {
    row.iter()
        .map(|(c, v)| {
            (
                c.clone(),
                Cell {
                    value: v.clone(),
                    stamp: stamp.clone(),
                },
            )
        })
        .collect()
}

/// Folds one change into the state. `insert` and `update` both merge column by column (RFC-0014 §1);
/// `merge` names the strategy per column, defaulting to `lww`; a row keeps the first partition it saw.
/// An `unknown` change has no fold (D22-A) and is returned as such, the state untouched.
pub fn apply_change(
    state: &mut State,
    change: &Change,
    stamp: &Stamp,
    merge: Option<&MergeSpec>,
    partition: Option<&PartitionKey>,
) -> Result<(), Unfoldable> {
    let (table, key, incoming) = match change {
        Change::Delete { table, key } => (
            table,
            key,
            RowRecord {
                delete_stamp: Some(stamp.clone()),
                ..RowRecord::default()
            },
        ),
        Change::Insert { table, key, row }
        | Change::Update {
            table,
            key,
            patch: row,
        } => (
            table,
            key,
            RowRecord {
                cells: stamp_all(row, stamp),
                write_stamp: Some(stamp.clone()),
                ..RowRecord::default()
            },
        ),
        Change::Unknown { tag, .. } => return Err(Unfoldable { tag: *tag }),
    };
    let incoming = RowRecord {
        partition: partition.map(|p| p.as_str().to_owned()),
        ..incoming
    };
    merge_record(state, table, key, incoming, merge);
    Ok(())
}

/// Joins a whole record — a snapshot row — into the state; equivalent to folding its cells and stamps as changes.
pub fn merge_record(
    state: &mut State,
    table: &str,
    key: &str,
    record: RowRecord,
    merge: Option<&MergeSpec>,
) {
    let columns = merge.and_then(|m| m.get(table));
    let table_state = state.tables.entry(table.to_owned()).or_default();
    let current = table_state.entry(key.to_owned()).or_default();
    for (column, candidate) in record.cells {
        let strategy = columns
            .and_then(|c| c.get(&column).copied())
            .unwrap_or(StrategyName::Lww);
        // a first arrival passes `None` so `counter` can tell an increment landing on nothing from
        // one landing on totals
        let existing = current.cells.remove(&column);
        current
            .cells
            .insert(column, join(strategy, candidate, existing));
    }
    current.write_stamp = later(current.write_stamp.take(), record.write_stamp);
    current.delete_stamp = later(current.delete_stamp.take(), record.delete_stamp);
    if current.partition.is_none() {
        current.partition = record.partition;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::PeerId;
    use crate::hlc::Hlc;
    use crate::record::CellValue;

    fn peer(c: char) -> PeerId {
        PeerId::parse(&c.to_string().repeat(64)).unwrap()
    }

    fn stamp(ms: i64, p: char) -> Stamp {
        Stamp::new(Hlc::new(ms, 0), peer(p))
    }

    fn row(pairs: &[(&str, CellValue)]) -> Row {
        pairs
            .iter()
            .map(|(c, v)| (c.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn insert_update_delete_fold_in_any_order() {
        let insert = Change::Insert {
            table: "notes".into(),
            key: "n1".into(),
            row: row(&[
                ("body", CellValue::text("a")),
                ("pinned", CellValue::Bool(false)),
            ]),
        };
        let update = Change::Update {
            table: "notes".into(),
            key: "n1".into(),
            patch: row(&[("body", CellValue::text("b"))]),
        };
        let delete = Change::Delete {
            table: "notes".into(),
            key: "n1".into(),
        };
        let steps = [
            (insert, stamp(1, 'a')),
            (update, stamp(2, 'a')),
            (delete, stamp(3, 'b')),
        ];
        let mut forward = State::new();
        for (c, s) in &steps {
            apply_change(&mut forward, c, s, None, None).unwrap();
        }
        let mut backward = State::new();
        for (c, s) in steps.iter().rev() {
            apply_change(&mut backward, c, s, None, None).unwrap();
        }
        assert_eq!(forward, backward);
        assert!(
            forward.read_row("notes", "n1").is_none(),
            "deleted after its last write"
        );
        let record = forward.record("notes", "n1").unwrap();
        assert_eq!(record.cells["body"].value, CellValue::text("b"));

        // a later write revives the row
        let revive = Change::Update {
            table: "notes".into(),
            key: "n1".into(),
            patch: row(&[("body", CellValue::text("c"))]),
        };
        apply_change(&mut forward, &revive, &stamp(4, 'a'), None, None).unwrap();
        assert_eq!(
            forward.read_row("notes", "n1").unwrap()["body"],
            CellValue::text("c")
        );
    }

    #[test]
    fn a_row_keeps_the_first_partition_it_saw_and_an_unknown_change_does_not_fold() {
        let mut state = State::new();
        let p1 = PartitionKey::parse("org:a").unwrap();
        let p2 = PartitionKey::parse("org:b").unwrap();
        let c = Change::Insert {
            table: "t".into(),
            key: "k".into(),
            row: row(&[("x", CellValue::Number(1.0))]),
        };
        apply_change(&mut state, &c, &stamp(1, 'a'), None, Some(&p1)).unwrap();
        apply_change(&mut state, &c, &stamp(2, 'a'), None, Some(&p2)).unwrap();
        assert_eq!(
            state.record("t", "k").unwrap().partition.as_deref(),
            Some("org:a")
        );
        let before = state.clone();
        let unknown = Change::Unknown {
            tag: 9,
            table: "t".into(),
            key: "k".into(),
            data: None,
        };
        assert_eq!(
            apply_change(&mut state, &unknown, &stamp(3, 'a'), None, None),
            Err(Unfoldable { tag: 9 })
        );
        assert_eq!(state, before);
    }
}
