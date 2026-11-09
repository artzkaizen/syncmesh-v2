//! Divergence, detected cheaply (`engine/src/digest.ts`, `transport/src/divergence.ts`, RFC-0014).
//!
//! A table's digest is the **sum** mod 2^64 of its rows' digests, never an XOR: XOR self-cancels,
//! so a row present twice would digest identical to its absence. A row's digest is the first eight
//! bytes of the sha-256 of its record encoding, whose cells go out in column order, so two peers
//! holding the identical row agree whatever order their events built its cells in. The sum is
//! order-free: two peers that folded the same events in different orders agree.
//!
//! What a peer link sends after every cursor exchange, and compares against when one arrives: only
//! over the same slice, the same cursors and the same events held above them, or a peer that is
//! merely a fold behind would read as divergent (D13).

use std::collections::BTreeMap;

use sha2::{Digest as _, Sha256};
use syncmesh_core::frames::Digest;
use syncmesh_core::record::RowRecord;
use syncmesh_core::record_codec::encode_record;
use syncmesh_core::state::State;

use crate::interest::{Interest, rows_in};
use crate::store::{Ahead, Cursors};

/// One row's contribution: the first eight bytes of the hash of its record encoding.
pub fn row_digest(record: &RowRecord) -> u64 {
    let hash = Sha256::digest(encode_record(record));
    let mut head = [0u8; 8];
    head.copy_from_slice(&hash[..8]);
    u64::from_be_bytes(head)
}

/// Per table, the sum of its rows' digests over the slice `interest` names. A table with no rows
/// in that slice is absent, not zero: an absent table and an empty one are the same fact.
pub fn table_digests(state: &State, interest: Option<&Interest>) -> BTreeMap<String, u64> {
    state
        .tables
        .iter()
        .filter_map(|(table, rows)| {
            let mut within = rows
                .values()
                .filter(|record| rows_in(record, interest))
                .peekable();
            within.peek()?;
            let sum = within.fold(0u64, |total, record| total.wrapping_add(row_digest(record)));
            Some((table.to_string(), sum))
        })
        .collect()
}

/// The digests as a frame carries them.
pub fn digest_pairs(digests: &BTreeMap<String, u64>) -> Vec<(String, Digest)> {
    digests
        .iter()
        .map(|(table, sum)| (table.clone(), Digest::from_u64(*sum)))
        .collect()
}

/// What the far side counted, as its digest frame said.
#[derive(Debug, Clone, PartialEq)]
pub struct TheirDigest<'a> {
    pub scope: &'a str,
    pub at: &'a Cursors,
    pub digests: &'a [(String, Digest)],
    /// Absent from an older build, which makes the frame incomparable.
    pub ahead: Option<&'a Ahead>,
}

/// What this device stands at, for a comparison.
#[derive(Debug, Clone, PartialEq)]
pub struct OurDigest<'a> {
    pub scope: &'a str,
    pub interest: Option<&'a Interest>,
    pub synced: &'a Cursors,
    pub ahead: &'a Ahead,
    pub digests: &'a BTreeMap<String, u64>,
}

/// The tables whose fingerprints differ, sorted — or `None` when the comparison would mean nothing:
/// another slice, a window (a different subset of rows on every device under it), other cursors,
/// or other events held above them (`divergenceAgainst`).
pub fn divergence_against(ours: &OurDigest<'_>, theirs: &TheirDigest<'_>) -> Option<Vec<String>> {
    if theirs.scope != ours.scope || ours.interest.and_then(|i| i.window).is_some() {
        return None;
    }
    if !same_cursors(ours.synced, theirs.at) || !same_ahead(ours.ahead, theirs.ahead?) {
        return None;
    }
    let theirs: BTreeMap<&str, &Digest> = theirs
        .digests
        .iter()
        .map(|(table, digest)| (table.as_str(), digest))
        .collect();
    let mut names: Vec<&str> = ours.digests.keys().map(String::as_str).collect();
    names.extend(theirs.keys().copied());
    names.sort_by(|a, b| syncmesh_core::cbor::cmp_utf16(a, b));
    names.dedup();
    let differing = names
        .into_iter()
        .filter(|name| {
            let mine = ours.digests.get(*name).map(|sum| Digest::from_u64(*sum));
            mine.as_ref() != theirs.get(name).copied()
        })
        .map(str::to_owned)
        .collect();
    Some(differing)
}

/// The same contiguous position for every author either side names; an absent author is 0.
fn same_cursors(ours: &Cursors, theirs: &Cursors) -> bool {
    let at = |cursors: &Cursors, peer| cursors.get(peer).map_or(0, |s| s.get());
    ours.keys()
        .chain(theirs.keys())
        .all(|peer| at(ours, peer) == at(theirs, peer))
}

/// The same events held above the cursors (`sameAhead`).
fn same_ahead(ours: &Ahead, theirs: &Ahead) -> bool {
    let empty = Vec::new();
    ours.keys()
        .chain(theirs.keys())
        .all(|peer| ours.get(peer).unwrap_or(&empty) == theirs.get(peer).unwrap_or(&empty))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_table_digest_is_a_sum_so_a_duplicate_row_is_not_its_absence() {
        let mut state = State::new();
        let record = RowRecord {
            partition: Some("org:acme".to_owned()),
            ..RowRecord::default()
        };
        let one = row_digest(&record);
        let notes = state.tables.entry("notes".into()).or_default();
        notes.insert("a".into(), record.clone());
        notes.insert("b".into(), record);
        assert_eq!(table_digests(&state, None)["notes"], one.wrapping_add(one));
        assert_ne!(one.wrapping_add(one), 0);
    }

    #[test]
    fn an_interest_leaves_out_the_rows_of_other_instances_and_a_table_with_none() {
        let mut state = State::new();
        let record = RowRecord {
            partition: Some("org:acme".to_owned()),
            ..RowRecord::default()
        };
        state
            .tables
            .entry("notes".into())
            .or_default()
            .insert("a".into(), record);
        let beta =
            Interest::partitions([syncmesh_core::event::PartitionKey::parse("org:beta").unwrap()]);
        assert!(table_digests(&state, Some(&beta)).is_empty());
    }
}
