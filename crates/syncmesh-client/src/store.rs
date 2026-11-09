//! Where a device keeps what it holds: the log (`engine/src/store.ts`) and the folded rows
//! (`engine/src/state-store.ts`). Both are ports; the memory pair here is what every test runs on
//! and the SQLite pair behind the `sqlite` feature is what an app ships.
//!
//! Synchronous on purpose. The TypeScript stores are async because their drivers are; a Rust
//! device calls SQLite on the thread it holds the engine on, and a host that wants the work off
//! its UI thread puts the whole engine there (see `driver`).

use std::collections::{BTreeMap, BTreeSet};

use syncmesh_core::event::{Change, PeerId, RowKey, SeqNum, SyncEvent, TableName};
use syncmesh_core::hlc::Hlc;
use syncmesh_core::record::RowRecord;
use syncmesh_core::state::State;

use crate::coverage::higher_floor;

/// Per author, the highest sequence below which a peer holds **every** event — the contiguous half
/// of D13's pair, and the only half anti-entropy can ask a question with.
pub type Cursors = BTreeMap<PeerId, SeqNum>;

/// Per author, the sequences a peer holds *above* its cursor — the far side of a gap. Advisory.
pub type Ahead = BTreeMap<PeerId, Vec<SeqNum>>;

/// Cursors per scope, the interest they are true for (D23), and the floor: per author, the
/// highest sequence this device claims with no event behind it in its log (D46), which a snapshot
/// install leaves. `local` counts this device's own local-only writes, which never travel.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Coverage {
    pub synced: Cursors,
    pub local: Cursors,
    pub scope: Option<String>,
    /// This device's own account of its log, never part of what it claims to a joiner; empty
    /// until a snapshot install adopts coverage the log does not hold.
    pub floor: Cursors,
}

/// What the log keeps for one event: the event, and the exact core bytes the author signed with
/// the signature over them, where this device ever held them. A forwarder ships `core` verbatim —
/// re-encoding a decoded event drops the keys this build ignored, and the author's signature would
/// then cover bytes nobody sent. This crate signs its own writes at `mutate`, so an entry it
/// authored always carries both.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredEvent {
    pub event: SyncEvent,
    pub core: Option<Vec<u8>>,
    pub sig: Option<Vec<u8>>,
    /// A local-only write, written with `Engine::mutate_local`: numbered in its own sequence,
    /// never signed and never sent. Only `mutate_local` sets it: a write to a `local` table
    /// through `Engine::mutate` is never marked, and a validator refuses it (`LocalOnly`).
    pub local: bool,
}

impl StoredEvent {
    /// `peer-seq`, or `peer-Lseq` for a local-only write: the two sequences never share an id.
    pub fn id(&self) -> String {
        syncmesh_core::event::event_id(&self.event.peer_id, self.event.seq_num, self.local)
    }

    /// `[core, sig]` bytes to forward, or `None` when no signature was ever held.
    pub fn envelope(&self) -> Option<Vec<u8>> {
        syncmesh_core::envelope::relay_envelope(
            &self.event,
            self.core.as_deref(),
            self.sig.as_deref(),
        )
    }

    /// The entry a verified envelope becomes.
    pub fn from_verified(v: syncmesh_core::envelope::VerifiedEvent) -> StoredEvent {
        StoredEvent {
            event: v.event,
            core: Some(v.core),
            sig: Some(v.sig),
            local: false,
        }
    }
}

/// A store could not do what it was asked. The log already holds the truth or nothing at all;
/// this is reported, never folded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    pub message: String,
}

impl StoreError {
    pub fn new(message: impl Into<String>) -> StoreError {
        StoreError {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StoreError {}

/// Durable, append-only home of events; the outbox is the log itself (RFC-0004).
pub trait EventStore {
    /// Idempotent by event id.
    fn append(&mut self, entry: &StoredEvent) -> Result<(), StoreError>;
    /// All or nothing where the backend can promise it; idempotent by event id.
    fn append_batch(&mut self, entries: &[StoredEvent]) -> Result<(), StoreError> {
        for entry in entries {
            self.append(entry)?;
        }
        Ok(())
    }
    fn has(&self, id: &str) -> Result<bool, StoreError>;
    /// Every event held, local-only ones included, ordered by author then sequence.
    fn all(&self) -> Result<Vec<StoredEvent>, StoreError>;
    /// Synced events above the given per-author cursors, ordered by author then sequence. Never
    /// a local-only one: this is what a peer is sent.
    fn all_since(&self, cursors: &Cursors) -> Result<Vec<StoredEvent>, StoreError>;
    /// Local-only events above the given cursors, ordered by author then sequence: what a boot
    /// replays above the state store's `local` coverage.
    fn local_since(&self, cursors: &Cursors) -> Result<Vec<StoredEvent>, StoreError>;
    /// Highest synced sequence number this peer has appended, if any.
    fn last_seq(&self, peer: &PeerId) -> Result<Option<SeqNum>, StoreError>;
    /// Highest local-only sequence number this peer has appended, if any.
    fn last_local_seq(&self, peer: &PeerId) -> Result<Option<SeqNum>, StoreError>;
    fn max_hlc(&self) -> Result<Option<Hlc>, StoreError>;
    /// Per author, the floor a snapshot install left below this log's own history
    /// (`EventStore.installedBelow`, gaps U33/U37): rows the state holds with no event here behind
    /// them. Empty until an install records one. Kept with the log, so it outlives a state store
    /// that is deleted or replaced, and a rebuild over it refuses instead of dropping those rows.
    fn installed_below(&self) -> Result<Cursors, StoreError>;
    /// Raises [`EventStore::installed_below`] to `floor`, per author; never lowers it.
    fn record_installed(&mut self, floor: &Cursors) -> Result<(), StoreError>;
}

/// One materialised row on its way to the state store.
#[derive(Debug, Clone, PartialEq)]
pub struct RowWrite {
    pub table: TableName,
    pub key: RowKey,
    pub record: RowRecord,
}

/// Materialised rows and the coverage they reflect, so boot opens state instead of refolding the
/// log. A cache: the log stays the truth.
pub trait StateStore {
    fn is_empty(&self) -> Result<bool, StoreError>;
    /// Every persisted row; an error if any one fails to decode — a partial state is never returned.
    fn load_all(&self) -> Result<State, StoreError>;
    fn load_coverage(&self) -> Result<Coverage, StoreError>;
    /// Rows and coverage land together or not at all.
    fn commit(&mut self, rows: &[RowWrite], coverage: &Coverage) -> Result<(), StoreError>;
    fn clear(&mut self) -> Result<(), StoreError>;
}

/// Every `(table, key)` whose record the events can move. A doc change counts only as a genesis —
/// the one kind that sets a cell — so a document edit never re-runs a live query (RFC-0023 §4.2).
pub fn write_keys_of<'a>(
    events: impl IntoIterator<Item = &'a SyncEvent>,
) -> BTreeMap<TableName, BTreeSet<RowKey>> {
    let mut keys: BTreeMap<TableName, BTreeSet<RowKey>> = BTreeMap::new();
    for event in events {
        for change in &event.changes {
            if matches!(change, Change::Doc(d) if !d.genesis) {
                continue;
            }
            keys.entry(change.table().to_owned())
                .or_default()
                .insert(change.key().to_owned());
        }
    }
    keys
}

/// The records currently held for `keys`; a key with no record is skipped.
pub fn rows_for(state: &State, keys: &BTreeMap<TableName, BTreeSet<RowKey>>) -> Vec<RowWrite> {
    let mut rows = Vec::new();
    for (table, set) in keys {
        let Some(records) = state.tables.get(table) else {
            continue;
        };
        for key in set {
            if let Some(record) = records.get(key) {
                rows.push(RowWrite {
                    table: table.clone(),
                    key: key.clone(),
                    record: record.clone(),
                });
            }
        }
    }
    rows
}

/// The log in memory: what tests run on, and what a device that persists nothing runs on.
#[derive(Debug, Default)]
pub struct MemoryEventStore {
    events: BTreeMap<String, StoredEvent>,
    installed: Cursors,
}

impl MemoryEventStore {
    pub fn new() -> MemoryEventStore {
        MemoryEventStore::default()
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

impl MemoryEventStore {
    fn above(&self, cursors: &Cursors, local: bool) -> Vec<StoredEvent> {
        let mut out: Vec<StoredEvent> = self
            .events
            .values()
            .filter(|e| {
                let at = cursors.get(&e.event.peer_id).map(|s| s.get()).unwrap_or(0);
                e.local == local && e.event.seq_num.get() > at
            })
            .cloned()
            .collect();
        out.sort_by(by_author_then_seq);
        out
    }

    fn last(&self, peer: &PeerId, local: bool) -> Option<SeqNum> {
        self.events
            .values()
            .filter(|e| e.local == local && &e.event.peer_id == peer)
            .map(|e| e.event.seq_num)
            .max()
    }
}

fn by_author_then_seq(a: &StoredEvent, b: &StoredEvent) -> std::cmp::Ordering {
    a.event
        .peer_id
        .cmp(&b.event.peer_id)
        .then(a.local.cmp(&b.local))
        .then(a.event.seq_num.cmp(&b.event.seq_num))
}

impl EventStore for MemoryEventStore {
    fn append(&mut self, entry: &StoredEvent) -> Result<(), StoreError> {
        self.events
            .entry(entry.id())
            .or_insert_with(|| entry.clone());
        Ok(())
    }

    fn has(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self.events.contains_key(id))
    }

    fn all(&self) -> Result<Vec<StoredEvent>, StoreError> {
        let mut all: Vec<StoredEvent> = self.events.values().cloned().collect();
        all.sort_by(by_author_then_seq);
        Ok(all)
    }

    fn all_since(&self, cursors: &Cursors) -> Result<Vec<StoredEvent>, StoreError> {
        Ok(self.above(cursors, false))
    }

    fn local_since(&self, cursors: &Cursors) -> Result<Vec<StoredEvent>, StoreError> {
        Ok(self.above(cursors, true))
    }

    fn last_seq(&self, peer: &PeerId) -> Result<Option<SeqNum>, StoreError> {
        Ok(self.last(peer, false))
    }

    fn last_local_seq(&self, peer: &PeerId) -> Result<Option<SeqNum>, StoreError> {
        Ok(self.last(peer, true))
    }

    fn max_hlc(&self) -> Result<Option<Hlc>, StoreError> {
        Ok(self.events.values().map(|e| e.event.hlc).max())
    }

    fn installed_below(&self) -> Result<Cursors, StoreError> {
        Ok(self.installed.clone())
    }

    fn record_installed(&mut self, floor: &Cursors) -> Result<(), StoreError> {
        self.installed = higher_floor(&self.installed, floor);
        Ok(())
    }
}

/// The folded rows in memory.
#[derive(Debug, Default)]
pub struct MemoryStateStore {
    state: State,
    coverage: Coverage,
}

impl MemoryStateStore {
    pub fn new() -> MemoryStateStore {
        MemoryStateStore::default()
    }
}

impl StateStore for MemoryStateStore {
    fn is_empty(&self) -> Result<bool, StoreError> {
        Ok(self.coverage.synced.is_empty() && self.coverage.local.is_empty())
    }

    fn load_all(&self) -> Result<State, StoreError> {
        Ok(self.state.clone())
    }

    fn load_coverage(&self) -> Result<Coverage, StoreError> {
        Ok(self.coverage.clone())
    }

    fn commit(&mut self, rows: &[RowWrite], coverage: &Coverage) -> Result<(), StoreError> {
        for row in rows {
            self.state
                .tables
                .entry(row.table.clone())
                .or_default()
                .insert(row.key.clone(), row.record.clone());
        }
        self.coverage = coverage.clone();
        Ok(())
    }

    fn clear(&mut self) -> Result<(), StoreError> {
        self.state = State::new();
        self.coverage = Coverage::default();
        Ok(())
    }
}
