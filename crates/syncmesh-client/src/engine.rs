//! The engine (`engine/src/engine.ts`, `writes.ts`, `fold.ts`, `admit.ts`): numbers, signs,
//! appends and folds this device's writes; verifies, dedups, appends and folds everyone else's.
//!
//! Two paths in, one shape: append and state commit first, the fold notification after, so a
//! reader that re-reads a table on notification never sees a row the append went on to lose.
//! Signing happens here rather than in the transport, unlike the TypeScript: an entry this device
//! authored always carries its core and signature, so a forwarder never has to special-case its
//! own writes and a log never holds an own write it cannot send.
//!
//! No validator yet. The TypeScript engine asks a schema-and-policy ladder before it folds; this
//! crate folds what verifies and parks only what it has no fold for (D22-A). A policy port is a
//! later slice, and until then a Rust device trusts the relay's room the way a TypeScript device
//! with no schema does.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

use syncmesh_core::apply::apply_change;
use syncmesh_core::envelope::sign_event;
use syncmesh_core::event::{Change, PartitionKey, PeerId, RowKey, SeqNum, SyncEvent, TableName};
use syncmesh_core::hlc::{DEFAULT_MAX_DRIFT_MS, HlcClock};
use syncmesh_core::identity::Identity;
use syncmesh_core::stamp::Stamp;
use syncmesh_core::state::State;
use syncmesh_core::strategy::MergeSpec;

use crate::coverage::CoverageTracker;
use crate::interest::{Interest, matches_interest};
use crate::store::{
    Ahead, Coverage, Cursors, EventStore, StateStore, StoreError, StoredEvent, rows_for,
    write_keys_of,
};

/// Where a batch came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FoldSource {
    Local,
    Remote,
    Boot,
}

/// One notification per fold, however many events it covered. `write_keys` is exact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoldBatch {
    pub source: FoldSource,
    pub event_count: usize,
    pub write_keys: BTreeMap<TableName, BTreeSet<RowKey>>,
}

impl FoldBatch {
    pub fn write_tables(&self) -> impl Iterator<Item = &TableName> {
        self.write_keys.keys()
    }

    pub fn is_empty(&self) -> bool {
        self.event_count == 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReceiveReport {
    pub folded: usize,
    /// Own events, duplicates within the batch, and events already stored.
    pub skipped: usize,
    /// Parked with no fold for them; never folded, cursor stops below them (D13).
    pub quarantined: usize,
}

/// What a write produced: the signed entry to hand every link, and what it changed.
#[derive(Debug, Clone, PartialEq)]
pub struct Mutated {
    pub entry: StoredEvent,
    pub batch: FoldBatch,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Received {
    pub report: ReceiveReport,
    pub batch: FoldBatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MutateError {
    /// The procedure changed nothing; a write with no changes is not a write.
    Empty {
        procedure: String,
    },
    /// A change this build has no fold for — a definition mistake in the caller, said as a value.
    Unfoldable {
        procedure: String,
    },
    Store(StoreError),
}

impl std::fmt::Display for MutateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MutateError::Empty { procedure } => write!(f, "{procedure} changed nothing"),
            MutateError::Unfoldable { procedure } => {
                write!(f, "{procedure} wrote a change this build has no fold for")
            }
            MutateError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for MutateError {}

impl From<StoreError> for MutateError {
    fn from(e: StoreError) -> Self {
        MutateError::Store(e)
    }
}

/// What one peer was last acknowledged as holding, and when (epoch ms of this device's clock).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ack {
    pub cursors: Cursors,
    pub at_ms: i64,
}

pub type NowMs = Box<dyn Fn() -> i64 + Send>;

pub struct EngineOptions {
    /// Per table and column, how concurrent writes merge; anything unnamed is `lww`.
    pub merge: Option<MergeSpec>,
    /// How far ahead of this device's clock a stamp may run before it is not believed (D34).
    pub max_drift_ms: Option<i64>,
    /// The wall clock, injectable for tests. Default: the system clock in epoch milliseconds.
    pub now_ms: Option<NowMs>,
    /// Parked events kept before the oldest is dropped. Default 1000.
    pub quarantine_limit: usize,
}

impl Default for EngineOptions {
    fn default() -> Self {
        EngineOptions {
            merge: None,
            max_drift_ms: Some(DEFAULT_MAX_DRIFT_MS),
            now_ms: None,
            quarantine_limit: 1000,
        }
    }
}

fn system_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub struct Engine {
    identity: Identity,
    clock: HlcClock,
    now_ms: NowMs,
    store: Box<dyn EventStore + Send>,
    state_store: Option<Box<dyn StateStore + Send>>,
    state: State,
    coverage: CoverageTracker,
    merge: Option<MergeSpec>,
    acks: BTreeMap<PeerId, Ack>,
    parked: Vec<StoredEvent>,
    quarantine_limit: usize,
}

impl Engine {
    /// Opens the engine over its stores: loads the materialised rows where there are any, replays
    /// the log above them, and moves the clock past every stored stamp so a write numbered now
    /// sorts after everything already held (D05).
    pub fn open(
        identity: Identity,
        store: Box<dyn EventStore + Send>,
        state_store: Option<Box<dyn StateStore + Send>>,
        options: EngineOptions,
    ) -> Result<Engine, StoreError> {
        let (state, coverage) = match &state_store {
            Some(s) if !s.is_empty()? => (s.load_all()?, s.load_coverage()?),
            _ => (State::new(), Coverage::default()),
        };
        let mut clock = HlcClock::new(options.max_drift_ms);
        let now_ms = options.now_ms.unwrap_or_else(|| Box::new(system_now_ms));
        if let Some(max) = store.max_hlc()? {
            // not clamped: these are stamps this device already holds and has already believed
            clock.receive(max, i64::MAX / 2);
        }
        let mut engine = Engine {
            identity,
            clock,
            now_ms,
            store,
            state_store,
            state,
            coverage: CoverageTracker::new(&coverage),
            merge: options.merge,
            acks: BTreeMap::new(),
            parked: Vec::new(),
            quarantine_limit: options.quarantine_limit,
        };
        let replay = engine.store.all_since(&coverage.synced)?;
        let batch = engine.fold(&replay, FoldSource::Boot);
        engine.persist(&batch)?;
        Ok(engine)
    }

    pub fn peer_id(&self) -> &PeerId {
        self.identity.peer_id()
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    pub fn state(&self) -> &State {
        &self.state
    }

    pub fn now_ms(&self) -> i64 {
        (self.now_ms)()
    }

    /// Stamps, numbers, signs, appends and folds one write. Real once appended; the returned entry
    /// is what every link sends.
    pub fn mutate(
        &mut self,
        procedure: &str,
        changes: Vec<Change>,
        partition: Option<PartitionKey>,
    ) -> Result<Mutated, MutateError> {
        if changes.is_empty() {
            return Err(MutateError::Empty {
                procedure: procedure.to_owned(),
            });
        }
        if changes.iter().any(|c| matches!(c, Change::Unknown { .. })) {
            return Err(MutateError::Unfoldable {
                procedure: procedure.to_owned(),
            });
        }
        let hlc = self.clock.tick(self.now_ms());
        let last = self.store.last_seq(self.identity.peer_id())?;
        let seq_num = SeqNum::parse(last.map(|s| s.get()).unwrap_or(0) + 1)
            .ok_or_else(|| StoreError::new("the sequence space is exhausted"))?;
        let event = SyncEvent {
            peer_id: self.identity.peer_id().clone(),
            seq_num,
            hlc,
            procedure: procedure.to_owned(),
            partition,
            changes,
            sealed: false,
        };
        let entry = StoredEvent::from_verified(sign_event(event, &self.identity));
        self.store.append(&entry)?;
        let batch = self.fold(std::slice::from_ref(&entry), FoldSource::Local);
        self.persist(&batch)?;
        Ok(Mutated { entry, batch })
    }

    /// Folds entries from other peers once each; own and already-stored events are skipped, and
    /// events this build has no fold for are parked with the author's cursor stopped below them.
    pub fn receive_batch(&mut self, entries: Vec<StoredEvent>) -> Result<Received, StoreError> {
        let total = entries.len();
        let mut fresh: Vec<StoredEvent> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut quarantined = 0;
        for entry in entries {
            let id = entry.id();
            if &entry.event.peer_id == self.identity.peer_id() || !seen.insert(id.clone()) {
                continue;
            }
            if self.store.has(&id)? {
                continue;
            }
            if entry
                .event
                .changes
                .iter()
                .any(|c| matches!(c, Change::Unknown { .. }))
            {
                quarantined += 1;
                self.park(entry);
                continue;
            }
            fresh.push(entry);
        }
        let now = self.now_ms();
        for entry in &fresh {
            self.clock.receive(entry.event.hlc, now);
        }
        self.store.append_batch(&fresh)?;
        let batch = self.fold(&fresh, FoldSource::Remote);
        self.persist(&batch)?;
        Ok(Received {
            report: ReceiveReport {
                folded: fresh.len(),
                skipped: total - fresh.len() - quarantined,
                quarantined,
            },
            batch,
        })
    }

    pub fn receive(&mut self, entry: StoredEvent) -> Result<Received, StoreError> {
        self.receive_batch(vec![entry])
    }

    fn park(&mut self, entry: StoredEvent) {
        if self.parked.iter().any(|p| p.id() == entry.id()) {
            return;
        }
        self.parked.push(entry);
        if self.parked.len() > self.quarantine_limit {
            self.parked.remove(0);
        }
    }

    /// The events this build could not take, with the bytes they arrived as (D13).
    pub fn quarantine(&self) -> &[StoredEvent] {
        &self.parked
    }

    /// Re-offers every parked event to the ordinary receive path — what an app calls after an
    /// update. What the build still cannot fold is parked again.
    pub fn retry_quarantined(&mut self) -> Result<Received, StoreError> {
        let parked = std::mem::take(&mut self.parked);
        self.receive_batch(parked)
    }

    fn fold(&mut self, entries: &[StoredEvent], source: FoldSource) -> FoldBatch {
        let write_keys = write_keys_of(entries.iter().map(|e| &e.event));
        for entry in entries {
            let event = &entry.event;
            self.coverage.note(event);
            let stamp = Stamp::new(event.hlc, event.peer_id.clone());
            for change in &event.changes {
                // an unknown change was parked before it reached here; the fold has nothing to do
                let _ = apply_change(
                    &mut self.state,
                    change,
                    &stamp,
                    self.merge.as_ref(),
                    event.partition.as_ref(),
                );
            }
        }
        FoldBatch {
            source,
            event_count: entries.len(),
            write_keys,
        }
    }

    fn persist(&mut self, batch: &FoldBatch) -> Result<(), StoreError> {
        if batch.event_count == 0 {
            return Ok(());
        }
        let Some(store) = self.state_store.as_mut() else {
            return Ok(());
        };
        let rows = rows_for(&self.state, &batch.write_keys);
        store.commit(&rows, &self.coverage.current())
    }

    /// The visible rows of `table` that belong to `partition`.
    pub fn rows_in(
        &self,
        table: &str,
        partition: &PartitionKey,
    ) -> BTreeMap<RowKey, syncmesh_core::record::Row> {
        self.state.read_rows_in(table, partition)
    }

    /// The delete currently hiding the row — `None` for a visible row and for one never held.
    pub fn deleted_at(&self, table: &str, key: &str) -> Option<&Stamp> {
        let record = self.state.record(table, key)?;
        if record.is_visible() {
            None
        } else {
            record.delete_stamp.as_ref()
        }
    }

    /// Per author, the highest sequence below which this engine holds **every** event.
    pub fn cursors(&self) -> Cursors {
        self.coverage.cursors()
    }

    /// Per author, what this device has **folded** above that cursor — the far side of a gap.
    pub fn ahead(&self) -> Ahead {
        self.coverage.ahead()
    }

    /// Every sequence above the cursor this device has the bytes for: folded past a gap, or parked
    /// below one. What a receiver walks an author's run with.
    pub fn holding(&self) -> Ahead {
        let mut merged = self.coverage.ahead();
        for entry in &self.parked {
            merged
                .entry(entry.event.peer_id.clone())
                .or_default()
                .push(entry.event.seq_num);
        }
        for seqs in merged.values_mut() {
            seqs.sort();
            seqs.dedup();
        }
        merged
    }

    pub fn coverage(&self) -> Coverage {
        self.coverage.current()
    }

    /// Takes on a coverage that events already folded stand for (D23).
    pub fn adopt_coverage(&mut self, coverage: &Coverage) {
        self.coverage.adopt(coverage);
        if let Some(store) = self.state_store.as_mut() {
            // a coverage is a fact about the log worth keeping across a restart; a failure here
            // costs a re-page, not a row
            let _ = store.commit(&[], &self.coverage.current());
        }
    }

    /// Records what `peer` holds, as of `at_ms`; links call it on every cursor exchange.
    pub fn acknowledge(&mut self, peer: PeerId, cursors: Cursors, at_ms: i64) {
        self.acks.insert(peer, Ack { cursors, at_ms });
    }

    pub fn acks(&self) -> &BTreeMap<PeerId, Ack> {
        &self.acks
    }

    /// Events the holder of `theirs` lacks, narrowed to what they asked for. The filter runs at
    /// the sender so an uninterested event never becomes bytes.
    pub fn events_since(
        &self,
        theirs: &Cursors,
        interest: Option<&Interest>,
    ) -> Result<Vec<StoredEvent>, StoreError> {
        let mut entries = self.store.all_since(theirs)?;
        if interest.is_some() {
            entries.retain(|e| matches_interest(interest, &e.event));
        }
        Ok(entries)
    }

    /// Every event held, by author then sequence.
    pub fn all_events(&self) -> Result<Vec<StoredEvent>, StoreError> {
        self.store.all()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{MemoryEventStore, MemoryStateStore};
    use syncmesh_core::record::CellValue;

    fn identity(n: u8) -> Identity {
        Identity::from_seed(&[n; 32])
    }

    fn engine(n: u8) -> Engine {
        Engine::open(
            identity(n),
            Box::new(MemoryEventStore::new()),
            None,
            EngineOptions::default(),
        )
        .unwrap()
    }

    fn insert(key: &str, body: &str) -> Change {
        let mut row = BTreeMap::new();
        row.insert("body".to_owned(), CellValue::text(body));
        Change::Insert {
            table: "notes".into(),
            key: key.into(),
            row,
        }
    }

    #[test]
    fn a_write_is_numbered_signed_folded_and_reported() {
        let mut a = engine(1);
        let out = a
            .mutate("notes.create", vec![insert("n1", "hello")], None)
            .unwrap();
        assert_eq!(out.entry.event.seq_num.get(), 1);
        assert!(out.entry.sig.is_some());
        assert_eq!(out.batch.source, FoldSource::Local);
        assert!(out.batch.write_keys["notes"].contains("n1"));
        assert_eq!(
            a.state().read_row("notes", "n1").unwrap()["body"],
            CellValue::text("hello")
        );
        assert_eq!(a.cursors()[a.peer_id()].get(), 1);
        assert!(matches!(
            a.mutate("notes.nothing", vec![], None),
            Err(MutateError::Empty { .. })
        ));
        let second = a
            .mutate("notes.create", vec![insert("n2", "again")], None)
            .unwrap();
        assert_eq!(second.entry.event.seq_num.get(), 2);
        assert!(second.entry.event.hlc > out.entry.event.hlc);
    }

    #[test]
    fn a_peers_events_fold_once_and_own_ones_are_skipped() {
        let mut a = engine(1);
        let mut b = engine(2);
        let written = a
            .mutate("notes.create", vec![insert("n1", "from a")], None)
            .unwrap();
        let wire = written.entry.envelope().unwrap();
        let verified = StoredEvent::from_verified(syncmesh_core::decode_and_verify(&wire).unwrap());
        let first = b
            .receive_batch(vec![verified.clone(), verified.clone()])
            .unwrap();
        assert_eq!(
            first.report,
            ReceiveReport {
                folded: 1,
                skipped: 1,
                quarantined: 0
            }
        );
        assert_eq!(
            b.state().read_row("notes", "n1").unwrap()["body"],
            CellValue::text("from a")
        );
        let again = b.receive(verified.clone()).unwrap();
        assert_eq!(again.report.folded, 0);
        assert_eq!(again.report.skipped, 1);
        let own = a.receive(written.entry.clone()).unwrap();
        assert_eq!(own.report.skipped, 1);
        // b forwards a's bytes verbatim
        assert_eq!(
            b.events_since(&Cursors::new(), None).unwrap()[0]
                .envelope()
                .unwrap(),
            wire
        );
    }

    #[test]
    fn the_cursor_stops_below_a_gap_and_unknown_changes_are_parked() {
        let mut a = engine(1);
        let mut b = engine(2);
        let e1 = a.mutate("t", vec![insert("1", "x")], None).unwrap().entry;
        let _e2 = a.mutate("t", vec![insert("2", "x")], None).unwrap().entry;
        let e3 = a.mutate("t", vec![insert("3", "x")], None).unwrap().entry;
        b.receive_batch(vec![e1, e3]).unwrap();
        assert_eq!(b.cursors()[a.peer_id()].get(), 1);
        assert_eq!(b.ahead()[a.peer_id()].len(), 1);
        let mut odd = a.mutate("t", vec![insert("4", "x")], None).unwrap().entry;
        odd.event.changes = vec![Change::Unknown {
            tag: 9,
            table: "notes".into(),
            key: "4".into(),
            data: None,
        }];
        let parked = b.receive(odd).unwrap();
        assert_eq!(parked.report.quarantined, 1);
        assert_eq!(b.quarantine().len(), 1);
        assert_eq!(b.holding()[a.peer_id()].len(), 2);
    }

    #[test]
    fn boot_reopens_from_the_state_store_and_replays_the_log_above_it() {
        let mut log = MemoryEventStore::new();
        let mut rows = MemoryStateStore::new();
        {
            let mut a = engine(1);
            let e1 = a.mutate("t", vec![insert("1", "x")], None).unwrap().entry;
            let e2 = a.mutate("t", vec![insert("2", "y")], None).unwrap().entry;
            log.append(&e1).unwrap();
            // rows and coverage as if a previous run had folded only e1
            let mut b = Engine::open(
                identity(2),
                Box::new(MemoryEventStore::new()),
                None,
                EngineOptions::default(),
            )
            .unwrap();
            let folded = b.receive(e1.clone()).unwrap();
            rows.commit(
                &rows_for(b.state(), &folded.batch.write_keys),
                &b.coverage(),
            )
            .unwrap();
            log.append(&e2).unwrap();
        }
        let reopened = Engine::open(
            identity(2),
            Box::new(log),
            Some(Box::new(rows)),
            EngineOptions::default(),
        )
        .unwrap();
        assert!(reopened.state().read_row("notes", "1").is_some());
        assert!(reopened.state().read_row("notes", "2").is_some());
        assert_eq!(reopened.cursors()[identity(1).peer_id()].get(), 2);
    }

    #[test]
    fn a_new_write_sorts_after_every_stamp_already_held() {
        let far_future = 4_000_000_000_000i64;
        let mut a = Engine::open(
            identity(1),
            Box::new(MemoryEventStore::new()),
            None,
            EngineOptions {
                now_ms: Some(Box::new(move || far_future)),
                ..EngineOptions::default()
            },
        )
        .unwrap();
        let ahead = a.mutate("t", vec![insert("1", "x")], None).unwrap().entry;
        let mut b = Engine::open(
            identity(2),
            Box::new(MemoryEventStore::new()),
            None,
            EngineOptions {
                now_ms: Some(Box::new(|| 1_700_000_000_000)),
                ..EngineOptions::default()
            },
        )
        .unwrap();
        b.receive(ahead.clone()).unwrap();
        let mine = b.mutate("t", vec![insert("2", "y")], None).unwrap().entry;
        // D34: the remote stamp is believed only up to the drift bound, and the write lands above it
        assert!(mine.event.hlc.ms <= 1_700_000_000_000 + DEFAULT_MAX_DRIFT_MS);
        assert!(mine.event.hlc.ms >= 1_700_000_000_000);
    }
}
