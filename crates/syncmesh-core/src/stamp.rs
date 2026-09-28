//! `(hlc, peer)` — the global total order every last-writer cell is decided by.

use crate::event::PeerId;
use crate::hlc::Hlc;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Stamp {
    pub hlc: Hlc,
    pub peer: PeerId,
}

impl Stamp {
    pub fn new(hlc: Hlc, peer: PeerId) -> Stamp {
        Stamp { hlc, peer }
    }
}

impl Ord for Stamp {
    /// By HLC, then by peer id as text — the same order the TypeScript's `compareStamp` reaches.
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.hlc
            .cmp(&other.hlc)
            .then_with(|| self.peer.as_str().cmp(other.peer.as_str()))
    }
}

impl PartialOrd for Stamp {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
