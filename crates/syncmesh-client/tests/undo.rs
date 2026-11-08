//! Revert in the Rust device (RFC-0023 §9, decided in §16.3): only the cells that still hold the
//! write's stamp are compensated, and a colleague's change made since survives the undo — the
//! same cases `engine/src/__tests__/undo-local.test.ts` holds the TypeScript to.

use syncmesh_client::engine::{RevertError, Reverted};
use syncmesh_client::undo::{SkipReason, Skipped};
use syncmesh_client::{Engine, EngineOptions, MemoryEventStore, StoredEvent};
use syncmesh_core::doc::{DocChange, DocUpdate};
use syncmesh_core::event::{Change, PartitionKey};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::{CellValue, Row};

/// An engine whose clock starts at `start` ms and moves one ms per reading.
fn engine(seed: u8, start: i64, undo_depth: usize) -> Engine {
    let n = std::sync::atomic::AtomicI64::new(0);
    Engine::open(
        Identity::from_seed(&[seed; 32]),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            undo_depth,
            now_ms: Some(Box::new(move || {
                start + n.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            })),
            ..EngineOptions::default()
        },
    )
    .unwrap()
}

fn row(pairs: &[(&str, &str)]) -> Row {
    pairs
        .iter()
        .map(|(c, v)| ((*c).to_owned(), CellValue::text(v)))
        .collect()
}

fn partition() -> Option<PartitionKey> {
    Some(PartitionKey::parse("workspace:w1").unwrap())
}

fn write(e: &mut Engine, change: Change) -> StoredEvent {
    e.mutate("notes.edit", vec![change], partition())
        .unwrap()
        .entry
}

fn insert(values: &[(&str, &str)]) -> Change {
    Change::Insert {
        table: "notes".into(),
        key: "n1".into(),
        row: row(values),
    }
}

fn update(values: &[(&str, &str)]) -> Change {
    Change::Update {
        table: "notes".into(),
        key: "n1".into(),
        patch: row(values),
    }
}

fn delete() -> Change {
    Change::Delete {
        table: "notes".into(),
        key: "n1".into(),
    }
}

fn read(e: &Engine) -> Option<Row> {
    e.state().read_row("notes", "n1")
}

fn superseded(column: Option<&str>) -> Skipped {
    Skipped {
        table: "notes".into(),
        key: "n1".into(),
        column: column.map(str::to_owned),
        reason: SkipReason::Superseded,
    }
}

/// A reverts; B's clock runs later, so B's writes land after A's.
fn pair() -> (Engine, Engine) {
    (engine(1, 100, 5), engine(2, 500, 0))
}

fn revert(e: &mut Engine, entry: &StoredEvent) -> Reverted {
    e.revert(&entry.id()).unwrap()
}

#[test]
fn reverting_an_update_restores_what_it_wrote_and_nothing_else() {
    let mut a = engine(1, 100, 3);
    write(&mut a, insert(&[("title", "t"), ("body", "b")]));
    let changed = write(&mut a, update(&[("title", "changed")]));
    write(&mut a, update(&[("body", "kept")]));
    let r = revert(&mut a, &changed);
    assert_eq!(read(&a), Some(row(&[("title", "t"), ("body", "kept")])));
    assert!(r.skipped.is_empty());
    let mutated = r.mutated.unwrap();
    assert_eq!(mutated.entry.event.procedure, "revert");
    assert_eq!(mutated.entry.event.partition, partition());
}

#[test]
fn reverting_an_insert_deletes_it_and_reverting_a_delete_restores_it() {
    let mut a = engine(1, 100, 3);
    let created = write(&mut a, insert(&[("title", "t")]));
    revert(&mut a, &created);
    assert_eq!(read(&a), None);
    write(&mut a, insert(&[("title", "x")]));
    let deleted = write(&mut a, delete());
    revert(&mut a, &deleted);
    assert_eq!(read(&a), Some(row(&[("title", "x")])));
}

#[test]
fn a_colleagues_concurrent_edit_survives_the_undo_and_is_reported_superseded() {
    let (mut a, mut b) = pair();
    b.receive(write(&mut a, insert(&[("title", "t"), ("body", "b")])))
        .unwrap();
    let mine = write(&mut a, update(&[("title", "mine"), ("body", "mine")]));
    b.receive(mine.clone()).unwrap();
    a.receive(write(&mut b, update(&[("body", "theirs")])))
        .unwrap();

    let r = revert(&mut a, &mine);
    assert_eq!(read(&a), Some(row(&[("title", "t"), ("body", "theirs")])));
    assert_eq!(r.skipped, [superseded(Some("body"))]);
    let entry = r.mutated.unwrap().entry;
    assert_eq!(entry.event.changes, [update(&[("title", "t")])]);
    b.receive(entry).unwrap();
    assert_eq!(read(&b), read(&a));
}

#[test]
fn when_every_cell_was_changed_since_nothing_is_written() {
    let (mut a, mut b) = pair();
    b.receive(write(&mut a, insert(&[("title", "t")]))).unwrap();
    let mine = write(&mut a, update(&[("title", "mine")]));
    b.receive(mine.clone()).unwrap();
    a.receive(write(&mut b, update(&[("title", "theirs")])))
        .unwrap();
    let r = revert(&mut a, &mine);
    assert!(r.mutated.is_none());
    assert_eq!(r.skipped, [superseded(Some("title"))]);
    assert_eq!(read(&a), Some(row(&[("title", "theirs")])));
    assert!(!a.can_revert(&mine.id()));
}

#[test]
fn an_update_is_not_undone_into_a_row_someone_deleted_since() {
    let (mut a, mut b) = pair();
    b.receive(write(&mut a, insert(&[("title", "t")]))).unwrap();
    let mine = write(&mut a, update(&[("title", "mine")]));
    b.receive(mine.clone()).unwrap();
    a.receive(write(&mut b, delete())).unwrap();
    let r = revert(&mut a, &mine);
    assert!(r.mutated.is_none());
    assert_eq!(r.skipped, [superseded(None)]);
    assert_eq!(read(&a), None);
}

#[test]
fn a_delete_is_not_undone_over_a_row_someone_wrote_again_since() {
    let (mut a, mut b) = pair();
    b.receive(write(&mut a, insert(&[("title", "t")]))).unwrap();
    let mine = write(&mut a, delete());
    b.receive(mine.clone()).unwrap();
    a.receive(write(&mut b, insert(&[("title", "again")])))
        .unwrap();
    let r = revert(&mut a, &mine);
    assert!(r.mutated.is_none());
    assert_eq!(r.skipped, [superseded(None)]);
    assert_eq!(read(&a), Some(row(&[("title", "again")])));
}

#[test]
fn a_write_of_document_updates_alone_is_refused_and_stays_revertable() {
    let mut a = engine(1, 100, 3);
    write(&mut a, insert(&[("title", "t")]));
    let doc = Change::Doc(DocChange {
        table: "notes".into(),
        key: "n1".into(),
        column: "content".into(),
        adapter: "loro@1".into(),
        lineage: None,
        update: DocUpdate::Bytes(vec![1]),
        genesis: false,
        legacy: false,
        parent: None,
    });
    let edited = write(&mut a, doc.clone());
    for _ in 0..2 {
        assert!(matches!(
            a.revert(&edited.id()),
            Err(RevertError::DocumentsOnly { .. })
        ));
    }
    // in a mixed write the row is compensated and the document reported
    let mixed = a
        .mutate(
            "notes.edit",
            vec![update(&[("title", "changed")]), doc],
            partition(),
        )
        .unwrap()
        .entry;
    let r = revert(&mut a, &mixed);
    assert_eq!(read(&a), Some(row(&[("title", "t")])));
    assert_eq!(
        r.skipped,
        [Skipped {
            table: "notes".into(),
            key: "n1".into(),
            column: Some("content".into()),
            reason: SkipReason::Document,
        }]
    );
}

#[test]
fn only_the_last_undo_depth_writes_are_revertable_and_a_revert_is_revertable() {
    let mut a = engine(1, 100, 2);
    let first = write(&mut a, insert(&[("n", "1")]));
    write(&mut a, update(&[("n", "2")]));
    let third = write(&mut a, update(&[("n", "3")]));
    assert!(!a.can_revert(&first.id()));
    assert!(matches!(
        a.revert(&first.id()),
        Err(RevertError::NotRevertable { .. })
    ));
    let undone = revert(&mut a, &third).mutated.unwrap().entry;
    assert_eq!(read(&a), Some(row(&[("n", "2")])));
    revert(&mut a, &undone);
    assert_eq!(read(&a), Some(row(&[("n", "3")])));
    let none = engine(3, 100, 0);
    assert!(!none.can_revert(&first.id()));
}
