//! Revert in the Rust device (RFC-0023 §9, decided in §16.3): only the cells that still hold the
//! write's stamp are compensated, and a colleague's change made since survives the undo — the
//! same cases `engine/src/__tests__/undo-local.test.ts` holds the TypeScript to.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use syncmesh_client::engine::{RevertError, Reverted};
use syncmesh_client::store::{Cursors, EventStore, StoreError};
use syncmesh_client::undo::{SkipReason, Skipped};
use syncmesh_client::{Engine, EngineOptions, MemoryEventStore, StoredEvent};
use syncmesh_core::doc::{DocChange, DocUpdate, lineage_of};
use syncmesh_core::event::{Change, PartitionKey, PeerId, SeqNum};
use syncmesh_core::hlc::Hlc;
use syncmesh_core::identity::Identity;
use syncmesh_core::record::{CellValue, JsonValue, Row};
use syncmesh_core::strategy::{StrategyName, counter_value};

/// An engine whose clock starts at `start` ms and moves one ms per reading.
fn engine(seed: u8, start: i64, undo_depth: usize) -> Engine {
    engine_with(
        seed,
        start,
        Box::new(MemoryEventStore::new()),
        EngineOptions {
            undo_depth,
            ..EngineOptions::default()
        },
    )
}

/// [`engine`] over `store`, with `options` beside the clock.
fn engine_with(
    seed: u8,
    start: i64,
    store: Box<dyn EventStore + Send>,
    options: EngineOptions,
) -> Engine {
    let n = std::sync::atomic::AtomicI64::new(0);
    Engine::open(
        Identity::from_seed(&[seed; 32]),
        store,
        None,
        EngineOptions {
            now_ms: Some(Box::new(move || {
                start + n.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            })),
            ..options
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
        rule: None,
        parent: None,
        settles: None,
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

fn skipped(column: Option<&str>, reason: SkipReason) -> Skipped {
    Skipped {
        table: "notes".into(),
        key: "n1".into(),
        column: column.map(str::to_owned),
        reason,
    }
}

fn increment(n: f64) -> CellValue {
    CellValue::Object(BTreeMap::from([("+".to_owned(), JsonValue::Number(n))]))
}

fn cells(pairs: Vec<(&str, CellValue)>) -> Row {
    pairs.into_iter().map(|(c, v)| (c.to_owned(), v)).collect()
}

/// An engine whose `views` column is a counter and `score` a max.
fn ruled() -> Engine {
    let rules = BTreeMap::from([
        ("views".to_owned(), StrategyName::Counter),
        ("score".to_owned(), StrategyName::Max),
    ]);
    engine_with(
        1,
        100,
        Box::new(MemoryEventStore::new()),
        EngineOptions {
            undo_depth: 3,
            merge: Some(BTreeMap::from([("notes".to_owned(), rules)])),
            ..EngineOptions::default()
        },
    )
}

#[test]
fn a_counter_increment_is_undone_by_the_increment_that_cancels_it() {
    let mut a = ruled();
    let views = |e: &Engine| counter_value(&read(e).unwrap()["views"]);
    write(
        &mut a,
        Change::Insert {
            table: "notes".into(),
            key: "n1".into(),
            row: cells(vec![("views", increment(2.0))]),
        },
    );
    let e = write(
        &mut a,
        Change::Update {
            table: "notes".into(),
            key: "n1".into(),
            patch: cells(vec![("views", increment(5.0))]),
        },
    );
    assert_eq!(views(&a), 7.0);
    let r = revert(&mut a, &e);
    assert_eq!(views(&a), 2.0);
    assert!(r.skipped.is_empty());
    assert_eq!(
        r.mutated.unwrap().entry.event.changes,
        [Change::Update {
            table: "notes".into(),
            key: "n1".into(),
            patch: cells(vec![("views", increment(-5.0))]),
        }]
    );
}

#[test]
fn a_max_cell_the_write_raised_cannot_come_back_down_and_says_so() {
    let mut a = ruled();
    write(
        &mut a,
        Change::Insert {
            table: "notes".into(),
            key: "n1".into(),
            row: cells(vec![
                ("title", CellValue::text("t")),
                ("score", CellValue::Number(3.0)),
            ]),
        },
    );
    let e = write(
        &mut a,
        Change::Update {
            table: "notes".into(),
            key: "n1".into(),
            patch: cells(vec![
                ("title", CellValue::text("x")),
                ("score", CellValue::Number(9.0)),
            ]),
        },
    );
    let r = revert(&mut a, &e);
    assert_eq!(r.skipped, [skipped(Some("score"), SkipReason::Merge)]);
    assert_eq!(
        r.mutated.unwrap().entry.event.changes,
        [update(&[("title", "t")])]
    );
    assert_eq!(
        read(&a),
        Some(cells(vec![
            ("title", CellValue::text("t")),
            ("score", CellValue::Number(9.0)),
        ]))
    );
}

#[test]
fn an_insert_whose_row_is_gone_already_writes_nothing() {
    let mut a = engine(1, 100, 3);
    let created = write(&mut a, insert(&[("title", "t")]));
    write(&mut a, delete());
    let r = revert(&mut a, &created);
    assert!(r.mutated.is_none());
    assert_eq!(r.skipped, [superseded(None)]);
}

#[test]
fn an_insert_a_colleague_edited_since_is_deleted_and_their_cells_reported_overridden() {
    let (mut a, mut b) = pair();
    let created = write(&mut a, insert(&[("title", "t")]));
    b.receive(created.clone()).unwrap();
    a.receive(write(&mut b, update(&[("body", "theirs")])))
        .unwrap();
    let r = revert(&mut a, &created);
    assert_eq!(read(&a), None);
    assert_eq!(r.skipped, [skipped(Some("body"), SkipReason::Overridden)]);
}

/// A memory log whose appends fail while `failing` is set.
struct Flaky {
    inner: MemoryEventStore,
    failing: Arc<AtomicBool>,
}

impl EventStore for Flaky {
    fn append(&mut self, entry: &StoredEvent) -> Result<(), StoreError> {
        if self.failing.load(Ordering::Relaxed) {
            return Err(StoreError::new("refused for the test"));
        }
        self.inner.append(entry)
    }
    fn has(&self, id: &str) -> Result<bool, StoreError> {
        self.inner.has(id)
    }
    fn all(&self) -> Result<Vec<StoredEvent>, StoreError> {
        self.inner.all()
    }
    fn all_since(&self, cursors: &Cursors) -> Result<Vec<StoredEvent>, StoreError> {
        self.inner.all_since(cursors)
    }
    fn local_since(&self, cursors: &Cursors) -> Result<Vec<StoredEvent>, StoreError> {
        self.inner.local_since(cursors)
    }
    fn last_seq(&self, peer: &PeerId) -> Result<Option<SeqNum>, StoreError> {
        self.inner.last_seq(peer)
    }
    fn last_local_seq(&self, peer: &PeerId) -> Result<Option<SeqNum>, StoreError> {
        self.inner.last_local_seq(peer)
    }
    fn max_hlc(&self) -> Result<Option<Hlc>, StoreError> {
        self.inner.max_hlc()
    }
    fn installed_below(&self) -> Result<Cursors, StoreError> {
        self.inner.installed_below()
    }
    fn record_installed(&mut self, floor: &Cursors) -> Result<(), StoreError> {
        self.inner.record_installed(floor)
    }
}

#[test]
fn a_compensation_the_engine_refuses_leaves_the_write_revertable() {
    let failing = Arc::new(AtomicBool::new(false));
    let store = Flaky {
        inner: MemoryEventStore::new(),
        failing: Arc::clone(&failing),
    };
    let mut a = engine_with(
        1,
        100,
        Box::new(store),
        EngineOptions {
            undo_depth: 3,
            ..EngineOptions::default()
        },
    );
    write(&mut a, insert(&[("title", "t")]));
    let changed = write(&mut a, update(&[("title", "x")]));
    failing.store(true, Ordering::Relaxed);
    assert!(matches!(
        a.revert(&changed.id()),
        Err(RevertError::Mutate(_))
    ));
    assert!(a.can_revert(&changed.id()));
    failing.store(false, Ordering::Relaxed);
    revert(&mut a, &changed);
    assert_eq!(read(&a), Some(row(&[("title", "t")])));
}

#[test]
fn a_delete_of_a_replaced_documents_row_comes_back_with_its_lineage() {
    let mut a = engine_with(
        1,
        100,
        Box::new(MemoryEventStore::new()),
        EngineOptions {
            undo_depth: 5,
            docs: Some(BTreeMap::from([(
                "notes".to_owned(),
                BTreeMap::from([("content".to_owned(), "loro@1".to_owned())]),
            )])),
            doc_adapters: BTreeSet::from(["loro@1".to_owned()]),
            ..EngineOptions::default()
        },
    );
    write(&mut a, insert(&[("title", "t")]));
    write(
        &mut a,
        Change::Doc(DocChange {
            table: "notes".into(),
            key: "n1".into(),
            column: "content".into(),
            adapter: "loro@1".into(),
            lineage: None,
            update: DocUpdate::Bytes(vec![1]),
            genesis: true,
            legacy: false,
            rule: None,
            parent: None,
            settles: None,
        }),
    );
    let lineage = lineage_of(a.state().record("notes", "n1"), "content");
    assert!(lineage.is_some());
    let deleted = write(&mut a, delete());
    let r = revert(&mut a, &deleted);
    assert_eq!(
        r.mutated.unwrap().entry.event.changes,
        [insert(&[("title", "t")])]
    );
    assert_eq!(
        lineage_of(a.state().record("notes", "n1"), "content"),
        lineage
    );
    assert!(!a.can_revert(&deleted.id()));
}
