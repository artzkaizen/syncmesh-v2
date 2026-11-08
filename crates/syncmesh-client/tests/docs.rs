//! Document columns in the Rust device, P2 (RFC-0023 §6, §10): the fold, the doc log beside it,
//! the `adapter-missing` mode, and the rules a declared doc column holds a change to — the same
//! properties `engine/src/__tests__/doc-fold.test.ts` and `doc-validate.test.ts` hold the
//! TypeScript to.

use std::collections::{BTreeMap, BTreeSet};

use syncmesh_client::doc_log::{
    DocAddress, DocEntryState, DocHead, DocLogEntry, DocStore, MemoryDocStore, doc_digests,
};
use syncmesh_client::docs::{DocColumnEntry, derived_columns};
use syncmesh_client::{
    Engine, EngineOptions, EventStore, MemoryEventStore, MemoryStateStore, MutateError, RowWrite,
    StateStore, StoreError, StoredEvent,
};
use syncmesh_core::doc::{
    DocBlobRef, DocChange, DocColumns, DocUpdate, Id16, derive_lineage, lineage_of,
};
use syncmesh_core::event::{Change, PartitionKey, SeqNum, SyncEvent};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::{CellValue, JsonValue};

fn docs() -> DocColumns {
    BTreeMap::from([(
        "notes".to_owned(),
        BTreeMap::from([("content".to_owned(), "loro@1".to_owned())]),
    )])
}

fn engine(seed: u8, adapter: bool) -> Engine {
    engine_over(seed, adapter, None)
}

fn engine_over(seed: u8, adapter: bool, store: Option<Box<dyn DocStore + Send>>) -> Engine {
    let n = std::sync::atomic::AtomicI64::new(0);
    Engine::open(
        Identity::from_seed(&[seed; 32]),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            docs: Some(docs()),
            doc_adapters: if adapter {
                BTreeSet::from(["loro@1".to_owned()])
            } else {
                BTreeSet::new()
            },
            doc_store: store,
            // a clock that moves, so two engines' writes interleave by stamp deterministically
            now_ms: Some(Box::new(move || {
                1_000 * i64::from(seed) + n.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            })),
            ..EngineOptions::default()
        },
    )
    .unwrap()
}

fn partition() -> Option<PartitionKey> {
    Some(PartitionKey::parse("workspace:w1").unwrap())
}

fn edit(byte: u8, lineage: Option<Id16>) -> Change {
    Change::Doc(DocChange {
        table: "notes".into(),
        key: "n1".into(),
        column: "content".into(),
        adapter: "loro@1".into(),
        lineage,
        update: DocUpdate::Bytes(vec![byte]),
        genesis: false,
        legacy: false,
        parent: None,
    })
}

fn replace(byte: u8) -> Change {
    let Change::Doc(d) = edit(byte, None) else {
        unreachable!()
    };
    Change::Doc(DocChange { genesis: true, ..d })
}

fn insert() -> Change {
    Change::Insert {
        table: "notes".into(),
        key: "n1".into(),
        row: BTreeMap::from([("title".to_owned(), CellValue::text("t"))]),
    }
}

fn write(engine: &mut Engine, changes: Vec<Change>) -> StoredEvent {
    engine
        .mutate("notes.edit", changes, partition())
        .unwrap()
        .entry
}

fn lineage(engine: &Engine) -> Option<Id16> {
    lineage_of(engine.state().record("notes", "n1"), "content")
}

fn states(engine: &Engine) -> Vec<DocEntryState> {
    engine.doc_log().unwrap().iter().map(|e| e.state).collect()
}

#[test]
fn a_local_replace_derives_its_lineage_and_appends_a_tail_entry() {
    let mut a = engine(1, true);
    let entry = write(&mut a, vec![insert(), replace(1)]);
    let derived = derive_lineage(a.peer_id(), SeqNum::parse(1).unwrap(), 1);
    assert!(matches!(&entry.event.changes[1], Change::Doc(d) if d.lineage == Some(derived)));
    assert_eq!(lineage(&a), Some(derived));
    assert_eq!(states(&a), [DocEntryState::Tail]);
    let heads = a.doc_heads().unwrap();
    assert_eq!(heads.len(), 1);
    assert_eq!(
        (heads[0].lineage, heads[0].tail_count, heads[0].tail_bytes),
        (Some(derived), 1, 1)
    );
}

#[test]
fn an_edit_off_the_winning_lineage_is_orphaned_and_moves_no_write_keys() {
    let mut a = engine(1, false);
    write(&mut a, vec![insert()]);
    let genesis = a
        .mutate("notes.replace", vec![replace(1)], partition())
        .unwrap();
    assert!(genesis.batch.write_keys.contains_key("notes"));
    let root_edit = a
        .mutate("notes.edit", vec![edit(2, None)], partition())
        .unwrap();
    assert!(
        root_edit.batch.write_keys.is_empty(),
        "a doc edit re-runs no live query"
    );
    assert_eq!(root_edit.batch.docs.len(), 1);
    assert_eq!(
        states(&a),
        [DocEntryState::AdapterMissing, DocEntryState::Orphaned]
    );
}

fn labels(r: &Engine, b: &Engine) -> BTreeMap<(bool, u64), DocEntryState> {
    r.doc_log()
        .unwrap()
        .into_iter()
        .map(|e| ((e.author == *b.peer_id(), e.seq.get()), e.state))
        .collect()
}

#[test]
fn the_first_of_two_concurrent_replaces_wins_and_the_late_one_discards_nothing() {
    let mut a = engine(1, true);
    let mut b = engine(2, true);
    let created = write(&mut a, vec![insert()]);
    b.receive(created.clone()).unwrap();
    let a_replace = write(&mut a, vec![replace(1)]);
    let b_replace = write(&mut b, vec![replace(2)]);
    let on_b = lineage(&b);
    let b_edit = write(&mut b, vec![edit(3, on_b)]);
    let mut r = engine(3, true);
    for entry in [created, b_edit, a_replace, b_replace] {
        r.receive(entry).unwrap();
    }
    assert_eq!(lineage(&r), lineage(&a), "A's replace is the first stamp");
    assert_eq!(
        labels(&r, &b),
        BTreeMap::from([
            ((false, 2), DocEntryState::Tail),
            ((true, 1), DocEntryState::Orphaned),
            ((true, 2), DocEntryState::Orphaned),
        ])
    );
}

#[test]
fn a_late_parent_relabels_the_edits_that_arrived_before_it() {
    let mut a = engine(1, true);
    let mut b = engine(2, true);
    let created = write(&mut a, vec![insert()]);
    let a_replace = write(&mut a, vec![replace(1)]);
    b.receive(created.clone()).unwrap();
    b.receive(a_replace.clone()).unwrap();
    // B restores on top of A's lineage: its replace names A's as the one it replaces
    let b_replace = write(&mut b, vec![replace(2)]);
    assert!(matches!(&b_replace.event.changes[0], Change::Doc(d) if d.parent == lineage(&a)));
    let on_b = lineage(&b);
    let b_edit = write(&mut b, vec![edit(3, on_b)]);
    let mut r = engine(3, true);
    for entry in [b_replace, b_edit] {
        r.receive(entry).unwrap();
    }
    assert_eq!(lineage(&r), None, "B's lineage hangs off one not held yet");
    assert_eq!(
        states(&r),
        [DocEntryState::Orphaned, DocEntryState::Orphaned]
    );
    for entry in [created, a_replace] {
        r.receive(entry).unwrap();
    }
    assert_eq!(lineage(&r), on_b);
    assert_eq!(
        labels(&r, &b),
        BTreeMap::from([
            ((false, 2), DocEntryState::Orphaned),
            ((true, 1), DocEntryState::Tail),
            ((true, 2), DocEntryState::Tail),
        ])
    );
}

/// A two-author history with concurrent replaces, a blob update and one event every peer parks.
fn history() -> Vec<StoredEvent> {
    let mut a = engine(1, true);
    let mut b = engine(2, true);
    let mut out = Vec::new();
    let created = write(&mut a, vec![insert(), edit(1, None)]);
    b.receive(created.clone()).unwrap();
    out.push(created);
    out.push(write(&mut a, vec![edit(2, None)]));
    out.push(write(&mut b, vec![edit(3, None)]));
    out.push(write(&mut a, vec![replace(4)]));
    out.push(write(&mut b, vec![replace(5)]));
    let on_a = lineage(&a);
    out.push(write(&mut a, vec![edit(6, on_a)]));
    let Change::Doc(d) = edit(8, lineage(&b)) else {
        unreachable!()
    };
    let blob = DocUpdate::Blob(DocBlobRef {
        hash: [0xab; 32],
        size: 70_000,
    });
    out.push(write(
        &mut b,
        vec![Change::Doc(DocChange { update: blob, ..d })],
    ));
    // signed by a device that declares nothing: its own engine lets the stray adapter through
    let mut stray = Engine::open(
        Identity::from_seed(&[4; 32]),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions::default(),
    )
    .unwrap();
    let Change::Doc(d) = edit(9, None) else {
        unreachable!()
    };
    let foreign = Change::Doc(DocChange {
        adapter: "automerge@3".into(),
        ..d
    });
    out.push(
        stray
            .mutate("notes.edit", vec![foreign], partition())
            .unwrap()
            .entry,
    );
    out
}

fn permutations(n: usize) -> Vec<Vec<usize>> {
    // every rotation and its reverse, plus a few interleavings: enough orders to move each event
    // before and after every other one without 8! runs
    let mut out = Vec::new();
    for k in 0..n {
        let rotated: Vec<usize> = (0..n).map(|i| (i + k) % n).collect();
        out.push(rotated.iter().rev().copied().collect());
        out.push(rotated);
    }
    out.push((0..n).step_by(2).chain((1..n).step_by(2)).collect());
    out
}

#[test]
fn an_engine_with_the_adapter_and_one_without_agree_in_every_order() {
    let events = history();
    for order in permutations(events.len()) {
        let ordered: Vec<StoredEvent> = order.iter().map(|&i| events[i].clone()).collect();
        let mut holding = engine(5, true);
        let mut missing = engine(5, false);
        for entry in &ordered {
            holding.receive(entry.clone()).unwrap();
        }
        missing.receive_batch(ordered.clone()).unwrap();
        assert_eq!(holding.state(), missing.state(), "rows, order {order:?}");
        let (h, m) = (holding.doc_log().unwrap(), missing.doc_log().unwrap());
        assert_eq!(
            doc_digests(&h),
            doc_digests(&m),
            "doc digests, order {order:?}"
        );
        let parked =
            |e: &Engine| -> Vec<String> { e.quarantine().iter().map(|p| p.entry.id()).collect() };
        assert_eq!(
            parked(&holding),
            parked(&missing),
            "parked, order {order:?}"
        );
        assert_eq!(parked(&holding).len(), 1);
        assert!(m.iter().all(|e| matches!(
            e.state,
            DocEntryState::AdapterMissing | DocEntryState::Orphaned
        )));
        assert!(h.iter().all(|e| e.state != DocEntryState::AdapterMissing));
        let position = |log: &[syncmesh_client::DocLogEntry]| -> Vec<_> {
            log.iter()
                .map(|e| (e.author.clone(), e.seq, e.index, e.lineage))
                .collect()
        };
        assert_eq!(position(&h), position(&m));
    }
}

#[test]
fn a_forged_genesis_and_a_row_write_to_a_doc_column_are_refused() {
    let mut a = engine(1, true);
    let refused = a.mutate(
        "notes.edit",
        vec![Change::Insert {
            table: "notes".into(),
            key: "n1".into(),
            row: BTreeMap::from([("content".to_owned(), CellValue::Bytes(vec![1]))]),
        }],
        partition(),
    );
    assert!(matches!(refused, Err(MutateError::DocRefused { .. })));

    // a forged genesis, built and signed by hand: an engine's own `mutate` always derives the
    // lineage, so no engine will write one
    let forger = Identity::from_seed(&[9; 32]);
    let Change::Doc(d) = replace(1) else {
        unreachable!()
    };
    let forged = SyncEvent {
        peer_id: forger.peer_id().clone(),
        seq_num: SeqNum::parse(1).unwrap(),
        hlc: syncmesh_core::hlc::Hlc::new(9_000, 0),
        procedure: "notes.replace".into(),
        partition: partition(),
        changes: vec![Change::Doc(DocChange {
            lineage: Some([0xff; 16]),
            ..d
        })],
        sealed: false,
        action: None,
        undo_of: None,
        schema_version: None,
    };
    let entry = StoredEvent::from_verified(syncmesh_core::sign_event(forged, &forger));
    let report = a.receive(entry.clone()).unwrap().report;
    assert_eq!(report.quarantined, 1);
    assert!(a.doc_log().unwrap().is_empty());

    // and an engine that declares no doc columns, as a `Mesh` does, parks it too: the lineage
    // rungs need no declaration, so a TypeScript peer and this one reach the same verdict
    let mut undeclared = Engine::open(
        Identity::from_seed(&[2; 32]),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions::default(),
    )
    .unwrap();
    let report = undeclared.receive(entry).unwrap().report;
    assert_eq!(report.quarantined, 1);
    assert!(undeclared.doc_log().unwrap().is_empty());
    assert_eq!(undeclared.state().record("notes", "n1"), None);
}

#[test]
fn keys_10_and_11_ride_a_write_into_its_doc_entries() {
    let mut a = engine(1, false);
    let (action, undone) = ([0xa1; 16], [0xb2; 16]);
    let out = a
        .mutate_with(
            "revert",
            vec![edit(1, None)],
            partition(),
            Some(action),
            Some(undone),
        )
        .unwrap();
    let back = syncmesh_core::decode_and_verify(&out.entry.envelope().unwrap()).unwrap();
    assert_eq!(
        (back.event.action, back.event.undo_of),
        (Some(action), Some(undone))
    );
    let log = a.doc_log().unwrap();
    assert_eq!(
        (log[0].action, log[0].undo_of),
        (Some(action), Some(undone))
    );
}

#[cfg(feature = "sqlite")]
mod sqlite {
    use super::*;
    use syncmesh_client::sqlite::SqliteDocStore;

    #[test]
    fn the_sqlite_doc_store_is_the_memory_one_and_survives_a_reopen() {
        let dir = std::env::temp_dir().join(format!(
            "syncmesh-docs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("device.db");
        let events = history();

        let mut memory = engine(5, false);
        memory.receive_batch(events.clone()).unwrap();
        let mut persisted = engine_over(
            5,
            false,
            Some(Box::new(SqliteDocStore::open(&path).unwrap())),
        );
        persisted.receive_batch(events).unwrap();
        assert_eq!(persisted.doc_log().unwrap(), memory.doc_log().unwrap());
        assert_eq!(persisted.doc_heads().unwrap(), memory.doc_heads().unwrap());
        drop(persisted);

        let reopened = SqliteDocStore::open(&path).unwrap();
        assert_eq!(reopened.entries().unwrap(), memory.doc_log().unwrap());
        assert_eq!(reopened.heads().unwrap(), memory.doc_heads().unwrap());
        let floor = reopened.uncovered_floor().unwrap();
        assert!(
            floor.values().all(|&f| f == 0),
            "nothing is covered: every author floors at 0"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_sqlite_tables_have_the_typescript_device_shape() {
        // the columns, types, NOT NULLs and keys of `storage/src/doc-tables.ts`'s sqlite tables
        let conn = rusqlite_shape();
        assert_eq!(
            conn.0,
            [
                ("author", "TEXT", true, 1),
                ("seq", "INTEGER", true, 2),
                ("idx", "INTEGER", true, 3),
                ("tbl", "TEXT", true, 0),
                ("key", "TEXT", true, 0),
                ("col", "TEXT", true, 0),
                ("lineage", "BLOB", false, 0),
                ("hlc_ms", "INTEGER", true, 0),
                ("hlc_logical", "INTEGER", true, 0),
                ("action", "BLOB", false, 0),
                ("undo_of", "BLOB", false, 0),
                ("blob", "TEXT", false, 0),
                ("size", "INTEGER", true, 0),
                ("state", "TEXT", true, 0),
            ]
            .map(|(n, t, nn, pk)| (n.to_owned(), t.to_owned(), nn, pk))
        );
        assert_eq!(conn.1, ["tbl", "key", "col", "state"]);
    }

    /// `sm_doc_log`'s columns and its one secondary index, as SQLite describes them.
    /// One column as `PRAGMA table_info` describes it: name, type, NOT NULL, place in the key.
    type Described = (String, String, bool, i64);

    fn rusqlite_shape() -> (Vec<Described>, Vec<String>) {
        let dir = std::env::temp_dir().join(format!("syncmesh-docs-shape-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shape.db");
        drop(SqliteDocStore::open(&path).unwrap());
        let conn = rusqlite::Connection::open(&path).unwrap();
        let mut info = conn.prepare("PRAGMA table_info(sm_doc_log)").unwrap();
        let columns = info
            .query_map([], |r| {
                Ok((r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? == 1, r.get(5)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let mut index = conn.prepare("PRAGMA index_info(sm_doc_log_doc)").unwrap();
        let indexed = index
            .query_map([], |r| r.get(2))
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap();
        let _ = std::fs::remove_dir_all(dir);
        (columns, indexed)
    }
}

/// `entry` re-signed by `seed` with every genesis in it marked as written under the lineage rule
/// before RFC-0023 §16.1 (key 5 `true`).
fn legacy(entry: &StoredEvent, seed: u8) -> StoredEvent {
    let mut event = entry.event.clone();
    for change in &mut event.changes {
        if let Change::Doc(d) = change {
            d.legacy = d.genesis;
        }
    }
    StoredEvent::from_verified(syncmesh_core::sign_event(
        event,
        &Identity::from_seed(&[seed; 32]),
    ))
}

#[test]
fn a_legacy_genesis_reads_back_from_the_wire_and_is_quarantined_at_admission() {
    let mut a = engine(1, true);
    let old = legacy(&write(&mut a, vec![insert(), replace(1)]), 1);
    let core = syncmesh_core::encode_event_core(&old.event);
    let decoded = syncmesh_core::decode_event_core(&core).unwrap();
    assert!(matches!(&decoded.changes[1], Change::Doc(d) if d.genesis && d.legacy));
    assert_eq!(syncmesh_core::encode_event_core(&decoded), core);

    let mut b = engine(2, true);
    b.receive(old.clone()).unwrap();
    let parked: Vec<String> = b.quarantine().iter().map(|p| p.entry.id()).collect();
    assert_eq!(parked, [old.id()]);
    assert_eq!(b.state().record("notes", "n1"), None);
}

/// A state store holding n1's record with its lineage cell as `value`, and the log it came from.
fn persisted_with(
    value: impl FnOnce(CellValue) -> CellValue,
) -> (MemoryStateStore, Vec<StoredEvent>) {
    let mut a = engine(1, true);
    write(&mut a, vec![insert(), replace(1)]);
    let mut record = a.state().record("notes", "n1").unwrap().clone();
    let cell = record.cells.get_mut("content").unwrap();
    cell.value = value(cell.value.clone());
    let mut store = MemoryStateStore::new();
    let row = RowWrite {
        table: "notes".into(),
        key: "n1".into(),
        record,
    };
    store.commit(&[row], &a.coverage()).unwrap();
    (store, a.all_events().unwrap())
}

fn open_over((store, log): (MemoryStateStore, Vec<StoredEvent>)) -> Result<Engine, StoreError> {
    let mut events = MemoryEventStore::new();
    for entry in &log {
        events.append(entry)?;
    }
    Engine::open(
        Identity::from_seed(&[1; 32]),
        Box::new(events),
        Some(Box::new(store)),
        EngineOptions {
            docs: Some(docs()),
            ..EngineOptions::default()
        },
    )
}

#[test]
fn persisted_state_holding_another_rules_lineage_cell_is_rebuilt_from_the_log() {
    let derived = |engine: &Engine| {
        Some(derive_lineage(
            engine.peer_id(),
            SeqNum::parse(1).unwrap(),
            1,
        ))
    };
    let opened = open_over(persisted_with(|tagged| tagged)).unwrap();
    assert_eq!(lineage(&opened), derived(&opened));
    assert!(opened.refused_at_open().is_none());

    let untag = |tagged: CellValue| match tagged {
        CellValue::Array(items) => CellValue::from(items[1].clone()),
        other => other,
    };
    let retag = |tagged: CellValue| match tagged {
        CellValue::Array(items) => CellValue::Array(vec![JsonValue::Number(2.0), items[1].clone()]),
        other => other,
    };
    for (persisted, found) in [
        (persisted_with(untag), "a lineage cell with no version"),
        (persisted_with(retag), "a lineage cell of version 2"),
    ] {
        // never read as the root: the state is the log's, refold for refold
        let rebuilt = open_over(persisted).expect("rebuilt from the log, not refused");
        let refused = rebuilt
            .refused_at_open()
            .expect("the refusal is kept for the host");
        assert!(refused.to_string().contains(found), "{refused}");
        assert_eq!(lineage(&rebuilt), derived(&rebuilt));
        assert_eq!(
            rebuilt.state().record("notes", "n1").unwrap().cells["title"].value,
            CellValue::text("t")
        );
    }
}

#[test]
fn unreadable_state_holding_rows_a_snapshot_installed_is_refused_not_rebuilt() {
    // the same refused cell, with a floor in the coverage: rows a snapshot installed are in no log
    let (mut store, log) = persisted_with(|tagged| match tagged {
        CellValue::Array(items) => CellValue::from(items[1].clone()),
        other => other,
    });
    let mut coverage = store.load_coverage().unwrap();
    let author = Identity::from_seed(&[9; 32]).peer_id().clone();
    coverage
        .synced
        .insert(author.clone(), SeqNum::parse(4).unwrap());
    coverage.floor.insert(author, SeqNum::parse(4).unwrap());
    store.commit(&[], &coverage).unwrap();
    let refused = match open_over((store, log)) {
        Ok(_) => panic!("a state the log cannot rebuild was rebuilt"),
        Err(e) => e,
    };
    assert!(refused.message.starts_with("StateCorrupt"), "{refused}");
}

#[test]
fn a_local_write_naming_a_derived_column_is_refused_and_a_numbered_one_folds() {
    let manifest = r#"[{ "column": "content", "doc": "loro@1", "derive": ["title"] }]"#;
    let entries = DocColumnEntry::parse_list(manifest).unwrap();
    let open = |seed: u8| {
        Engine::open(
            Identity::from_seed(&[seed; 32]),
            Box::new(MemoryEventStore::new()),
            None,
            EngineOptions {
                docs: Some(docs()),
                derived: derived_columns([("notes", entries.as_slice())]),
                ..EngineOptions::default()
            },
        )
        .unwrap()
    };
    let mut a = open(1);
    // `insert()` names `title`, which this schema derives from `content`
    let refused = a.mutate("notes.edit", vec![insert()], partition());
    assert!(
        matches!(&refused, Err(MutateError::DocRefused { reason, .. }) if reason.contains("derived")),
        "{refused:?}"
    );
    let patched = a.mutate(
        "notes.edit",
        vec![Change::Update {
            table: "notes".into(),
            key: "n1".into(),
            patch: BTreeMap::from([("title".to_owned(), CellValue::text("forged"))]),
        }],
        partition(),
    );
    assert!(matches!(patched, Err(MutateError::DocRefused { .. })));
    assert!(a.all_events().unwrap().is_empty());

    // history written by a build that does not derive it still folds, as in TypeScript
    let mut older = engine(2, true);
    let entry = write(&mut older, vec![insert()]);
    assert_eq!(a.receive(entry).unwrap().report.folded, 1);
}

#[test]
fn an_install_that_moves_the_winning_lineage_relabels_the_doc_log() {
    let mut a = engine(1, true);
    let mut b = engine(2, true);
    b.receive(write(&mut a, vec![insert()])).unwrap();
    // A's replace is the first stamp, so A's lineage wins wherever both are held
    write(&mut a, vec![replace(1)]);
    write(&mut b, vec![replace(2)]);
    let on_b = lineage(&b);
    let b_edit = write(&mut b, vec![edit(3, on_b)]);
    let mut r = engine(3, true);
    // B's log holds A's insert and B's own two writes
    r.receive_batch(b.events_since(&Default::default(), None).unwrap())
        .unwrap();
    assert_eq!(lineage(&r), on_b);
    assert_eq!(states(&r), [DocEntryState::Tail, DocEntryState::Tail]);
    assert_eq!(b_edit.event.seq_num.get(), 2);
    // A's state, never A's events: the rows carry A's genesis into the lineage cell
    r.install_snapshot(a.snapshot(None)).unwrap();
    assert_eq!(lineage(&r), lineage(&a), "the install moved the winner");
    assert_eq!(
        labels(&r, &b),
        BTreeMap::from([
            ((true, 1), DocEntryState::Orphaned),
            ((true, 2), DocEntryState::Orphaned),
        ])
    );
    let heads = r.doc_heads().unwrap();
    assert_eq!((heads[0].lineage, heads[0].tail_count), (lineage(&a), 0));
}

/// A store two engines open in turn, as a database outlives the process; `stopped` makes its
/// writes fail, as a process stopping between two commits leaves them.
#[derive(Default)]
struct Shared<T> {
    inner: std::sync::Arc<std::sync::Mutex<T>>,
    stopped: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl<T> Clone for Shared<T> {
    fn clone(&self) -> Shared<T> {
        Shared {
            inner: self.inner.clone(),
            stopped: self.stopped.clone(),
        }
    }
}

impl<T> Shared<T> {
    fn with<R>(&self, f: impl FnOnce(&mut T) -> R) -> R {
        f(&mut self.inner.lock().unwrap())
    }

    fn write<R>(&self, f: impl FnOnce(&mut T) -> Result<R, StoreError>) -> Result<R, StoreError> {
        if self.stopped.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(StoreError::new("stopped"));
        }
        self.with(f)
    }
}

impl StateStore for Shared<MemoryStateStore> {
    fn is_empty(&self) -> Result<bool, StoreError> {
        self.with(|s| s.is_empty())
    }
    fn load_all(&self) -> Result<syncmesh_core::state::State, StoreError> {
        self.with(|s| s.load_all())
    }
    fn load_coverage(&self) -> Result<syncmesh_client::Coverage, StoreError> {
        self.with(|s| s.load_coverage())
    }
    fn commit(
        &mut self,
        rows: &[RowWrite],
        coverage: &syncmesh_client::Coverage,
    ) -> Result<(), StoreError> {
        self.write(|s| s.commit(rows, coverage))
    }
    fn clear(&mut self) -> Result<(), StoreError> {
        self.write(|s| s.clear())
    }
}

impl DocStore for Shared<MemoryDocStore> {
    fn append(&mut self, entries: &[DocLogEntry]) -> Result<(), StoreError> {
        self.write(|s| s.append(entries))
    }
    fn entries(&self) -> Result<Vec<DocLogEntry>, StoreError> {
        self.with(|s| s.entries())
    }
    fn entries_of(&self, doc: &DocAddress) -> Result<Vec<DocLogEntry>, StoreError> {
        self.with(|s| s.entries_of(doc))
    }
    fn set_state(
        &mut self,
        author: &syncmesh_core::event::PeerId,
        seq: SeqNum,
        index: u32,
        state: DocEntryState,
    ) -> Result<(), StoreError> {
        self.write(|s| s.set_state(author, seq, index, state))
    }
    fn upsert_head(
        &mut self,
        doc: &DocAddress,
        adapter: &str,
        lineage: Option<Id16>,
        tail_count: u64,
        tail_bytes: u64,
    ) -> Result<(), StoreError> {
        self.write(|s| s.upsert_head(doc, adapter, lineage, tail_count, tail_bytes))
    }
    fn heads(&self) -> Result<Vec<DocHead>, StoreError> {
        self.with(|s| s.heads())
    }
    fn uncovered_floor(&self) -> Result<BTreeMap<syncmesh_core::event::PeerId, u64>, StoreError> {
        self.with(|s| s.uncovered_floor())
    }
}

#[test]
fn an_install_stopped_before_its_relabel_is_relabelled_at_the_next_open() {
    let mut a = engine(1, true);
    let mut b = engine(2, true);
    b.receive(write(&mut a, vec![insert()])).unwrap();
    write(&mut a, vec![replace(1)]);
    write(&mut b, vec![replace(2)]);
    let on_b = lineage(&b);
    write(&mut b, vec![edit(3, on_b)]);
    let (rows, docs) = (
        Shared::<MemoryStateStore>::default(),
        Shared::<MemoryDocStore>::default(),
    );
    let open = |events: MemoryEventStore| {
        Engine::open(
            Identity::from_seed(&[3; 32]),
            Box::new(events),
            Some(Box::new(rows.clone())),
            EngineOptions {
                docs: Some(self::docs()),
                doc_adapters: BTreeSet::from(["loro@1".to_owned()]),
                doc_store: Some(Box::new(docs.clone())),
                ..EngineOptions::default()
            },
        )
        .unwrap()
    };
    let mut r = open(MemoryEventStore::new());
    r.receive_batch(b.events_since(&Default::default(), None).unwrap())
        .unwrap();
    assert_eq!(lineage(&r), on_b);
    let log = r.all_events().unwrap();
    // the rows commit; the doc store stops before the relabel lands
    docs.stopped
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(r.install_snapshot(a.snapshot(None)).is_err());
    docs.stopped
        .store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(docs.with(|d| d.heads().unwrap())[0].lineage, on_b);
    drop(r);
    let mut events = MemoryEventStore::new();
    for entry in &log {
        events.append(entry).unwrap();
    }
    let reopened = open(events);
    assert_eq!(lineage(&reopened), lineage(&a), "the rows committed");
    assert_eq!(
        labels(&reopened, &b),
        BTreeMap::from([
            ((true, 1), DocEntryState::Orphaned),
            ((true, 2), DocEntryState::Orphaned),
        ])
    );
    let heads = reopened.doc_heads().unwrap();
    assert_eq!((heads[0].lineage, heads[0].tail_count), (lineage(&a), 0));
}
