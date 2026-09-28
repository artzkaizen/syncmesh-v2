//! Document columns in the Rust device, P2 (RFC-0023 §6, §10): the fold, the doc log beside it,
//! the `adapter-missing` mode, and the rules a declared doc column holds a change to — the same
//! properties `engine/src/__tests__/doc-fold.test.ts` and `doc-validate.test.ts` hold the
//! TypeScript to.

use std::collections::{BTreeMap, BTreeSet};

use syncmesh_client::doc_log::{DocEntryState, DocStore, doc_digests};
use syncmesh_client::{Engine, EngineOptions, MemoryEventStore, MutateError, StoredEvent};
use syncmesh_core::doc::{
    DocBlobRef, DocChange, DocColumns, DocUpdate, Id16, derive_lineage, lineage_of,
};
use syncmesh_core::event::{Change, PartitionKey, SeqNum, SyncEvent};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::CellValue;

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

#[test]
fn a_late_winning_genesis_relabels_the_edits_that_arrived_before_it() {
    let mut a = engine(1, true);
    let mut b = engine(2, true);
    let created = write(&mut a, vec![insert()]);
    b.receive(created.clone()).unwrap();
    let a_replace = write(&mut a, vec![replace(1)]);
    let b_replace = write(&mut b, vec![replace(2)]);
    let on_b = lineage(&b);
    let b_edit = write(&mut b, vec![edit(3, on_b)]);
    let mut r = engine(3, true);
    for entry in [created, b_edit, a_replace, b_replace.clone()] {
        r.receive(entry).unwrap();
    }
    assert_eq!(lineage(&r), lineage(&b), "B's replace is the later stamp");
    let by_author: BTreeMap<_, _> = r
        .doc_log()
        .unwrap()
        .into_iter()
        .map(|e| ((e.author == *b.peer_id(), e.seq.get()), e.state))
        .collect();
    assert_eq!(
        by_author,
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
            |e: &Engine| -> Vec<String> { e.quarantine().iter().map(|p| p.id()).collect() };
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
    };
    let entry = StoredEvent::from_verified(syncmesh_core::sign_event(forged, &forger));
    let report = a.receive(entry).unwrap().report;
    assert_eq!(report.quarantined, 1);
    assert!(a.doc_log().unwrap().is_empty());
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
