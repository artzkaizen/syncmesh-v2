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
    /// This device's own local-only writes, numbered in their own sequence.
    local: BTreeMap<PeerId, Chain>,
    /// Set only by `adopt`: folding an event is evidence of that event and of nothing about a slice.
    scope: Option<String>,
    /// Raised only by `adopt_unheld`, never lowered: the log does not say which holes a snapshot
    /// left (D46).
    floor: Cursors,
}

fn seeded(cursors: &Cursors) -> BTreeMap<PeerId, Chain> {
    cursors
        .iter()
        .map(|(peer, seq)| {
            (
                peer.clone(),
                Chain {
                    contiguous: Some(*seq),
                    ahead: BTreeSet::new(),
                },
            )
        })
        .collect()
}

fn contiguous(chains: &BTreeMap<PeerId, Chain>) -> Cursors {
    chains
        .iter()
        .filter_map(|(peer, chain)| chain.contiguous.map(|s| (peer.clone(), s)))
        .collect()
}

fn raise(chains: &mut BTreeMap<PeerId, Chain>, peer: &PeerId, seq: SeqNum) {
    let chain = chains.entry(peer.clone()).or_default();
    if chain.at() >= seq.get() {
        return;
    }
    chain.contiguous = Some(seq);
    chain.ahead.retain(|&at| at > seq.get());
    chain.close();
}

impl CoverageTracker {
    pub fn new(initial: &Coverage) -> CoverageTracker {
        CoverageTracker {
            chains: seeded(&initial.synced),
            local: seeded(&initial.local),
            scope: initial.scope.clone(),
            floor: initial.floor.clone(),
        }
    }

    /// Records the event in the author's chain, the local-only one for a local write; the cursor
    /// stops below a gap rather than jumping it.
    pub fn note(&mut self, event: &SyncEvent, local: bool) {
        let chains = if local {
            &mut self.local
        } else {
            &mut self.chains
        };
        let chain = chains.entry(event.peer_id.clone()).or_default();
        let at = event.seq_num.get();
        if at <= chain.at() {
            return;
        }
        chain.ahead.insert(at);
        chain.close();
    }

    /// Takes on what a scoped catch-up stood for (D23): raises each author's cursor, never lowers
    /// one, and takes on the `scope` that makes the numbers true.
    pub fn adopt(&mut self, coverage: &Coverage) {
        for (peer, seq) in &coverage.synced {
            raise(&mut self.chains, peer, *seq);
        }
        for (peer, seq) in &coverage.local {
            raise(&mut self.local, peer, *seq);
        }
        self.scope = coverage.scope.clone();
    }

    /// [`CoverageTracker::adopt`] for a snapshot install, which also raises the floor: what it
    /// adopts has no log behind it, bar what was folded past a gap (D46).
    pub fn adopt_unheld(&mut self, coverage: &Coverage) {
        let from = self.cursors();
        let held = self.ahead();
        self.adopt(coverage);
        let unheld = unheld_below(&from, &self.cursors(), &held);
        self.floor = higher_floor(&self.floor, &unheld);
    }

    /// The cursors, their scope and the floor: what the state store persists.
    pub fn current(&self) -> Coverage {
        Coverage {
            synced: self.cursors(),
            local: contiguous(&self.local),
            scope: self.scope.clone(),
            floor: self.floor.clone(),
        }
    }

    pub fn cursors(&self) -> Cursors {
        contiguous(&self.chains)
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

/// Per author, the highest sequence in `(from, to]` this device holds no event for: coverage it
/// claims with no log behind it, which a snapshot install leaves (D46). `held` lists the
/// sequences in that range the log does hold; an author whose whole range is held is absent.
pub fn unheld_below(from: &Cursors, to: &Cursors, held: &Ahead) -> Cursors {
    to.iter()
        .filter_map(|(author, top)| {
            let bottom = from.get(author).map_or(0, |s| s.get());
            let have: BTreeSet<u64> = held
                .get(author)
                .map(|seqs| seqs.iter().map(|s| s.get()).collect())
                .unwrap_or_default();
            let mut at = top.get();
            while at > bottom && have.contains(&at) {
                at -= 1;
            }
            (at > bottom)
                .then(|| SeqNum::parse(at))
                .flatten()
                .map(|seq| (author.clone(), seq))
        })
        .collect()
}

/// Per author, the higher of the two floors: a floor only ever rises.
pub fn higher_floor(a: &Cursors, b: &Cursors) -> Cursors {
    let mut out = a.clone();
    for (author, seq) in b {
        if out.get(author).is_none_or(|held| held < seq) {
            out.insert(author.clone(), *seq);
        }
    }
    out
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
            action: None,
            undo_of: None,
            schema_version: None,
        }
    }

    #[test]
    fn the_cursor_stops_below_a_gap_and_closes_when_it_fills() {
        let mut t = CoverageTracker::default();
        t.note(&event(1, 1), false);
        t.note(&event(1, 3), false);
        assert_eq!(t.cursors()[&peer(1)].get(), 1);
        assert_eq!(t.ahead()[&peer(1)], vec![SeqNum::parse(3).unwrap()]);
        t.note(&event(1, 2), false);
        assert_eq!(t.cursors()[&peer(1)].get(), 3);
        assert!(t.ahead().is_empty());
    }

    #[test]
    fn adopt_raises_never_lowers_and_carries_the_scope() {
        let mut t = CoverageTracker::default();
        t.note(&event(1, 5), false);
        t.note(&event(1, 7), false);
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

    #[test]
    fn a_snapshot_install_raises_the_floor_over_what_the_log_does_not_hold() {
        let mut t = CoverageTracker::default();
        t.note(&event(1, 1), false);
        t.note(&event(1, 4), false);
        t.note(&event(1, 5), false);
        let mut adopted = Coverage::default();
        adopted.synced.insert(peer(1), SeqNum::parse(5).unwrap());
        adopted.synced.insert(peer(2), SeqNum::parse(3).unwrap());
        t.adopt_unheld(&adopted);
        // 4 and 5 are in the log, 2 and 3 are not: the floor is 3; all of peer 2 is unheld
        assert_eq!(t.current().floor[&peer(1)].get(), 3);
        assert_eq!(t.current().floor[&peer(2)].get(), 3);
        // a plain adopt (a pass-over) raises no floor
        adopted.synced.insert(peer(2), SeqNum::parse(9).unwrap());
        t.adopt(&adopted);
        assert_eq!(t.current().floor[&peer(2)].get(), 3);
        // a local-only write is counted apart
        t.note(&event(1, 1), true);
        assert_eq!(t.current().local[&peer(1)].get(), 1);
        assert_eq!(t.cursors()[&peer(1)].get(), 5);
    }
}
