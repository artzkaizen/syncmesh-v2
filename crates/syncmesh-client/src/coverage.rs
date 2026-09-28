//! One author's position on this device (`engine/src/coverage.ts`): everything at or below
//! `contiguous` has landed, and `ahead` is what landed past a gap (D13). A MAX cursor collapses
//! the pair into its larger half, which is the same as claiming the gap was delivered — a claim
//! nothing can take back, since anti-entropy asks for events *above* the cursor.

use std::collections::{BTreeMap, BTreeSet};

use syncmesh_core::event::{PeerId, SeqNum, SyncEvent};

use crate::store::{Ahead, Coverage, Cursors};

#[derive(Debug, Clone, Default)]
struct Chain {
    contiguous: Option<SeqNum>,
    ahead: BTreeSet<u64>,
}

impl Chain {
    fn at(&self) -> u64 {
        self.contiguous.map(|s| s.get()).unwrap_or(0)
    }

    /// Walks the run above `contiguous`, moving each sequence it finds out of `ahead`.
    fn close(&mut self) {
        loop {
            let next = self.at() + 1;
            if !self.ahead.remove(&next) {
                return;
            }
            self.contiguous = SeqNum::parse(next);
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct CoverageTracker {
    chains: BTreeMap<PeerId, Chain>,
    /// Set only by `adopt`: folding an event is evidence of that event and of nothing about a slice.
    scope: Option<String>,
}

impl CoverageTracker {
    pub fn new(initial: &Coverage) -> CoverageTracker {
        let mut tracker = CoverageTracker {
            chains: BTreeMap::new(),
            scope: initial.scope.clone(),
        };
        for (peer, seq) in &initial.synced {
            tracker.chains.insert(
                peer.clone(),
                Chain {
                    contiguous: Some(*seq),
                    ahead: BTreeSet::new(),
                },
            );
        }
        tracker
    }

    /// Records the event in the author's chain; the cursor stops below a gap rather than jumping it.
    pub fn note(&mut self, event: &SyncEvent) {
        let chain = self.chains.entry(event.peer_id.clone()).or_default();
        let at = event.seq_num.get();
        if at <= chain.at() {
            return;
        }
        chain.ahead.insert(at);
        chain.close();
    }

    /// Takes on what a snapshot or a scoped catch-up stood for (RFC-0019, D23): raises each
    /// author's cursor, never lowers one, and takes on the `scope` that makes the numbers true.
    pub fn adopt(&mut self, coverage: &Coverage) {
        for (peer, seq) in &coverage.synced {
            let chain = self.chains.entry(peer.clone()).or_default();
            if chain.at() >= seq.get() {
                continue;
            }
            chain.contiguous = Some(*seq);
            chain.ahead.retain(|&at| at > seq.get());
            chain.close();
        }
        self.scope = coverage.scope.clone();
    }

    pub fn current(&self) -> Coverage {
        Coverage {
            synced: self.cursors(),
            local: Cursors::new(),
            scope: self.scope.clone(),
        }
    }

    pub fn cursors(&self) -> Cursors {
        self.chains
            .iter()
            .filter_map(|(peer, chain)| chain.contiguous.map(|s| (peer.clone(), s)))
            .collect()
    }

    /// Per author, what this device holds above its contiguous cursor: the far side of every gap.
    pub fn ahead(&self) -> Ahead {
        self.chains
            .iter()
            .filter(|(_, chain)| !chain.ahead.is_empty())
            .map(|(peer, chain)| {
                (
                    peer.clone(),
                    chain
                        .ahead
                        .iter()
                        .filter_map(|&s| SeqNum::parse(s))
                        .collect(),
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use syncmesh_core::hlc::Hlc;

    fn peer(n: u8) -> PeerId {
        PeerId::parse(&syncmesh_core::to_hex(&[n; 32])).unwrap()
    }

    fn event(p: u8, seq: u64) -> SyncEvent {
        SyncEvent {
            peer_id: peer(p),
            seq_num: SeqNum::parse(seq).unwrap(),
            hlc: Hlc::new(1, 0),
            procedure: "t".into(),
            partition: None,
            changes: vec![],
            sealed: false,
        }
    }

    #[test]
    fn the_cursor_stops_below_a_gap_and_closes_when_it_fills() {
        let mut t = CoverageTracker::default();
        t.note(&event(1, 1));
        t.note(&event(1, 3));
        assert_eq!(t.cursors()[&peer(1)].get(), 1);
        assert_eq!(t.ahead()[&peer(1)], vec![SeqNum::parse(3).unwrap()]);
        t.note(&event(1, 2));
        assert_eq!(t.cursors()[&peer(1)].get(), 3);
        assert!(t.ahead().is_empty());
    }

    #[test]
    fn adopt_raises_never_lowers_and_carries_the_scope() {
        let mut t = CoverageTracker::default();
        t.note(&event(1, 5));
        t.note(&event(1, 7));
        let mut adopted = Coverage::default();
        adopted.synced.insert(peer(1), SeqNum::parse(6).unwrap());
        adopted.scope = Some("{}".into());
        t.adopt(&adopted);
        assert_eq!(t.cursors()[&peer(1)].get(), 7);
        assert_eq!(t.current().scope.as_deref(), Some("{}"));
        adopted.synced.insert(peer(1), SeqNum::parse(2).unwrap());
        adopted.scope = None;
        t.adopt(&adopted);
        assert_eq!(t.cursors()[&peer(1)].get(), 7);
        assert_eq!(t.current().scope, None);
    }
}
