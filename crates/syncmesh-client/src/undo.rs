//! Undo as an ordinary write, as `engine/src/undo.ts` (RFC-0014, RFC-0023 §9, decided in §16.3).
//!
//! A revert compensates only what still stands: each cell whose stamp is still the write's goes
//! back to its value before the write, and a cell someone changed since stays theirs and is
//! reported [`SkipReason::Superseded`]. A row the write brought into being is deleted, and a row
//! it deleted comes back as it was unless someone wrote it after the delete. Document updates are
//! reported [`SkipReason::Document`] and left to their adapter.

use std::collections::BTreeMap;

use syncmesh_core::event::{Change, SyncEvent};
use syncmesh_core::record::{CellValue, Row, RowRecord};
use syncmesh_core::stamp::Stamp;
use syncmesh_core::state::State;

/// One row as it read before a write; `row` is `None` when it was not there to read.
#[derive(Debug, Clone, PartialEq)]
pub struct RowBefore {
    pub table: String,
    pub key: String,
    pub row: Option<Row>,
}

/// One of the engine's own revertable writes and the rows it touched, as they read before it.
#[derive(Debug, Clone, PartialEq)]
pub struct Undo {
    pub event: SyncEvent,
    pub before: Vec<RowBefore>,
}

/// Why a revert left something as it found it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// Someone changed the cell — or, with no column, the whole row — after the write.
    Superseded,
    /// A document update, which only its adapter can compensate.
    Document,
}

/// Something a revert left alone: a cell, or a whole row when `column` is `None`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub table: String,
    pub key: String,
    pub column: Option<String>,
    pub reason: SkipReason,
}

/// The rows `changes` touch, read from `state` before they apply: a revert's raw material.
pub fn rows_before(state: &State, changes: &[Change]) -> Vec<RowBefore> {
    let mut seen: Vec<RowBefore> = Vec::new();
    for change in changes {
        let (Change::Insert { table, key, .. }
        | Change::Update { table, key, .. }
        | Change::Delete { table, key }) = change
        else {
            // a document update moves no row value, and an unknown change is never authored here
            continue;
        };
        if seen.iter().any(|r| &r.table == table && &r.key == key) {
            continue;
        }
        seen.push(RowBefore {
            table: table.clone(),
            key: key.clone(),
            row: state.read_row(table, key),
        });
    }
    seen
}

/// Per row the write touched: whether it deleted it, and the columns it wrote.
fn written_rows(changes: &[Change]) -> BTreeMap<(&str, &str), (bool, Vec<&str>)> {
    let mut rows: BTreeMap<(&str, &str), (bool, Vec<&str>)> = BTreeMap::new();
    for change in changes {
        let (table, key, columns, deleted) = match change {
            Change::Insert { table, key, row }
            | Change::Update {
                table,
                key,
                patch: row,
            } => (table, key, row.keys().map(String::as_str).collect(), false),
            Change::Delete { table, key } => (table, key, Vec::new(), true),
            Change::Doc(_) | Change::Unknown { .. } => continue,
        };
        let entry = rows.entry((table.as_str(), key.as_str())).or_default();
        entry.0 |= deleted;
        for column in columns {
            if !entry.1.contains(&column) {
                entry.1.push(column);
            }
        }
    }
    rows
}

fn holds(stamp: Option<&Stamp>, mine: &Stamp) -> bool {
    stamp == Some(mine)
}

/// The changes that take `undo`'s write back as far as it still stands in `state`, and what they
/// leave alone.
pub fn compensate(state: &State, undo: &Undo) -> (Vec<Change>, Vec<Skipped>) {
    let event = &undo.event;
    let mine = event.stamp();
    let mut changes = Vec::new();
    let mut skipped: Vec<Skipped> = event
        .changes
        .iter()
        .filter_map(|c| match c {
            Change::Doc(d) => Some(Skipped {
                table: d.table.clone(),
                key: d.key.clone(),
                column: Some(d.column.clone()),
                reason: SkipReason::Document,
            }),
            _ => None,
        })
        .collect();
    let written = written_rows(&event.changes);
    for RowBefore { table, key, row } in &undo.before {
        let (deleted, columns) = written
            .get(&(table.as_str(), key.as_str()))
            .cloned()
            .unwrap_or_default();
        let now = state.record(table, key);
        let live = now.is_some_and(RowRecord::is_visible);
        let superseded = |column: Option<&str>| Skipped {
            table: table.clone(),
            key: key.clone(),
            column: column.map(str::to_owned),
            reason: SkipReason::Superseded,
        };
        match row {
            None => changes.push(Change::Delete {
                table: table.clone(),
                key: key.clone(),
            }),
            Some(row)
                if deleted && !live && holds(now.and_then(|r| r.delete_stamp.as_ref()), &mine) =>
            {
                changes.push(Change::Insert {
                    table: table.clone(),
                    key: key.clone(),
                    row: row.clone(),
                });
            }
            Some(_) if deleted || !live => skipped.push(superseded(None)),
            Some(row) => {
                let mut patch = Row::new();
                for column in columns {
                    let cell = now.and_then(|r| r.cells.get(column));
                    if holds(cell.map(|c| &c.stamp), &mine) {
                        let value = row.get(column).cloned().unwrap_or(CellValue::Null);
                        patch.insert(column.to_owned(), value);
                    } else {
                        skipped.push(superseded(Some(column)));
                    }
                }
                if !patch.is_empty() {
                    changes.push(Change::Update {
                        table: table.clone(),
                        key: key.clone(),
                        patch,
                    });
                }
            }
        }
    }
    (changes, skipped)
}
