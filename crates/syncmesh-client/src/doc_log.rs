//! The doc log and heads (`engine/src/doc-log.ts`, RFC-0023 §6.2): one entry per doc change,
//! indexing the update **by reference** — the bytes stay in the signed core — and one head per
//! document saying where its column snapshot stands.
//!
//! An entry's state is local bookkeeping, never part of what folds or what a digest covers: two
//! peers holding the same events hold the same entries, and label them by which adapters and blobs
//! each has. That is the whole of the `adapter-missing` mode a device with no adapter runs.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};
use syncmesh_core::doc::{DocUpdate, Id16, doc_change_id};
use syncmesh_core::event::{Change, PeerId, SeqNum, SyncEvent};
use syncmesh_core::hex::to_hex;
use syncmesh_core::hlc::Hlc;

use crate::store::{Cursors, StoreError};

/// Where one doc change stands on this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DocEntryState {
    /// The adapter is here and the update is not yet in the column's snapshot.
    Tail,
    /// A persisted snapshot holds it; compaction may take its event (§8.3).
    Covered,
    /// Blob-carried, and the blob has not landed.
    BytesMissing,
    /// It names a lineage that does not win (§5.3): kept, never applied.
    Orphaned,
    /// The adapter could not import it (§10).
    Failed,
    /// This build has no adapter for the column's id: it folds and forwards (§10).
    AdapterMissing,
}

impl DocEntryState {
    pub fn as_str(self) -> &'static str {
        match self {
            DocEntryState::Tail => "tail",
            DocEntryState::Covered => "covered",
            DocEntryState::BytesMissing => "bytes-missing",
            DocEntryState::Orphaned => "orphaned",
            DocEntryState::Failed => "failed",
            DocEntryState::AdapterMissing => "adapter-missing",
        }
    }

    pub fn parse(s: &str) -> Option<DocEntryState> {
        Some(match s {
            "tail" => DocEntryState::Tail,
            "covered" => DocEntryState::Covered,
            "bytes-missing" => DocEntryState::BytesMissing,
            "orphaned" => DocEntryState::Orphaned,
            "failed" => DocEntryState::Failed,
            "adapter-missing" => DocEntryState::AdapterMissing,
            _ => return None,
        })
    }

    /// Live on the winner, `orphaned` off it: the states a lineage change moves between.
    fn is_live(self) -> bool {
        matches!(
            self,
            DocEntryState::Tail
                | DocEntryState::Covered
                | DocEntryState::BytesMissing
                | DocEntryState::AdapterMissing
        )
    }

    /// Part of the tail a head counts: live, and not yet in the snapshot.
    pub fn in_tail(self) -> bool {
        matches!(
            self,
            DocEntryState::Tail | DocEntryState::BytesMissing | DocEntryState::AdapterMissing
        )
    }
}

/// How the column's snapshot is kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocHeadMode {
    Materialised,
    Checkpoint,
    None,
}

impl DocHeadMode {
    pub fn as_str(self) -> &'static str {
        match self {
            DocHeadMode::Materialised => "materialised",
            DocHeadMode::Checkpoint => "checkpoint",
            DocHeadMode::None => "none",
        }
    }

    pub fn parse(s: &str) -> Option<DocHeadMode> {
        Some(match s {
            "materialised" => DocHeadMode::Materialised,
            "checkpoint" => DocHeadMode::Checkpoint,
            "none" => DocHeadMode::None,
            _ => return None,
        })
    }
}

/// Which document: a row's key and one of its doc columns.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DocAddress {
    pub table: String,
    pub key: String,
    pub column: String,
}

/// One doc-log row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocLogEntry {
    pub doc: DocAddress,
    pub author: PeerId,
    pub seq: SeqNum,
    /// The change's position in its event.
    pub index: u32,
    /// `None` is the root lineage.
    pub lineage: Option<Id16>,
    pub hlc: Hlc,
    pub action: Option<Id16>,
    pub undo_of: Option<Id16>,
    /// The blob's hash as lowercase hex when the update is blob-carried.
    pub blob: Option<String>,
    pub size: u64,
    pub state: DocEntryState,
}

impl DocLogEntry {
    /// `(author, seq, index)` — the log's key.
    pub fn position(&self) -> (&PeerId, SeqNum, u32) {
        (&self.author, self.seq, self.index)
    }
}

/// One head: where a document's column snapshot stands against its log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocHead {
    pub doc: DocAddress,
    pub adapter: String,
    pub lineage: Option<Id16>,
    /// The snapshot's floor: every doc change of this document at or below these is in it.
    pub covers: Cursors,
    pub version: Option<Vec<u8>>,
    pub tail_count: u64,
    pub tail_bytes: u64,
    pub mode: DocHeadMode,
    pub materialised_at: Option<i64>,
}

/// The state a live entry takes here: `adapter-missing` without the adapter, otherwise `tail` —
/// or `bytes-missing` for a blob-carried update until its blob lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiveStates {
    pub inline: DocEntryState,
    pub blob: DocEntryState,
}

pub fn live_states(has_adapter: bool) -> LiveStates {
    if has_adapter {
        LiveStates {
            inline: DocEntryState::Tail,
            blob: DocEntryState::BytesMissing,
        }
    } else {
        LiveStates {
            inline: DocEntryState::AdapterMissing,
            blob: DocEntryState::AdapterMissing,
        }
    }
}

/// The state an entry moves to when `winner` is the lineage that wins.
pub fn next_state(entry: &DocLogEntry, winner: Option<Id16>, live: LiveStates) -> DocEntryState {
    let on_winner = entry.lineage == winner;
    if !on_winner && entry.state.is_live() {
        return DocEntryState::Orphaned;
    }
    if on_winner && entry.state == DocEntryState::Orphaned {
        return if entry.blob.is_none() {
            live.inline
        } else {
            live.blob
        };
    }
    entry.state
}

/// The doc log and the heads beside it (RFC-0023 §6.2).
pub trait DocStore {
    /// Idempotent by `(author, seq, index)`.
    fn append(&mut self, entries: &[DocLogEntry]) -> Result<(), StoreError>;
    /// Every entry, by author, sequence and index.
    fn entries(&self) -> Result<Vec<DocLogEntry>, StoreError>;
    /// One document's entries, in the same order.
    fn entries_of(&self, doc: &DocAddress) -> Result<Vec<DocLogEntry>, StoreError>;
    /// Moves one entry to `state`.
    fn set_state(
        &mut self,
        author: &PeerId,
        seq: SeqNum,
        index: u32,
        state: DocEntryState,
    ) -> Result<(), StoreError>;
    /// Upserts a head's adapter, lineage and tail; a snapshot it already records is kept.
    fn upsert_head(
        &mut self,
        doc: &DocAddress,
        adapter: &str,
        lineage: Option<Id16>,
        tail_count: u64,
        tail_bytes: u64,
    ) -> Result<(), StoreError>;
    fn heads(&self) -> Result<Vec<DocHead>, StoreError>;
    /// Per author, the sequence just below the lowest entry no snapshot covers — the floor
    /// compaction may not pass (§8.3). An author with none is absent.
    fn uncovered_floor(&self) -> Result<BTreeMap<PeerId, u64>, StoreError>;
}

/// The doc log in memory: what an engine with no database keeps.
#[derive(Debug, Default)]
pub struct MemoryDocStore {
    log: BTreeMap<(PeerId, SeqNum, u32), DocLogEntry>,
    heads: BTreeMap<DocAddress, DocHead>,
}

impl MemoryDocStore {
    pub fn new() -> MemoryDocStore {
        MemoryDocStore::default()
    }
}

impl DocStore for MemoryDocStore {
    fn append(&mut self, entries: &[DocLogEntry]) -> Result<(), StoreError> {
        for e in entries {
            self.log
                .entry((e.author.clone(), e.seq, e.index))
                .or_insert_with(|| e.clone());
        }
        Ok(())
    }

    fn entries(&self) -> Result<Vec<DocLogEntry>, StoreError> {
        Ok(self.log.values().cloned().collect())
    }

    fn entries_of(&self, doc: &DocAddress) -> Result<Vec<DocLogEntry>, StoreError> {
        Ok(self
            .log
            .values()
            .filter(|e| &e.doc == doc)
            .cloned()
            .collect())
    }

    fn set_state(
        &mut self,
        author: &PeerId,
        seq: SeqNum,
        index: u32,
        state: DocEntryState,
    ) -> Result<(), StoreError> {
        if let Some(e) = self.log.get_mut(&(author.clone(), seq, index)) {
            e.state = state;
        }
        Ok(())
    }

    fn upsert_head(
        &mut self,
        doc: &DocAddress,
        adapter: &str,
        lineage: Option<Id16>,
        tail_count: u64,
        tail_bytes: u64,
    ) -> Result<(), StoreError> {
        let head = self.heads.entry(doc.clone()).or_insert_with(|| DocHead {
            doc: doc.clone(),
            adapter: adapter.to_owned(),
            lineage,
            covers: Cursors::new(),
            version: None,
            tail_count,
            tail_bytes,
            mode: DocHeadMode::None,
            materialised_at: None,
        });
        head.adapter = adapter.to_owned();
        head.lineage = lineage;
        head.tail_count = tail_count;
        head.tail_bytes = tail_bytes;
        Ok(())
    }

    fn heads(&self) -> Result<Vec<DocHead>, StoreError> {
        Ok(self.heads.values().cloned().collect())
    }

    fn uncovered_floor(&self) -> Result<BTreeMap<PeerId, u64>, StoreError> {
        let mut floor: BTreeMap<PeerId, u64> = BTreeMap::new();
        for e in self
            .log
            .values()
            .filter(|e| e.state != DocEntryState::Covered)
        {
            let below = e.seq.get() - 1;
            let held = floor.entry(e.author.clone()).or_insert(below);
            *held = (*held).min(below);
        }
        Ok(floor)
    }
}

/// What a fold appends for one doc change: the entry, and the adapter its change named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocAppend {
    pub entry: DocLogEntry,
    pub adapter: String,
}

/// Every doc change in the events, as the entries a fold appends, in event and change order.
pub fn doc_appends<'a>(
    events: impl IntoIterator<Item = &'a SyncEvent>,
    has_adapter: impl Fn(&str) -> bool,
) -> Vec<DocAppend> {
    let mut out = Vec::new();
    for event in events {
        for (index, change) in event.changes.iter().enumerate() {
            let Change::Doc(d) = change else { continue };
            let live = live_states(has_adapter(&d.adapter));
            let (blob, state) = match &d.update {
                DocUpdate::Bytes(_) => (None, live.inline),
                DocUpdate::Blob(r) => (Some(to_hex(&r.hash)), live.blob),
            };
            out.push(DocAppend {
                entry: DocLogEntry {
                    doc: DocAddress {
                        table: d.table.clone(),
                        key: d.key.clone(),
                        column: d.column.clone(),
                    },
                    author: event.peer_id.clone(),
                    seq: event.seq_num,
                    index: u32::try_from(index).unwrap_or(u32::MAX),
                    lineage: d.lineage,
                    hlc: event.hlc,
                    action: event.action,
                    undo_of: event.undo_of,
                    blob,
                    size: d.update.size(),
                    state,
                },
                adapter: d.adapter.clone(),
            });
        }
    }
    out
}

/// One doc change's contribution: the first 8 bytes of `sha256(doc_change_id)`, big-endian.
pub fn doc_change_digest(author: &PeerId, seq: SeqNum, index: u32) -> u64 {
    let hash = Sha256::digest(doc_change_id(author, seq, index));
    u64::from_be_bytes(hash[..8].try_into().expect("a sha-256 is 32 bytes"))
}

/// Per document, the sum mod 2^64 of its doc changes' digests (RFC-0023 §6.4): over ids only, so a
/// peer with the adapter and one without agree whenever they hold the same events.
pub fn doc_digests<'a>(
    entries: impl IntoIterator<Item = &'a DocLogEntry>,
) -> BTreeMap<DocAddress, u64> {
    let mut out: BTreeMap<DocAddress, u64> = BTreeMap::new();
    for e in entries {
        let sum = out.entry(e.doc.clone()).or_insert(0);
        *sum = sum.wrapping_add(doc_change_digest(&e.author, e.seq, e.index));
    }
    out
}

/// Appends a fold's doc entries and brings each touched document's labels and head up to date —
/// the doc log's half of the persist step. Re-running it is harmless: the append is idempotent
/// and the rest is recomputed from what is held.
pub fn record_docs(
    store: &mut dyn DocStore,
    appends: &[DocAppend],
    winner_of: impl Fn(&DocAddress) -> Option<Id16>,
    has_adapter: impl Fn(&str) -> bool,
) -> Result<(), StoreError> {
    if appends.is_empty() {
        return Ok(());
    }
    let entries: Vec<DocLogEntry> = appends.iter().map(|a| a.entry.clone()).collect();
    store.append(&entries)?;
    let mut touched: BTreeMap<&DocAddress, &str> = BTreeMap::new();
    for a in appends {
        touched.insert(&a.entry.doc, &a.adapter);
    }
    for (doc, adapter) in touched {
        let winner = winner_of(doc);
        let live = live_states(has_adapter(adapter));
        let mut tail = (0u64, 0u64);
        for e in store.entries_of(doc)? {
            let next = next_state(&e, winner, live);
            if next != e.state {
                store.set_state(&e.author, e.seq, e.index, next)?;
            }
            if e.lineage == winner && next.in_tail() {
                tail = (tail.0 + 1, tail.1 + e.size);
            }
        }
        store.upsert_head(doc, adapter, winner, tail.0, tail.1)?;
    }
    Ok(())
}
