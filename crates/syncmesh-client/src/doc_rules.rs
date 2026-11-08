//! The doc changes a mesh's declared doc columns refuse (`engine/src/doc-rules.ts`, RFC-0023 §10),
//! decided from the event and the declaration alone — never from which adapters a device holds —
//! so a device with the adapter and one without park the same set (D22).
//!
//! The TypeScript also refuses a doc change on a column its schema declares as something else;
//! this crate has no schema to know the table's other columns by, so a doc change on an
//! undeclared column is let through here as there (D13's additive rule), and that one rung waits
//! for a schema port.

use syncmesh_core::doc::{DocColumns, derive_lineage};
use syncmesh_core::event::{Change, SyncEvent};

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
                    None
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
