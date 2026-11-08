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
//! The TypeScript also refuses a doc change on a column its schema declares as something else;
//! this crate has no schema to know the table's other columns by, so a doc change on an
//! undeclared column is let through here as there (D13's additive rule), and that one rung waits
//! for a schema port.

use std::collections::{BTreeMap, BTreeSet};

use syncmesh_core::doc::{DocColumns, derive_lineage};
use syncmesh_core::event::{Change, SyncEvent};

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

/// Why the event is refused, or `None` when every change in it passes.
pub fn doc_refusal(event: &SyncEvent, docs: &DocColumns) -> Option<&'static str> {
    for (index, change) in event.changes.iter().enumerate() {
        let declared = docs.get(change.table());
        let reason = match change {
            Change::Insert { row, .. } | Change::Update { patch: row, .. } => row
                .keys()
                .any(|c| declared.is_some_and(|d| d.contains_key(c)))
                .then_some("a document column is opened and edited, never written as a value"),
            Change::Doc(d) => {
                let adapter = declared.and_then(|cols| cols.get(&d.column));
                if adapter.is_some_and(|a| a != &d.adapter) {
                    Some("the change names another adapter than the column declares")
                } else if !d.genesis {
                    d.parent
                        .map(|_| "only a genesis names the lineage it replaces")
                } else if d.legacy {
                    Some(
                        "a genesis written under the lineage rule before RFC-0023 §16.1 (key 5 `true`)",
                    )
                } else if d.parent.is_some() && d.parent == d.lineage {
                    Some("a genesis cannot replace its own lineage")
                } else if event.changes.iter().enumerate().any(|(at, other)| {
                    at != index
                        && matches!(other, Change::Doc(o) if o.genesis
                            && o.table == d.table && o.key == d.key && o.column == d.column)
                }) {
                    Some("one event starts one lineage per document")
                } else if d.lineage
                    != Some(derive_lineage(&event.peer_id, event.seq_num, index as u32))
                {
                    Some("the genesis names a lineage its place in the log does not derive")
                } else {
                    None
                }
            }
            Change::Delete { .. } | Change::Unknown { .. } => None,
        };
        if reason.is_some() {
            return reason;
        }
    }
    None
}
