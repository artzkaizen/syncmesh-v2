//! The doc changes a mesh's declared doc columns refuse (`engine/src/doc-rules.ts`, RFC-0023 §10),
//! decided from the event and the declaration alone — never from which adapters a device holds —
//! so a device with the adapter and one without park the same set (D22).
//!
//! A genesis's parent (§16.1) need not be held: one that has not arrived is how out-of-order
//! delivery looks, and the lineage walk resolves it when it lands. Only what the event disproves
//! is refused — a parent on an edit, a genesis that names its own lineage as the one it replaces,
//! and a genesis written under the rule before §16.1 (`legacy`), which the wire keeps readable so
//! this is where it stops.
//!
//! The `column` rung — a doc change on a column the table declares as something else — needs the
//! table's columns, which only a validator's manifest has ([`crate::validate`]); with none, a doc
//! change on an undeclared column is let through here as there (D13's additive rule). This crate
//! writes no local events, so the `local` rung is the validator's alone too.

use std::collections::{BTreeMap, BTreeSet};

use syncmesh_core::doc::{DocChange, DocColumns, derive_lineage};
use syncmesh_core::event::{Change, PeerId, SeqNum, SyncEvent};

use crate::validate::{ValidationError, unfoldable};

/// Per table, the columns its schema derives from a document column (RFC-0023 §16.4): every
/// replica computes them, so no write carries them. Built from the manifest's doc column entries
/// with [`crate::docs::derived_columns`].
pub type DerivedColumns = BTreeMap<String, BTreeSet<String>>;

/// Why this device's own write is refused for naming a derived column, or `None`. Asked of a local
/// write only, as the TypeScript's probe asks it: a numbered event naming one — written before the
/// column was derived, or by a build that does not derive it — still folds (RFC-0023 §12).
pub fn derived_refusal(event: &SyncEvent, derived: &DerivedColumns) -> Option<&'static str> {
    event
        .changes
        .iter()
        .any(|change| match change {
            Change::Insert { table, row, .. }
            | Change::Update {
                table, patch: row, ..
            } => derived
                .get(table)
                .is_some_and(|columns| row.keys().any(|c| columns.contains(c))),
            Change::Doc(_) | Change::Delete { .. } | Change::Unknown { .. } => false,
        })
        .then_some("a derived column is computed by every replica, never written")
}

/// Which rule a refused doc change broke — the TypeScript's `DocRung`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocRung {
    Column,
    Adapter,
    Lineage,
    Local,
}

impl DocRung {
    pub fn as_str(self) -> &'static str {
        match self {
            DocRung::Column => "column",
            DocRung::Adapter => "adapter",
            DocRung::Lineage => "lineage",
            DocRung::Local => "local",
        }
    }
}

/// A doc change nobody should fold, and the rung that says why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocRefusal {
    pub rung: DocRung,
    pub message: &'static str,
}

/// The event a doc change is judged in: its author, its place in the log once it has one, and
/// every change beside it.
#[derive(Debug, Clone, Copy)]
pub struct DocEvent<'a> {
    pub peer: &'a PeerId,
    /// `None` on a probe — this device's own write before it is numbered, whose lineage the
    /// engine derives itself.
    pub seq: Option<SeqNum>,
    pub changes: &'a [Change],
}

const fn refuse(rung: DocRung, message: &'static str) -> Option<DocRefusal> {
    Some(DocRefusal { rung, message })
}

/// One doc change against what its table declares: `declared` is the column's adapter when it is
/// a document column, and `other_column` says the table declares it as something else.
pub fn check_doc(
    change: &DocChange,
    index: usize,
    event: DocEvent<'_>,
    declared: Option<&String>,
    other_column: bool,
) -> Option<DocRefusal> {
    if declared.is_none() && other_column {
        return refuse(DocRung::Column, "the column is not a document column");
    }
    if declared.is_some_and(|a| a != &change.adapter) {
        return refuse(
            DocRung::Adapter,
            "the change names another adapter than the column declares",
        );
    }
    if !change.genesis {
        return change.parent.and(refuse(
            DocRung::Lineage,
            "only a genesis names the lineage it replaces",
        ));
    }
    if change.legacy {
        return refuse(
            DocRung::Lineage,
            "a genesis written under the lineage rule before RFC-0023 §16.1 (key 5 `true`)",
        );
    }
    if change.parent.is_some() && change.parent == change.lineage {
        return refuse(DocRung::Lineage, "a genesis cannot replace its own lineage");
    }
    let twice = event.changes.iter().enumerate().any(|(at, other)| {
        at != index
            && matches!(other, Change::Doc(o) if o.genesis
                && o.table == change.table && o.key == change.key && o.column == change.column)
    });
    if twice {
        return refuse(
            DocRung::Lineage,
            "one event starts one lineage per document",
        );
    }
    let seq = event.seq?;
    match change.lineage {
        None => refuse(DocRung::Lineage, "a genesis names its lineage"),
        Some(lineage) if lineage != derive_lineage(event.peer, seq, index as u32) => refuse(
            DocRung::Lineage,
            "the genesis names a lineage its place in the log does not derive",
        ),
        Some(_) => None,
    }
}

/// The verdict an engine with no validator reaches: a change kind this build has no fold for,
/// then the rungs that need no manifest. `None` when it folds.
pub fn doc_verdict(event: &SyncEvent, docs: &DocColumns) -> Option<ValidationError> {
    if let Some(unfoldable) = unfoldable(event) {
        return Some(unfoldable);
    }
    let at = DocEvent {
        peer: &event.peer_id,
        seq: Some(event.seq_num),
        changes: &event.changes,
    };
    event
        .changes
        .iter()
        .enumerate()
        .find_map(|(index, change)| {
            let declared = docs.get(change.table());
            match change {
                Change::Insert { row, .. } | Change::Update { patch: row, .. } => row
                    .keys()
                    .find(|c| declared.is_some_and(|d| d.contains_key(*c)))
                    .map(|column| ValidationError::DocColumnWrite {
                        table: change.table().to_owned(),
                        key: change.key().to_owned(),
                        column: column.clone(),
                    }),
                Change::Doc(d) => {
                    let adapter = declared.and_then(|cols| cols.get(&d.column));
                    check_doc(d, index, at, adapter, false).map(|refused| {
                        ValidationError::DocChangeRefused {
                            table: d.table.clone(),
                            key: d.key.clone(),
                            column: d.column.clone(),
                            rung: refused.rung,
                            message: refused.message,
                        }
                    })
                }
                Change::Delete { .. } | Change::Unknown { .. } => None,
            }
        })
}

/// Why a write is refused by the doc rungs, said as a sentence — [`doc_verdict`] for
/// `MutateError::DocRefused`.
pub fn doc_refusal(event: &SyncEvent, docs: &DocColumns) -> Option<&'static str> {
    doc_verdict(event, docs).map(|verdict| match verdict {
        ValidationError::DocChangeRefused { message, .. } => message,
        ValidationError::UnknownChangeKind { .. } => "a change this build has no fold for",
        _ => "a document column is opened and edited, never written as a value",
    })
}
