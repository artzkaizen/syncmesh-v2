//! Rejoining from state (D46): which of a peer's compaction floors this device is below, and which
//! of a relay's `retention` floor a join is still below (gaps U30, U37).
//!
//! A peer that compacted sends its floor at index 4 of the cursors frame. A device whose
//! contiguous cursor for an author is under that peer's floor cannot be sent that author's
//! history by it and needs state instead. Both runtimes answer that question with this rule,
//! measured against `conformance/rejoin-vectors.json`.

use crate::event::{PeerId, SeqNum};
use crate::frames::Cursors;

/// Per author, in the floor's order, the floor this device is below.
///
/// Below means strictly under: at the floor this device already holds everything the peer
/// removed. A floor entry above the sender's own cursor for that author is ignored (a peer cannot
/// have removed events it does not hold), and so is this device's own author.
///
/// ```
/// use syncmesh_core::event::{PeerId, SeqNum};
/// use syncmesh_core::rejoin::below_peer_floor;
/// let me = PeerId::parse(&"aa".repeat(32)).unwrap();
/// let a = PeerId::parse(&"bb".repeat(32)).unwrap();
/// let n = |n| SeqNum::parse(n).unwrap();
/// let below = below_peer_floor(&me, &[(a.clone(), n(1))], &[(a.clone(), n(9))], &[(a.clone(), n(5))]);
/// assert_eq!(below, vec![(a, n(5))]);
/// ```
pub fn below_peer_floor(
    own: &PeerId,
    ours: &[(PeerId, SeqNum)],
    theirs: &[(PeerId, SeqNum)],
    floor: &[(PeerId, SeqNum)],
) -> Cursors {
    let at = |cursors: &[(PeerId, SeqNum)], author: &PeerId| {
        cursors
            .iter()
            .find(|(peer, _)| peer == author)
            .map_or(0, |(_, seq)| seq.get())
    };
    floor
        .iter()
        .filter(|(author, seq)| {
            author != own && seq.get() <= at(theirs, author) && at(ours, author) < seq.get()
        })
        .cloned()
        .collect()
}

/// Per author, in the floor's order, the floor a relay's `retention` refusal names that a join
/// sending `ours` is still below. Unlike [`below_peer_floor`] every author counts, this device's
/// own included: the room trimmed it and refused the join for it. Empty means the next join would
/// be served.
///
/// ```
/// use syncmesh_core::event::{PeerId, SeqNum};
/// use syncmesh_core::rejoin::below_relay_floor;
/// let a = PeerId::parse(&"aa".repeat(32)).unwrap();
/// let b = PeerId::parse(&"bb".repeat(32)).unwrap();
/// let n = |n| SeqNum::parse(n).unwrap();
/// let below = below_relay_floor(&[(a.clone(), n(1)), (b.clone(), n(7))], &[(a.clone(), n(5)), (b, n(6))]);
/// assert_eq!(below, vec![(a, n(5))]);
/// ```
pub fn below_relay_floor(ours: &[(PeerId, SeqNum)], floor: &[(PeerId, SeqNum)]) -> Cursors {
    floor
        .iter()
        .filter(|(author, seq)| {
            ours.iter()
                .find(|(peer, _)| peer == author)
                .map_or(0, |(_, held)| held.get())
                < seq.get()
        })
        .cloned()
        .collect()
}
