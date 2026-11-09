//! The engine (`engine/src/engine.ts`, `writes.ts`, `fold.ts`, `admit.ts`): numbers, signs,
//! appends and folds this device's writes; verifies, dedups, appends and folds everyone else's.
//!
//! Two paths in, one shape: append and state commit first, the fold notification after, so a
//! reader that re-reads a table on notification never sees a row the append went on to lose.
//! Signing happens here rather than in the transport, unlike the TypeScript: an entry this device
//! authored always carries its core and signature, so a forwarder never has to special-case its
//! own writes and a log never holds an own write it cannot send.
//!
//! With a validator ([`EngineOptions::validator`], gap U3) every event — a peer's as it arrives,
//! and this device's own as a probe before it is numbered — goes through the TypeScript's ladder
//! over the manifest as data, and what it refuses parks with the verdict, in the TypeScript's
//! buckets, and is re-offered once after any batch that folds something. Without one, this crate
//! folds what verifies and parks only what it has no fold for (D22-A) and the doc changes the
//! declared doc columns refuse, trusting the relay's room the way a TypeScript device with no
//! schema does.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

use syncmesh_core::apply::{apply_change, merge_record};
use syncmesh_core::doc::{
    DocColumns, Id16, LineageCellRefused, derive_lineage, lineage_of, parse_lineage_cells,
    read_lineage_cell, settle_walk, with_doc_columns,
};
use syncmesh_core::envelope::sign_event;
use syncmesh_core::event::{
    Change, PartitionKey, PeerId, RowKey, SchemaVersion, SeqNum, SyncEvent, TableName,
};
use syncmesh_core::hlc::{DEFAULT_MAX_DRIFT_MS, Hlc, HlcClock};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::RowRecord;
use syncmesh_core::stamp::Stamp;
use syncmesh_core::state::State;
use syncmesh_core::strategy::MergeSpec;

use crate::coverage::CoverageTracker;
use crate::doc_log::{
    DocAddress, DocAppend, DocHead, DocLogEntry, DocStore, MemoryDocStore, doc_appends,
    lineage_moves, record_docs, relabel_docs,
};
use crate::doc_rules::{DerivedColumns, derived_refusal, doc_refusal, doc_verdict};
use crate::interest::{Interest, interest_text, matches_interest, rows_in, window_rows};
use crate::quarantine::{Parked, Quarantine};
use crate::snapshot::{InstallError, Installed, Snapshot};
use crate::store::{
    Ahead, Coverage, Cursors, EventStore, StateStore, StoreError, StoredEvent, rows_for,
    write_keys_of,
};
use crate::undo::{Skipped, Undo, compensate, rows_before};
use crate::validate::{
    Overlay, PolicySource, Probe, ValidationClock, ValidationError, Validator, ValidatorOptions,
    unfoldable,
};
use syncmesh_core::snapshot_codec::SnapshotRow;

/// Where a batch came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FoldSource {
    Local,
    Remote,
    Boot,
    /// A snapshot install (RFC-0019): rows merged, no events folded.
    Snapshot,
}

/// One notification per fold, however many events it covered. `write_keys` is exact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoldBatch {
    pub source: FoldSource,
    pub event_count: usize,
    pub write_keys: BTreeMap<TableName, BTreeSet<RowKey>>,
    /// The doc-log entries the batch appended. A doc edit moves no `write_keys`; a document
    /// handle watches these for remote updates instead.
    pub docs: Vec<DocAppend>,
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
    /// Parked with the verdict that refused them; never folded, cursor stops below them (D13).
    pub quarantined: usize,
}

/// What a write produced: the signed entry to hand every link, and what it changed.
#[derive(Debug, Clone, PartialEq)]
pub struct Mutated {
    pub entry: StoredEvent,
    pub batch: FoldBatch,
}

/// What a revert did: the compensating write, when anything of the original still stood to
/// compensate, and what it left alone (RFC-0023 §9).
#[derive(Debug, Clone, PartialEq)]
pub struct Reverted {
    pub mutated: Option<Mutated>,
    pub skipped: Vec<Skipped>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevertError {
    /// Not among this engine's last `undo_depth` writes.
    NotRevertable {
        event_id: String,
    },
    /// Nothing but document updates, which only their adapter compensates; still revertable once
    /// document undo lands.
    DocumentsOnly {
        event_id: String,
    },
    Mutate(MutateError),
}

impl std::fmt::Display for RevertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RevertError::NotRevertable { event_id } => {
                write!(f, "{event_id} is not among this engine's revertable writes")
            }
            RevertError::DocumentsOnly { event_id } => write!(
                f,
                "{event_id} wrote document updates alone, undone by their adapter (RFC-0023 §9)"
            ),
            RevertError::Mutate(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for RevertError {}

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
    /// A doc change the declared doc columns refuse (RFC-0023 §10), or a row write naming a
    /// document column or a derived one (§16.4) — what an engine with no validator still refuses.
    DocRefused {
        procedure: String,
        reason: &'static str,
    },
    /// The validator's ladder refused the write as a probe, before it was numbered: nothing was
    /// stamped, appended or folded.
    Refused {
        procedure: String,
        verdict: ValidationError,
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
            MutateError::DocRefused { procedure, reason } => write!(f, "{procedure}: {reason}"),
            MutateError::Refused { procedure, verdict } => {
                write!(f, "{procedure}: {} ({verdict})", verdict.tag())
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

/// [`EngineOptions::lineage_settle_after_ms`]'s default: 30 days, the TypeScript's.
pub const DEFAULT_LINEAGE_SETTLE_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The shortest [`EngineOptions::lineage_settle_after_ms`] an engine runs with: one hour, the
/// TypeScript's `MIN_LINEAGE_SETTLE_AFTER`. Every peer trusts the anchor a misconfigured one writes.
pub const MIN_LINEAGE_SETTLE_AFTER_MS: i64 = 60 * 60 * 1000;

pub struct EngineOptions {
    /// Per table and column, how concurrent writes merge; anything unnamed is `lww`.
    pub merge: Option<MergeSpec>,
    /// How far ahead of this device's clock a stamp may run before it is not believed (D34).
    pub max_drift_ms: Option<i64>,
    /// The wall clock, injectable for tests. Default: the system clock in epoch milliseconds.
    pub now_ms: Option<NowMs>,
    /// Parked events kept per reason before that bucket's oldest is dropped. Default 128, the
    /// TypeScript's.
    pub quarantine_limit: usize,
    /// The mesh's doc columns and the adapter each declares (RFC-0023 §4.1): their cells join by
    /// the lineage rule, and doc changes are judged against them. `None` declares none, and the
    /// rungs that need no declaration still run: a genesis must name the lineage its place in the
    /// log derives, once per document per event, so every peer parks the same forged one.
    pub docs: Option<DocColumns>,
    /// Per table, the columns derived from a document column (RFC-0023 §16.4), from
    /// [`crate::docs::derived_columns`]: this device's own write naming one is refused, as the
    /// TypeScript validator refuses it. Empty derives nothing.
    pub derived: DerivedColumns,
    /// The adapters this device can materialise, by id. Empty is the `adapter-missing` mode: doc
    /// changes fold, are kept and forwarded exactly as with one, and are only labelled differently.
    pub doc_adapters: BTreeSet<String>,
    /// Where the doc log and heads live; `None`, in memory.
    pub doc_store: Option<Box<dyn DocStore + Send>>,
    /// How many of this engine's own writes stay revertable. Default 0.
    pub undo_depth: usize,
    /// How long after a `replace()` its lineage counts as settled (gaps U21), as the TypeScript's
    /// `lineageSettleAfter`: a genesis this engine writes names, as its anchor, the deepest lineage
    /// on the walk replaced at least this long before it, and every genesis stamped at or below
    /// that one leaves the lineage cell on every peer. Default
    /// [`DEFAULT_LINEAGE_SETTLE_AFTER_MS`], 30 days; anything shorter than
    /// [`MIN_LINEAGE_SETTLE_AFTER_MS`] is taken as that.
    pub lineage_settle_after_ms: i64,
    /// The app schema this build declares (D31): stamped on every event it writes, under key 9.
    /// A reading for the fleet, never a gate; `None` stamps nothing.
    pub schema_version: Option<SchemaVersion>,
    /// The shared ladder over a manifest (gap U3); `None` runs none. When `docs` or `merge` is
    /// `None`, the manifest's own are used; `docs` given is what the ladder judges by too.
    pub validator: Option<ValidatorOptions>,
}

impl Default for EngineOptions {
    fn default() -> Self {
        EngineOptions {
            merge: None,
            max_drift_ms: Some(DEFAULT_MAX_DRIFT_MS),
            now_ms: None,
            quarantine_limit: 128,
            docs: None,
            derived: DerivedColumns::new(),
            doc_adapters: BTreeSet::new(),
            doc_store: None,
            lineage_settle_after_ms: DEFAULT_LINEAGE_SETTLE_AFTER_MS,
            undo_depth: 0,
            schema_version: None,
            validator: None,
        }
    }
}

/// Why a state with installed rows is refused rather than rebuilt from the log, as the
/// TypeScript's `StateCorrupt` says it.
const UNHELD: &str =
    "it holds rows installed from a snapshot, which the log has no events for — rejoin from a peer";

fn system_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Where a write lands: its partition, its action, what it compensates, and whether it travels.
struct WriteScope {
    partition: Option<PartitionKey>,
    action: Option<Id16>,
    undo_of: Option<Id16>,
    local: bool,
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
    parked: Quarantine,
    validator: Option<Validator>,
    max_drift_ms: Option<i64>,
    /// Empty when none were declared: the genesis rungs still run, as they do in TypeScript.
    docs: DocColumns,
    derived: DerivedColumns,
    doc_adapters: BTreeSet<String>,
    doc_store: Box<dyn DocStore + Send>,
    /// The highest sequence of this device's own author known to exist outside this log — what a
    /// room said it holds (G7). Numbering never goes at or below it, whatever the log holds.
    own_floor: u64,
    undo_depth: usize,
    lineage_settle_after_ms: i64,
    /// The last `undo_depth` own writes and the rows they touched as they read before.
    undo: VecDeque<Undo>,
    /// The persisted lineage cell that made `open` rebuild the state from the log.
    refused_at_open: Option<LineageCellRefused>,
    /// Stamped on each own event (D31); `None`, nothing is.
    schema_version: Option<SchemaVersion>,
}

/// What a room's position for this device's own author meant for this log (G7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnPosition {
    /// The room holds nothing of ours this log lacks: the normal case.
    Known,
    /// The room holds writes of ours this log never had, and this log wrote none of its own: it
    /// was lost and rebuilt under a key that outlived it. Numbering now resumes after the room.
    Resumed { room: SeqNum },
    /// As `Resumed`, but this log had already numbered writes of its own in the range the room
    /// holds. Unless they are the very events the room holds (a log restored from an older
    /// copy), they carry `(author, seq)` pairs the room already has for other events, and a room
    /// drops those as duplicates: they can never be delivered. Said, not repaired: re-signing
    /// under new numbers would re-author them (`engine/src/stranded.ts` on why).
    Collided { room: SeqNum, held: SeqNum },
}

impl OwnPosition {
    /// What a host should say, if anything: `None` unless writes were lost.
    pub fn warning(&self) -> Option<String> {
        match self {
            OwnPosition::Collided { room, held } => {
                let (room, held) = (room.get(), held.get());
                Some(format!(
                    "the room holds writes by this device up to {room} that this log never had \
                     (it holds up to {held}): the log was lost, restored from an older copy, or \
                     its key signs another log too. Any write this log numbered up to {held} \
                     that the room does not already hold byte for byte reuses a number the room \
                     has for another event and will not be delivered; new writes resume after \
                     {room}"
                ))
            }
            OwnPosition::Known | OwnPosition::Resumed { .. } => None,
        }
    }
}

impl Engine {
    /// Opens the engine over its stores: loads the materialised rows where there are any, replays
    /// the log above them, and moves the clock past every stored stamp so a write numbered now
    /// sorts after everything already held (D05). Rows holding a lineage cell of a rule this build
    /// does not run are state it cannot read: the state store is cleared and rebuilt from the
    /// whole log, as the TypeScript's `openEngine` does, and the refused cell is kept for
    /// [`Engine::refused_at_open`]. This crate never compacts its log, so the log holds every
    /// event the state stood for — unless a snapshot install left a floor (D46): then those rows
    /// have no events behind them, and such a state is refused as `StateCorrupt` instead.
    pub fn open(
        identity: Identity,
        mut store: Box<dyn EventStore + Send>,
        mut state_store: Option<Box<dyn StateStore + Send>>,
        options: EngineOptions,
    ) -> Result<Engine, StoreError> {
        // rows a snapshot install brought have no events behind them, and the log keeps the floor
        // they stand at (gaps U37): a state store that is empty over it was deleted or replaced,
        // and folding the log would rebuild it without them
        let installed = store.installed_below()?;
        let (mut state, mut coverage) = match &state_store {
            Some(s) if !s.is_empty()? => (s.load_all()?, s.load_coverage()?),
            Some(_) if !installed.is_empty() => {
                return Err(StoreError::new(format!(
                    "StateCorrupt: there is no folded state, and the state this log was folded \
                     into {UNHELD}"
                )));
            }
            _ => (State::new(), Coverage::default()),
        };
        // a state installed before the log kept the floor gives it to the log now
        if !coverage.floor.is_empty() {
            store.record_installed(&coverage.floor)?;
        }
        let mut validator = options.validator.map(Validator::new);
        let docs = options
            .docs
            .or_else(|| validator.as_ref().map(|v| v.doc_columns().clone()));
        // the ladder judges doc changes against the columns the fold joins, never other ones
        if let (Some(validator), Some(docs)) = (validator.as_mut(), &docs) {
            validator.judge_docs(docs.clone());
        }
        let merge = options
            .merge
            .or_else(|| validator.as_ref().map(|v| v.manifest().merge()));
        // a lineage cell another rule wrote is state this build cannot read (RFC-0023 §16.1): never
        // read as the root or merged by another rule, and rebuilt from the log instead
        let refused = docs.as_ref().and_then(|docs| {
            let rows = state.tables.iter().flat_map(|(table, records)| {
                records
                    .iter()
                    .map(move |(key, record)| (table.as_str(), key.as_str(), record))
            });
            parse_lineage_cells(rows, docs).err()
        });
        if let Some(cell) = &refused
            && !(coverage.floor.is_empty() && installed.is_empty())
        {
            // rows a snapshot installed have no events behind them: a rebuild from the log would
            // drop them without a word, so the state is refused instead, as the TypeScript's
            // `StateCorrupt` refuses it (gaps U22, U37). Nothing is cleared
            return Err(StoreError::new(format!(
                "StateCorrupt: the state holds {cell}; {UNHELD}"
            )));
        }
        if refused.is_some() {
            if let Some(s) = state_store.as_mut() {
                s.clear()?;
            }
            state = State::new();
            coverage = Coverage::default();
        }
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
            merge: match &docs {
                Some(docs) => Some(with_doc_columns(merge.as_ref(), docs)),
                None => merge,
            },
            acks: BTreeMap::new(),
            parked: Quarantine::new(options.quarantine_limit),
            validator,
            max_drift_ms: options.max_drift_ms,
            docs: docs.unwrap_or_default(),
            derived: options.derived,
            doc_adapters: options.doc_adapters,
            doc_store: options
                .doc_store
                .unwrap_or_else(|| Box::new(MemoryDocStore::new())),
            own_floor: 0,
            undo_depth: options.undo_depth,
            lineage_settle_after_ms: options
                .lineage_settle_after_ms
                .max(MIN_LINEAGE_SETTLE_AFTER_MS),
            undo: VecDeque::new(),
            refused_at_open: refused,
            schema_version: options.schema_version,
        };
        let mut replay = engine.store.all_since(&coverage.synced)?;
        replay.extend(engine.store.local_since(&coverage.local)?);
        let batch = engine.fold(&replay, FoldSource::Boot);
        engine.persist(&batch)?;
        engine.relabel_stale_heads()?;
        Ok(engine)
    }

    /// Relabels every document whose head names a winning lineage the state does not: what an
    /// install leaves when it stops after its rows commit and before the doc log is relabelled.
    fn relabel_stale_heads(&mut self) -> Result<(), StoreError> {
        let state = &self.state;
        let winner_of =
            |doc: &DocAddress| lineage_of(state.record(&doc.table, &doc.key), &doc.column);
        let stale: Vec<(DocAddress, String)> = self
            .doc_store
            .heads()?
            .into_iter()
            .filter(|head| head.lineage != winner_of(&head.doc))
            .map(|head| (head.doc, head.adapter))
            .collect();
        if stale.is_empty() {
            return Ok(());
        }
        let adapters = &self.doc_adapters;
        relabel_docs(self.doc_store.as_mut(), &stale, winner_of, |a| {
            adapters.contains(a)
        })
    }

    /// The persisted lineage cell `open` refused, after which it rebuilt the state from the log;
    /// `None` when the state it loaded was read as it was. The TypeScript reports the same refusal
    /// on `onError`; a host shows it the same way.
    pub fn refused_at_open(&self) -> Option<&LineageCellRefused> {
        self.refused_at_open.as_ref()
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
        self.mutate_with(procedure, changes, partition, None, None)
    }

    /// [`Engine::mutate`], in an action (event key 10) and compensating another (key 11). A
    /// genesis in `changes` names no lineage of its own: the one derived from its place in the
    /// event is filled in once the event is numbered, whatever the caller wrote (RFC-0023 §5.3),
    /// and so is its parent — the lineage that wins here as it is written, which is what a
    /// replace replaces (§16.1).
    pub fn mutate_with(
        &mut self,
        procedure: &str,
        changes: Vec<Change>,
        partition: Option<PartitionKey>,
        action: Option<Id16>,
        undo_of: Option<Id16>,
    ) -> Result<Mutated, MutateError> {
        let options = WriteScope {
            partition,
            action,
            undo_of,
            local: false,
        };
        self.write(procedure, changes, options)
    }

    /// A write that never leaves this device (`MutateOptions.local` in the TypeScript): numbered
    /// in its own sequence (`peer-L1`, `peer-L2`, …), folded and kept like any other, never signed
    /// and never sent, so its entry has no envelope and `events_since` never returns it. What a
    /// `local` table is written with; a write to one by [`Engine::mutate`] is refused as
    /// `LocalOnly` by a validator, as the TypeScript refuses it. A document change never rides one.
    pub fn mutate_local(
        &mut self,
        procedure: &str,
        changes: Vec<Change>,
        partition: Option<PartitionKey>,
    ) -> Result<Mutated, MutateError> {
        let options = WriteScope {
            partition,
            action: None,
            undo_of: None,
            local: true,
        };
        self.write(procedure, changes, options)
    }

    fn write(
        &mut self,
        procedure: &str,
        changes: Vec<Change>,
        options: WriteScope,
    ) -> Result<Mutated, MutateError> {
        let WriteScope {
            partition,
            action,
            undo_of,
            local,
        } = options;
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
        if let Some(validator) = &self.validator {
            // a probe: not numbered and not stamped yet, which reads as "now"
            let probe = Probe {
                peer_id: self.identity.peer_id(),
                partition: partition.as_ref(),
                changes: &changes,
                seq: None,
                hlc: None,
                local,
            };
            validator
                .validate(&probe, &self.state, Some(self.validation_clock()))
                .map_err(|verdict| MutateError::Refused {
                    procedure: procedure.to_owned(),
                    verdict,
                })?;
        }
        let hlc = self.clock.tick(self.now_ms());
        let own = self.identity.peer_id();
        // after the log and after anything a room said it holds of ours: a number reused is a
        // write a room drops as a duplicate, silently (G7). Local writes never travel, so their
        // run is this log's alone
        let after = if local {
            self.store.last_local_seq(own)?.map_or(0, |s| s.get())
        } else {
            let last = self.store.last_seq(own)?;
            last.map(|s| s.get()).unwrap_or(0).max(self.own_floor)
        };
        let seq_num = SeqNum::parse(after + 1)
            .ok_or_else(|| StoreError::new("the sequence space is exhausted"))?;
        let peer_id = self.identity.peer_id().clone();
        let changes = changes
            .into_iter()
            .enumerate()
            .map(|(index, change)| match change {
                Change::Doc(mut d) if d.genesis => {
                    let record = self.state.record(&d.table, &d.key);
                    d.lineage = Some(derive_lineage(&peer_id, seq_num, index as u32));
                    d.parent = lineage_of(record, &d.column);
                    // written under this build's rule, never an earlier one the write named (U39)
                    d.rule = None;
                    // the anchor this write settles the walk at (gaps U21)
                    d.settles = settle_walk(
                        record
                            .and_then(|r| r.cells.get(&d.column))
                            .map(|c| &c.value),
                        hlc.ms.saturating_sub(self.lineage_settle_after_ms),
                    );
                    Change::Doc(d)
                }
                other => other,
            })
            .collect();
        let event = SyncEvent {
            peer_id,
            seq_num,
            hlc,
            procedure: procedure.to_owned(),
            partition,
            changes,
            sealed: false,
            action,
            undo_of,
            schema_version: self.schema_version,
        };
        if let Some(reason) = doc_refusal(&event, &self.docs, local)
            .or_else(|| derived_refusal(&event, &self.derived))
        {
            return Err(MutateError::DocRefused {
                procedure: procedure.to_owned(),
                reason,
            });
        }
        let before = if self.undo_depth > 0 {
            rows_before(&self.state, &event.changes)
        } else {
            Vec::new()
        };
        // a local write is never signed: an envelope for it would be a valid synced event under a
        // number the synced run will use again
        let entry = if local {
            StoredEvent {
                event,
                core: None,
                sig: None,
                local: true,
            }
        } else {
            StoredEvent::from_verified(sign_event(event, &self.identity))
        };
        self.store.append(&entry)?;
        let batch = self.fold(std::slice::from_ref(&entry), FoldSource::Local);
        self.persist(&batch)?;
        if self.undo_depth > 0 {
            self.undo.push_back(Undo {
                event: entry.event.clone(),
                before,
                local,
            });
            if self.undo.len() > self.undo_depth {
                self.undo.pop_front();
            }
        }
        Ok(Mutated { entry, batch })
    }

    /// Whether `event_id` is among this engine's last `undo_depth` writes.
    pub fn can_revert(&self, event_id: &str) -> bool {
        self.undo.iter().any(|u| u.id() == event_id)
    }

    /// Writes the compensating event for one of this engine's last `undo_depth` writes, in that
    /// event's partition, as the TypeScript's `revert` (RFC-0023 §9, decided in §16.3): each cell
    /// still holding the write's stamp goes back to its value before the write, and a cell someone
    /// changed since is left as they left it and reported in `skipped`. When nothing of the write
    /// still stands, nothing is written; a compensation the engine refuses leaves the write
    /// revertable.
    pub fn revert(&mut self, event_id: &str) -> Result<Reverted, RevertError> {
        let Some(index) = self.undo.iter().position(|u| u.id() == event_id) else {
            return Err(RevertError::NotRevertable {
                event_id: event_id.to_owned(),
            });
        };
        let only_documents = self.undo[index]
            .event
            .changes
            .iter()
            .all(|c| matches!(c, Change::Doc(_) | Change::Unknown { .. }));
        if only_documents {
            // refused before the ring gives up the slot, so it stays revertable for doc undo
            return Err(RevertError::DocumentsOnly {
                event_id: event_id.to_owned(),
            });
        }
        let Some(undo) = self.undo.remove(index) else {
            unreachable!("the index was just found in the ring")
        };
        let validator = self.validator.as_ref();
        let retired =
            |table: &str, column: &str| validator.is_some_and(|v| v.retired_column(table, column));
        let (changes, skipped) = compensate(&self.state, &undo, self.merge.as_ref(), retired);
        if changes.is_empty() {
            return Ok(Reverted {
                mutated: None,
                skipped,
            });
        }
        // in the partition and the locality of the write it answers
        let scope = WriteScope {
            partition: undo.event.partition.clone(),
            action: None,
            undo_of: None,
            local: undo.local,
        };
        match self.write("revert", changes, scope) {
            Ok(mutated) => Ok(Reverted {
                mutated: Some(mutated),
                skipped,
            }),
            Err(e) => {
                // a refused compensation wrote nothing, so the write is still there to revert
                self.undo.insert(index.min(self.undo.len()), undo);
                Err(RevertError::Mutate(e))
            }
        }
    }

    /// What a verdict is reached under: this device's clock and the drift bound it folds by.
    fn validation_clock(&self) -> ValidationClock {
        ValidationClock {
            now_ms: self.now_ms(),
            max_drift_ms: self.max_drift_ms,
        }
    }

    /// Folds entries once each; already-stored events are skipped, and events the ladder refuses
    /// (or, with no validator, that this build has no fold for) are parked with their verdict and
    /// the author's cursor stopped below them.
    ///
    /// Each event is judged against what the device holds and what the batch already admitted
    /// before it, so an update is judged with the insert beside it. After a batch that folds
    /// anything, every `refused` event parked is re-offered once (`withRetry`): the row it needed
    /// may just have landed.
    ///
    /// An event of this device's own author that the log does not hold is taken like anyone
    /// else's (G7): it verified under this device's key, so it is a write this device made and
    /// then lost — a log deleted and rebuilt under a key that outlived it. Skipping it would
    /// leave the device without its own history and numbering its next write over it.
    pub fn receive_batch(&mut self, entries: Vec<StoredEvent>) -> Result<Received, StoreError> {
        let received = self.admit(entries)?;
        if received.report.folded == 0 || self.parked.is_empty() {
            return Ok(received);
        }
        let (retry, kept): (Vec<Parked>, Vec<Parked>) = self
            .parked
            .take()
            .into_iter()
            .partition(|p| p.reason.cleared_by_state());
        // back first, so a store emptied by `take` is whole again before anything can fail
        for parked in kept {
            self.parked.park(parked);
        }
        if retry.is_empty() {
            return Ok(received);
        }
        let entries = retry.iter().map(|p| p.entry.clone()).collect();
        let again = match self.admit(entries) {
            Ok(again) => again,
            Err(_) => {
                for parked in retry {
                    self.parked.park(parked);
                }
                return Ok(received);
            }
        };
        // `folded` grows because those events landed on this call; `quarantined` and `skipped`
        // stay the batch's own, since the retry re-offers what an earlier call already counted
        let mut batch = received.batch;
        batch.event_count += again.batch.event_count;
        for (table, keys) in again.batch.write_keys {
            batch.write_keys.entry(table).or_default().extend(keys);
        }
        batch.docs.extend(again.batch.docs);
        Ok(Received {
            report: ReceiveReport {
                folded: received.report.folded + again.report.folded,
                ..received.report
            },
            batch,
        })
    }

    /// One pass of the admission path: dedup, judge, park, append and fold.
    fn admit(&mut self, entries: Vec<StoredEvent>) -> Result<Received, StoreError> {
        let total = entries.len();
        let clock = self.validation_clock();
        let mut fresh: Vec<StoredEvent> = Vec::new();
        let mut refused: Vec<Parked> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut own_floor = self.own_floor;
        let mut overlay = Overlay::new(&self.state);
        for entry in entries {
            let id = entry.id();
            if !seen.insert(id.clone()) {
                continue;
            }
            if self.store.has(&id)? {
                continue;
            }
            if &entry.event.peer_id == self.identity.peer_id() {
                if entry.sig.is_none() {
                    // an own event nobody signed cannot be one this device wrote and sent
                    continue;
                }
                own_floor = own_floor.max(entry.event.seq_num.get());
            }
            let verdict = match &self.validator {
                Some(validator) => unfoldable(&entry.event).or_else(|| {
                    validator
                        .validate(&Probe::event(&entry.event), &overlay, Some(clock))
                        .err()
                }),
                None => doc_verdict(&entry.event, &self.docs, entry.local),
            };
            match verdict {
                Some(verdict) => refused.push(Parked {
                    reason: verdict.reason(),
                    verdict,
                    entry,
                }),
                None => {
                    overlay.took(&entry.event);
                    fresh.push(entry);
                }
            }
        }
        self.own_floor = own_floor;
        let quarantined = refused.len();
        for parked in refused {
            self.parked.park(parked);
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

    /// The events this build would not take, with the bytes they arrived as and the verdict it
    /// reached (D13), bucket by bucket.
    pub fn quarantine(&self) -> Vec<&Parked> {
        self.parked.list().collect()
    }

    /// Re-offers every parked event to the ordinary receive path — what an app calls after an
    /// update. What the build still cannot take is parked again.
    pub fn retry_quarantined(&mut self) -> Result<Received, StoreError> {
        let parked = self.parked.take();
        let entries = parked.iter().map(|p| p.entry.clone()).collect();
        self.receive_batch(entries).inspect_err(|_| {
            for p in parked {
                self.parked.park(p);
            }
        })
    }

    fn fold(&mut self, entries: &[StoredEvent], source: FoldSource) -> FoldBatch {
        let write_keys = write_keys_of(entries.iter().map(|e| &e.event));
        for entry in entries {
            let event = &entry.event;
            self.coverage.note(event, entry.local);
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
        let adapters = &self.doc_adapters;
        FoldBatch {
            source,
            event_count: entries.len(),
            write_keys,
            docs: doc_appends(entries.iter().map(|e| &e.event), |a| adapters.contains(a)),
        }
    }

    fn persist(&mut self, batch: &FoldBatch) -> Result<(), StoreError> {
        if batch.event_count == 0 {
            return Ok(());
        }
        if let Some(store) = self.state_store.as_mut() {
            let rows = rows_for(&self.state, &batch.write_keys);
            store.commit(&rows, &self.coverage.current())?;
        }
        let (state, adapters) = (&self.state, &self.doc_adapters);
        record_docs(
            self.doc_store.as_mut(),
            &batch.docs,
            |doc| lineage_of(state.record(&doc.table, &doc.key), &doc.column),
            |a| adapters.contains(a),
        )
    }

    /// Every doc-log entry this device holds (RFC-0023 §6.2).
    pub fn doc_log(&self) -> Result<Vec<DocLogEntry>, StoreError> {
        self.doc_store.entries()
    }

    /// Every document's head: its winning lineage and where its tail stands.
    pub fn doc_heads(&self) -> Result<Vec<DocHead>, StoreError> {
        self.doc_store.heads()
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
        for Parked { entry, .. } in self.parked.list() {
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

    /// The rows this device holds, tombstones included, as one transferable value (RFC-0019,
    /// `engine.snapshot`). With an interest only the rows in it, and the snapshot then claims
    /// completeness for that slice alone; a `window` keeps the newest live rows of it and every
    /// tombstone (`window_rows`). The floor is this device's own account of its log and
    /// never part of what it claims. A table the validator's manifest puts in the `local` kind is
    /// left out whatever the interest: its rows never leave this device (gaps U36).
    pub fn snapshot(&self, interest: Option<&Interest>) -> Snapshot {
        let validator = self.validator.as_ref();
        let rows: Vec<SnapshotRow> = self
            .state
            .tables
            .iter()
            .filter(|(table, _)| !validator.is_some_and(|v| v.local_table(table)))
            .flat_map(|(table, records)| {
                records
                    .iter()
                    .filter(|(_, record)| rows_in(record, interest))
                    .map(move |(key, record)| SnapshotRow::new(table, key, record.clone()))
            })
            .collect();
        // a window keeps the newest live rows of the slice and every tombstone in it
        let rows = match interest.and_then(|i| i.window) {
            Some(window) => window_rows(rows, window),
            None => rows,
        };
        let coverage = Coverage {
            floor: Cursors::new(),
            ..self.coverage.current()
        };
        Snapshot {
            rows,
            coverage,
            scope: interest.cloned(),
        }
    }

    /// Merges a snapshot's rows and, only then, adopts the coverage they stand for
    /// (`installSnapshot`). Every row goes through the ordinary field-level merge, so an install
    /// is safe to repeat and to interleave with live events, and cannot resurrect a tombstone.
    /// What it adopts beyond the log is the floor (D46); a scoped snapshot's coverage is adopted
    /// as scoped (D23).
    ///
    /// A row holding a lineage cell of a rule this build does not run refuses the whole snapshot
    /// before anything joins (RFC-0023 §16.1): nothing installed, nothing adopted. A document whose
    /// winning lineage the rows move has its doc log relabelled in the same step. Rows and
    /// coverage commit to the state store together, before the relabel: a stop between the two
    /// leaves heads naming the old winner, which the next [`Engine::open`] relabels.
    pub fn install_snapshot(&mut self, snapshot: Snapshot) -> Result<Installed, InstallError> {
        let keyed = snapshot
            .rows
            .iter()
            .map(|row| (row.table.as_str(), row.key.as_str(), &row.record));
        parse_lineage_cells(keyed, &self.docs).map_err(InstallError::Refused)?;
        let before = self.state.clone();
        let mut write_keys: BTreeMap<TableName, BTreeSet<RowKey>> = BTreeMap::new();
        let count = snapshot.rows.len();
        let now = self.now_ms();
        for row in &snapshot.rows {
            for hlc in row_stamps(&row.table, &row.record, &self.docs) {
                self.clock.receive(hlc, now);
            }
        }
        for row in snapshot.rows {
            write_keys
                .entry(row.table.clone())
                .or_default()
                .insert(row.key.clone());
            merge_record(
                &mut self.state,
                &row.table,
                &row.key,
                row.record,
                self.merge.as_ref(),
            );
        }
        let moved = lineage_moves(&before, &self.state, &write_keys, &self.docs);
        let mut adopted = snapshot.coverage;
        if let Some(scope) = &snapshot.scope {
            adopted.scope = Some(interest_text(Some(scope)));
        }
        let mut coverage = self.coverage.clone();
        coverage.adopt_unheld(&adopted);
        let committed = match self.state_store.as_mut() {
            Some(store) => {
                store.commit(&rows_for(&self.state, &write_keys), &coverage.current())?;
                true
            }
            None => false,
        };
        self.coverage = coverage;
        let (state, adapters) = (&self.state, &self.doc_adapters);
        relabel_docs(
            self.doc_store.as_mut(),
            &moved,
            |doc| lineage_of(state.record(&doc.table, &doc.key), &doc.column),
            |a| adapters.contains(a),
        )?;
        // the log keeps the floor too, once the state that holds its rows has committed (gaps
        // U37): a floor over no state that holds the rows would refuse every later boot. A record
        // that fails is the install's error; the state holds the floor, and the next open copies
        // it into the log
        let floor = self.coverage.current().floor;
        if committed && !floor.is_empty() {
            self.store.record_installed(&floor)?;
        }
        Ok(Installed {
            rows: count,
            batch: FoldBatch {
                source: FoldSource::Snapshot,
                event_count: count,
                write_keys,
                docs: Vec::new(),
            },
        })
    }

    /// Per author, the highest sequence this device claims with no event in its log behind it —
    /// what a snapshot install left (D46). Sent at index 4 of a peer link's cursors frame; empty
    /// until an install adopts something the log does not hold, since this crate never compacts.
    pub fn floor(&self) -> Cursors {
        self.coverage.current().floor
    }

    /// The floor the log keeps for rows a snapshot installed ([`EventStore::installed_below`]):
    /// what a boot over an empty or unreadable state refuses on. Empty with no state store, since
    /// an install records it only once a state store holds the rows.
    pub fn installed_below(&self) -> Result<Cursors, StoreError> {
        self.store.installed_below()
    }

    /// Whether the mesh declares document columns: a snapshot answering a floor then adopts no
    /// coverage, because it carries no document snapshots (D46).
    pub fn has_doc_columns(&self) -> bool {
        self.docs.values().any(|columns| !columns.is_empty())
    }

    /// Takes on a room's position for this device's own author (its `hello` cursors): nothing
    /// is ever numbered at or below it again (G7). A key that outlives its log — a database
    /// deleted, restored from an older copy, or a key shared by two logs — would otherwise
    /// number writes the room already holds, and the room drops those as duplicates without a
    /// word. Says whether this log's own writes were caught in that range.
    pub fn adopt_own_position(&mut self, room: SeqNum) -> Result<OwnPosition, StoreError> {
        let held = self
            .store
            .last_seq(self.identity.peer_id())?
            .map(|s| s.get())
            .unwrap_or(0);
        if room.get() <= held || room.get() <= self.own_floor {
            self.own_floor = self.own_floor.max(room.get());
            return Ok(OwnPosition::Known);
        }
        self.own_floor = room.get();
        Ok(match SeqNum::parse(held) {
            Some(held) => OwnPosition::Collided { room, held },
            None => OwnPosition::Resumed { room },
        })
    }

    /// The highest own sequence known to exist outside this log (0 when none was reported).
    pub fn own_floor(&self) -> u64 {
        self.own_floor
    }

    /// Records what `peer` holds, as of `at_ms`; links call it on every cursor exchange.
    pub fn acknowledge(&mut self, peer: PeerId, cursors: Cursors, at_ms: i64) {
        self.acks.insert(peer, Ack { cursors, at_ms });
    }

    /// `mesh.can` (`client/src/can.ts`): may this device do `"table.op"` on `row`, by the rules its
    /// validator enforces, read where the write path reads them — the instance's synced `_policy`
    /// row when this device holds one, the manifest otherwise. `instance` names the partition; with
    /// none, a `user` table is asked in the account's own instance and any other table by the
    /// manifest's rules. An instance that does not parse is no instance. `false` with no validator:
    /// nothing here could say yes.
    pub fn can(
        &self,
        what: &str,
        row: Option<&syncmesh_core::record::Row>,
        instance: Option<&str>,
    ) -> bool {
        let Some(validator) = &self.validator else {
            return false;
        };
        let named = instance.and_then(|i| PartitionKey::parse(i).ok());
        let held = validator.principal(self.peer_id(), named.as_ref(), &self.state, self.now_ms());
        let partition = match instance {
            Some(_) => named,
            None => {
                let table = what.split_once('.').map_or(what, |(t, _)| t);
                let kind = validator
                    .manifest()
                    .tables
                    .get(table)
                    .map(|t| t.partition.as_str());
                match (kind, &held) {
                    (Some("user"), Some(p)) => {
                        PartitionKey::parse(&format!("user:{}", p.account)).ok()
                    }
                    _ => None,
                }
            }
        };
        let source = partition.as_ref().map(|partition| PolicySource {
            partition,
            rows: &self.state,
        });
        validator.can(held.as_ref(), what, row, None, source)
    }

    /// The ladder this engine judges every event by; `None` when it runs none.
    pub fn validator(&self) -> Option<&Validator> {
        self.validator.as_ref()
    }

    /// What this build declares (D31): stamped on its own events and sent on its cursors frames.
    pub fn schema_version(&self) -> Option<SchemaVersion> {
        self.schema_version
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

/// Every clock reading a row carries, as the TypeScript's `rowStamps`: its write and delete
/// stamps, each cell's stamp, and, in a doc column's lineage cell, each genesis's stamp and the
/// anchor's. What the clock receives from a row that joins outside an event, so a genesis this
/// device writes next is stamped after every one it adopted (gaps U21).
fn row_stamps(table: &str, record: &RowRecord, docs: &DocColumns) -> Vec<Hlc> {
    let mut stamps: Vec<Hlc> = record
        .write_stamp
        .iter()
        .chain(&record.delete_stamp)
        .chain(record.cells.values().map(|cell| &cell.stamp))
        .map(|stamp| stamp.hlc)
        .collect();
    for column in docs.get(table).into_iter().flat_map(BTreeMap::keys) {
        let cell = read_lineage_cell(record.cells.get(column).map(|cell| &cell.value));
        stamps.extend(cell.geneses.iter().map(|genesis| genesis.stamp.hlc));
        stamps.extend(cell.settled.iter().map(|settled| settled.stamp.hlc));
    }
    stamps
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

    #[test]
    fn a_log_rebuilt_under_the_same_key_takes_its_own_writes_back_and_numbers_after_them() {
        let mut a = engine(1);
        let e1 = a.mutate("t", vec![insert("1", "x")], None).unwrap().entry;
        let e2 = a.mutate("t", vec![insert("2", "y")], None).unwrap().entry;
        // the log is gone; the key is not (G7)
        let mut reborn = engine(1);
        let back = reborn.receive_batch(vec![e1, e2]).unwrap();
        assert_eq!(back.report.folded, 2);
        assert!(reborn.state().read_row("notes", "2").is_some());
        assert_eq!(reborn.cursors()[reborn.peer_id()].get(), 2);
        let next = reborn.mutate("t", vec![insert("3", "z")], None).unwrap();
        assert_eq!(next.entry.event.seq_num.get(), 3);
        // an own event nobody signed is not one this device sent
        let mut unsigned = next.entry.clone();
        unsigned.event.seq_num = SeqNum::parse(9).unwrap();
        unsigned.sig = None;
        unsigned.core = None;
        assert_eq!(reborn.receive(unsigned).unwrap().report.folded, 0);
    }

    #[test]
    fn a_room_ahead_of_the_log_moves_numbering_past_it_and_says_what_collided() {
        let room = SeqNum::parse(5).unwrap();
        let mut fresh = engine(1);
        assert_eq!(
            fresh.adopt_own_position(room).unwrap(),
            OwnPosition::Resumed { room }
        );
        assert!(OwnPosition::Resumed { room }.warning().is_none());
        let w = fresh.mutate("t", vec![insert("1", "x")], None).unwrap();
        assert_eq!(w.entry.event.seq_num.get(), 6);
        // said once: the same position again is known
        assert_eq!(fresh.adopt_own_position(room).unwrap(), OwnPosition::Known);

        let mut wrote_offline = engine(2);
        wrote_offline
            .mutate("t", vec![insert("1", "x")], None)
            .unwrap();
        let position = wrote_offline.adopt_own_position(room).unwrap();
        assert_eq!(
            position,
            OwnPosition::Collided {
                room,
                held: SeqNum::parse(1).unwrap()
            }
        );
        assert!(position.warning().unwrap().contains("up to 5"));
        let w = wrote_offline
            .mutate("t", vec![insert("2", "y")], None)
            .unwrap();
        assert_eq!(w.entry.event.seq_num.get(), 6);

        // a room behind the log is the ordinary case: unsent writes
        let mut ahead = engine(3);
        for k in ["1", "2", "3"] {
            ahead.mutate("t", vec![insert(k, "x")], None).unwrap();
        }
        assert_eq!(
            ahead.adopt_own_position(SeqNum::parse(1).unwrap()).unwrap(),
            OwnPosition::Known
        );
        let w = ahead.mutate("t", vec![insert("4", "x")], None).unwrap();
        assert_eq!(w.entry.event.seq_num.get(), 4);
    }
}
