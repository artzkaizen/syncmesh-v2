//! Undo as an ordinary write, as `engine/src/undo.ts` (RFC-0014, RFC-0023 §9, decided in §16.3).
//!
//! A revert compensates only what still stands: each cell whose stamp is still the write's goes
//! back to its value before the write — a `counter` by the increment that cancels the write's, a
//! `max`/`min` only where its rule lets the old value win ([`SkipReason::Merge`] where it does
//! not) — and a cell someone changed since stays theirs and is reported
//! [`SkipReason::Superseded`]. A row the write brought into being is deleted, with any cell a
//! colleague wrote since reported [`SkipReason::Overridden`]; a row it deleted comes back as it
//! was unless someone wrote it after the delete. Document updates are reported
//! [`SkipReason::Document`] and left to their adapter.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use syncmesh_core::event::{Change, SyncEvent};
use syncmesh_core::record::{CellValue, JsonValue, Row, RowRecord};
use syncmesh_core::stamp::Stamp;
use syncmesh_core::state::State;
use syncmesh_core::strategy::{MergeSpec, StrategyName, compare_value, counter_delta};

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
    /// A local-only write, compensated by a local-only write.
    pub local: bool,
}

impl Undo {
    /// The written event's id, `peer-Lseq` for a local-only one.
    pub fn id(&self) -> String {
        syncmesh_core::event::event_id(&self.event.peer_id, self.event.seq_num, self.local)
    }
}

/// Why a revert did not simply take something back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// Someone changed the cell — or, with no column, the whole row — after the write; their
    /// change stands and the revert left it alone.
    Superseded,
    /// A document update, which only its adapter can compensate.
    Document,
    /// The column's rule keeps what the write joined in — a `max` it raised, a `min` it lowered,
    /// a `counter` written as totals rather than an increment — so writing the old value back
    /// would change nothing and the revert does not pretend to.
    Merge,
    /// A cell someone wrote after the insert this revert takes back, deleted with the row.
    Overridden,
}

/// Something a revert did not simply take back: a cell, or a whole row when `column` is `None`.
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

/// One row's share of a write: whether it deleted the row, and each column it wrote with every
/// value it wrote there, in order.
#[derive(Default, Clone)]
struct Written<'a> {
    deleted: bool,
    columns: Vec<(&'a str, Vec<&'a CellValue>)>,
}

/// Per row the write touched, what it wrote there.
fn written_rows(changes: &[Change]) -> BTreeMap<(&str, &str), Written<'_>> {
    let mut rows: BTreeMap<(&str, &str), Written<'_>> = BTreeMap::new();
    for change in changes {
        let (table, key, cells, deleted) = match change {
            Change::Insert { table, key, row }
            | Change::Update {
                table,
                key,
                patch: row,
            } => (table, key, Some(row), false),
            Change::Delete { table, key } => (table, key, None, true),
            Change::Doc(_) | Change::Unknown { .. } => continue,
        };
        let entry = rows.entry((table.as_str(), key.as_str())).or_default();
        entry.deleted |= deleted;
        for (column, value) in cells.into_iter().flatten() {
            match entry
                .columns
                .iter_mut()
                .find(|(c, _)| *c == column.as_str())
            {
                Some((_, values)) => values.push(value),
                None => entry.columns.push((column.as_str(), vec![value])),
            }
        }
    }
    rows
}

fn holds(stamp: Option<&Stamp>, mine: &Stamp) -> bool {
    stamp == Some(mine)
}

/// What takes one cell that still holds the write back to `old`, by the column's rule: the old
/// value for `lww`; for `counter`, the increment that cancels the write's own (`{"+": -n}`), since
/// a normal-form value joins by per-author max and would change nothing; for `max`/`min`, the old
/// value only when the rule lets it win. `None` when the rule keeps what the write joined in.
fn restore_cell(
    rule: StrategyName,
    current: &CellValue,
    old: CellValue,
    wrote: &[&CellValue],
) -> Option<CellValue> {
    match rule {
        StrategyName::Counter => {
            let total = wrote
                .iter()
                .map(|v| counter_delta(v))
                .sum::<Option<f64>>()?;
            let mut increment = BTreeMap::new();
            increment.insert("+".to_owned(), JsonValue::Number(-total));
            Some(CellValue::Object(increment))
        }
        StrategyName::Max if compare_value(&old, current) == Ordering::Less => None,
        StrategyName::Min if compare_value(&old, current) == Ordering::Greater => None,
        _ => Some(old),
    }
}

/// The changes that take `undo`'s write back as far as it still stands in `state`, and what they
/// leave alone; `merge` names the column rules of the engine the write was made on, and `retired`
/// the columns (D31) a row brought back leaves out.
pub fn compensate(
    state: &State,
    undo: &Undo,
    merge: Option<&MergeSpec>,
    retired: impl Fn(&str, &str) -> bool,
) -> (Vec<Change>, Vec<Skipped>) {
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
        let wrote = written
            .get(&(table.as_str(), key.as_str()))
            .cloned()
            .unwrap_or_default();
        let rules = merge.and_then(|m| m.get(table));
        let rule = |column: &str| {
            rules
                .and_then(|r| r.get(column))
                .copied()
                .unwrap_or(StrategyName::Lww)
        };
        let now = state.record(table, key);
        let live = now.is_some_and(RowRecord::is_visible);
        let skip = |column: Option<&str>, reason| Skipped {
            table: table.clone(),
            key: key.clone(),
            column: column.map(str::to_owned),
            reason,
        };
        match (row, now) {
            // a delete of a row that was not there took nothing away
            (None, _) if wrote.deleted => {}
            (None, Some(now)) if live => {
                changes.push(Change::Delete {
                    table: table.clone(),
                    key: key.clone(),
                });
                for (column, cell) in &now.cells {
                    if !holds(Some(&cell.stamp), &mine) {
                        skipped.push(skip(Some(column), SkipReason::Overridden));
                    }
                }
            }
            // the row the write brought into being is gone already
            (None, _) => skipped.push(skip(None, SkipReason::Superseded)),
            (Some(row), now)
                if wrote.deleted
                    && !live
                    && holds(now.and_then(|r| r.delete_stamp.as_ref()), &mine) =>
            {
                // a document column is opened and edited, never written as a value, and a retired
                // one is written by nothing here (D31): either cell outlived the delete and comes
                // back with the row
                let values = row
                    .iter()
                    .filter(|(column, _)| {
                        rule(column) != StrategyName::Lineage && !retired(table, column)
                    })
                    .map(|(column, value)| (column.clone(), value.clone()))
                    .collect();
                changes.push(Change::Insert {
                    table: table.clone(),
                    key: key.clone(),
                    row: values,
                });
            }
            (Some(_), _) if wrote.deleted || !live => {
                skipped.push(skip(None, SkipReason::Superseded));
            }
            (Some(row), now) => {
                let mut patch = Row::new();
                for (column, values) in &wrote.columns {
                    let Some(cell) = now
                        .and_then(|r| r.cells.get(*column))
                        .filter(|c| holds(Some(&c.stamp), &mine))
                    else {
                        skipped.push(skip(Some(column), SkipReason::Superseded));
                        continue;
                    };
                    let old = row.get(*column).cloned().unwrap_or(CellValue::Null);
                    match restore_cell(rule(column), &cell.value, old, values) {
                        Some(value) => {
                            patch.insert((*column).to_owned(), value);
                        }
                        None => skipped.push(skip(Some(column), SkipReason::Merge)),
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
