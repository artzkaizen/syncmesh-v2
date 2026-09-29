//! Out-of-order holdback, per author (`transport/src/holdback.ts`): the gap rule.
//!
//! A relayed frame can overtake the one before it, and a page can end on a hole the next page
//! fills. Folding what arrives in the order it arrives would be fine for the rows — the fold is
//! order independent — but not for the cursor: a cursor that jumped a hole would tell every peer
//! this device holds an event it never saw, and nothing would ever offer it again. So an event
//! above the author's run waits here, and is released the moment the run reaches it.
//!
//! Bounded. A buffer past `gap_limit` is a hole nobody is filling — a lost frame, or a run this
//! device fell off — and the honest repair is a fresh join from the contiguous position, which
//! the caller does when `put` says so.

use std::collections::BTreeMap;

use syncmesh_core::event::PeerId;

use crate::engine::Engine;
use crate::store::StoredEvent;

#[derive(Debug)]
pub struct Holdback {
    gap_limit: usize,
    held: BTreeMap<PeerId, BTreeMap<u64, StoredEvent>>,
}

impl Holdback {
    pub fn new(gap_limit: usize) -> Holdback {
        Holdback {
            gap_limit,
            held: BTreeMap::new(),
        }
    }

    /// How far this device **holds** an author's run without a hole: its contiguous cursor, then
    /// every sequence above it `engine.holding()` names — folded past a gap, or parked below one
    /// (D13).
    ///
    /// The cursor alone is not that number. A parked event is held but never folded, so the
    /// cursor stops below it for as long as the quarantine keeps it — which for a refusal no
    /// upgrade reverses is forever. Draining from the cursor would hold back every later event
    /// from that author permanently, overflow into a rejoin, and re-page the same run on every
    /// reconnect. The cursor still stops below it on the wire, so peers keep offering the event.
    fn through(&self, author: &PeerId, engine: &Engine) -> u64 {
        let mut at = engine.cursors().get(author).map(|s| s.get()).unwrap_or(0);
        let holding = engine.holding();
        let ahead: Vec<u64> = holding
            .get(author)
            .map(|seqs| seqs.iter().map(|s| s.get()).collect())
            .unwrap_or_default();
        while ahead.contains(&(at + 1)) {
            at += 1;
        }
        at
    }

    /// Buffers the entry; `true` when the buffer overflowed and a resync must take over. One at
    /// or below what the engine already holds is not buffered: the engine's dedup is the right
    /// place for it and the holdback would only stall behind it.
    ///
    /// Own events take the gap rule like everyone else's (G7). A device only ever hears its own
    /// events back when its log lost them, and then they are the run it has to rebuild, in
    /// order, before its cursor for itself can say it holds them.
    pub fn put(&mut self, entry: StoredEvent, engine: &Engine) -> bool {
        let author = entry.event.peer_id.clone();
        let seq = entry.event.seq_num.get();
        if seq <= self.through(&author, engine) {
            return false;
        }
        let buffer = self.held.entry(author.clone()).or_default();
        buffer.insert(seq, entry);
        if buffer.len() > self.gap_limit {
            self.held.remove(&author);
            return true;
        }
        false
    }

    /// Everything buffered for `author` at or below `at`, in run order — what a coverage about to
    /// be adopted is going to claim this device holds (D23).
    ///
    /// A gap inside that range is not a reason to keep holding: the coverage is precisely the
    /// statement that nothing will ever fill it, so the events either side of it are all that is
    /// coming. They have to be folded *before* the cursor moves past them, or the claim outruns
    /// what this device actually has.
    pub fn up_to(&mut self, author: &PeerId, at: u64) -> Vec<StoredEvent> {
        let Some(buffer) = self.held.get_mut(author) else {
            return Vec::new();
        };
        let ready_seqs: Vec<u64> = buffer.range(..=at).map(|(&s, _)| s).collect();
        let ready: Vec<StoredEvent> = ready_seqs.iter().filter_map(|s| buffer.remove(s)).collect();
        if buffer.is_empty() {
            self.held.remove(author);
        }
        ready
    }

    /// The contiguous run above what the engine holds, in order.
    pub fn drain(&mut self, author: &PeerId, engine: &Engine) -> Vec<StoredEvent> {
        let mut next = self.through(author, engine) + 1;
        let Some(buffer) = self.held.get_mut(author) else {
            return Vec::new();
        };
        let mut ready = Vec::new();
        while let Some(entry) = buffer.remove(&next) {
            ready.push(entry);
            next += 1;
        }
        if buffer.is_empty() {
            self.held.remove(author);
        }
        ready
    }

    /// How many events are waiting for `author`'s run to reach them.
    pub fn waiting(&self, author: &PeerId) -> usize {
        self.held.get(author).map_or(0, BTreeMap::len)
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::EngineOptions;
    use crate::store::MemoryEventStore;
    use std::collections::BTreeMap as Map;
    use syncmesh_core::event::Change;
    use syncmesh_core::identity::Identity;
    use syncmesh_core::record::CellValue;

    fn engine(n: u8) -> Engine {
        Engine::open(
            Identity::from_seed(&[n; 32]),
            Box::new(MemoryEventStore::new()),
            None,
            EngineOptions::default(),
        )
        .unwrap()
    }

    fn write(a: &mut Engine, key: &str) -> StoredEvent {
        let mut row = Map::new();
        row.insert("body".to_owned(), CellValue::text(key));
        a.mutate(
            "t",
            vec![Change::Insert {
                table: "notes".into(),
                key: key.into(),
                row,
            }],
            None,
        )
        .unwrap()
        .entry
    }

    #[test]
    fn events_wait_for_the_run_and_leave_in_order() {
        let mut a = engine(1);
        let mut b = engine(2);
        let e1 = write(&mut a, "1");
        let e2 = write(&mut a, "2");
        let e3 = write(&mut a, "3");
        let mut hold = Holdback::new(8);
        assert!(!hold.put(e3.clone(), &b));
        assert!(!hold.put(e2.clone(), &b));
        assert!(hold.drain(a.peer_id(), &b).is_empty());
        assert_eq!(hold.waiting(a.peer_id()), 2);
        assert!(!hold.put(e1.clone(), &b));
        let run = hold.drain(a.peer_id(), &b);
        assert_eq!(
            run.iter()
                .map(|e| e.event.seq_num.get())
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(hold.is_empty());
        b.receive_batch(run).unwrap();
        // already held: not buffered
        assert!(!hold.put(e2, &b));
        assert!(hold.is_empty());
        // own events are never buffered
        let own = write(&mut b, "x");
        assert!(!hold.put(own, &b));
        assert!(hold.is_empty());
    }

    #[test]
    fn a_hole_past_the_limit_overflows_and_up_to_ignores_holes() {
        let mut a = engine(1);
        let b = engine(2);
        let _e1 = write(&mut a, "1");
        let e2 = write(&mut a, "2");
        let e3 = write(&mut a, "3");
        let e4 = write(&mut a, "4");
        let e5 = write(&mut a, "5");
        let mut hold = Holdback::new(2);
        assert!(!hold.put(e2.clone(), &b));
        assert!(!hold.put(e4.clone(), &b));
        assert!(hold.put(e5.clone(), &b));
        assert!(hold.is_empty());
        hold.put(e2, &b);
        hold.put(e4, &b);
        let held = hold.up_to(a.peer_id(), 4);
        assert_eq!(
            held.iter()
                .map(|e| e.event.seq_num.get())
                .collect::<Vec<_>>(),
            vec![2, 4]
        );
        assert!(hold.is_empty());
        drop(e3);
    }
}
