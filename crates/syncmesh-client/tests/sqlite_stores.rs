#![cfg(feature = "sqlite")]
//! The SQLite pair against the store contract in `store.rs`, with real signed events, a real file
//! and a real restart: the connections are dropped and reopened between the writes and the reads.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use syncmesh_client::sqlite::{SqliteBlobStore, SqliteEventStore, open_in_memory, open_stores};
use syncmesh_client::store::{rows_for, write_keys_of};
use syncmesh_client::{
    Coverage, Cursors, Engine, EngineOptions, EventStore, MemoryEventStore, StateStore, StoredEvent,
};
use syncmesh_core::event::{Change, PeerId, SeqNum};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::CellValue;
use syncmesh_core::state::State;

fn identity(n: u8) -> Identity {
    Identity::from_seed(&[n; 32])
}

fn peer(n: u8) -> PeerId {
    identity(n).peer_id().clone()
}

fn insert(key: &str, body: &str) -> Change {
    let mut row = std::collections::BTreeMap::new();
    row.insert("body".to_owned(), CellValue::text(body));
    Change::Insert {
        table: "notes".into(),
        key: key.into(),
        row,
    }
}

fn memory_engine(n: u8) -> Engine {
    Engine::open(
        identity(n),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions::default(),
    )
    .unwrap()
}

/// `per_author` signed writes from each author, made by real engines over memory logs — the only
/// way to get an entry whose core and signature are the author's own.
fn signed_entries(authors: &[u8], per_author: usize) -> Vec<StoredEvent> {
    let mut out = Vec::new();
    for &n in authors {
        let mut engine = memory_engine(n);
        for i in 0..per_author {
            let key = format!("k{n}-{i}");
            out.push(
                engine
                    .mutate("notes.create", vec![insert(&key, "x")], None)
                    .unwrap()
                    .entry,
            );
        }
    }
    out
}

fn by_author_then_seq(entries: &[StoredEvent]) -> Vec<StoredEvent> {
    let mut sorted = entries.to_vec();
    sorted.sort_by(|a, b| {
        a.event
            .peer_id
            .cmp(&b.event.peer_id)
            .then(a.event.seq_num.cmp(&b.event.seq_num))
    });
    sorted
}

/// A fresh directory under the system temp dir, removed on drop. No `tempfile` dependency: the
/// crate has none and this file may not add one.
struct TempDir(PathBuf);

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

impl TempDir {
    fn new(name: &str) -> TempDir {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let unique = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "syncmesh-client-{name}-{}-{nanos}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("a temp dir can be made");
        TempDir(dir)
    }

    fn db(&self) -> PathBuf {
        self.0.join("device.db")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn append_has_all_since_last_seq_and_max_hlc_round_trip() {
    let entries = signed_entries(&[1, 2], 3);
    let mut log = SqliteEventStore::open_in_memory().unwrap();
    assert!(log.is_empty().unwrap());

    // idempotent by id, one at a time and in a batch
    log.append(&entries[0]).unwrap();
    log.append(&entries[0]).unwrap();
    log.append_batch(&entries[1..]).unwrap();
    log.append_batch(&entries).unwrap();
    assert_eq!(log.len().unwrap(), 6);

    for entry in &entries {
        assert!(log.has(&entry.id()).unwrap(), "{}", entry.id());
    }
    assert!(!log.has(&format!("{}-99", peer(1))).unwrap());
    assert!(!log.has("not an id").unwrap());

    // what comes back is what went in, core and signature byte for byte, by author then sequence
    let expected = by_author_then_seq(&entries);
    let all = log.all().unwrap();
    assert_eq!(all, expected);
    for (held, sent) in all.iter().zip(&expected) {
        assert_eq!(held.envelope(), sent.envelope());
        assert!(syncmesh_core::decode_and_verify(&held.envelope().unwrap()).is_ok());
    }

    assert_eq!(log.last_seq(&peer(1)).unwrap(), SeqNum::parse(3));
    assert_eq!(log.last_seq(&peer(2)).unwrap(), SeqNum::parse(3));
    assert_eq!(log.last_seq(&peer(3)).unwrap(), None);
    assert_eq!(
        log.max_hlc().unwrap(),
        entries.iter().map(|e| e.event.hlc).max()
    );

    // above one author's cursor, and everything of an author with no cursor
    let mut cursors = Cursors::new();
    cursors.insert(peer(1), SeqNum::parse(2).unwrap());
    let since = log.all_since(&cursors).unwrap();
    let want: Vec<StoredEvent> = expected
        .iter()
        .filter(|e| !(e.event.peer_id == peer(1) && e.event.seq_num.get() <= 2))
        .cloned()
        .collect();
    assert_eq!(since.len(), 4);
    assert_eq!(since, want);

    // nothing above the top, and everything above an empty cursor set
    cursors.insert(peer(1), SeqNum::parse(3).unwrap());
    cursors.insert(peer(2), SeqNum::parse(3).unwrap());
    assert!(log.all_since(&cursors).unwrap().is_empty());
    assert_eq!(log.all_since(&Cursors::new()).unwrap(), expected);
}

#[test]
fn state_commit_and_reopen_from_disk_reproduce_state_and_coverage() {
    let dir = TempDir::new("state");
    let entries = signed_entries(&[1, 2], 2);

    // a real folded state and its coverage, from an engine that received the entries
    let mut folder = memory_engine(9);
    folder.receive_batch(entries.clone()).unwrap();
    let state = folder.state().clone();
    let mut coverage = folder.coverage();
    coverage.scope = Some(r#"{"partitions":["org:a"]}"#.into());
    let rows = rows_for(&state, &write_keys_of(entries.iter().map(|e| &e.event)));
    assert_eq!(rows.len(), 4);

    {
        let (_, mut store) = open_stores(&dir.db()).unwrap();
        assert!(store.is_empty().unwrap());
        assert_eq!(store.load_all().unwrap(), State::new());
        assert_eq!(store.load_coverage().unwrap(), Coverage::default());
        store.commit(&rows, &coverage).unwrap();
        assert!(!store.is_empty().unwrap());
    }

    // the "process" ended above: both connections closed
    let (_, mut reopened) = open_stores(&dir.db()).unwrap();
    assert!(!reopened.is_empty().unwrap());
    assert_eq!(reopened.load_all().unwrap(), state);
    assert_eq!(reopened.load_coverage().unwrap(), coverage);

    // a commit with no rows still writes the coverage; a second commit of a row upserts it
    let mut later = coverage.clone();
    later.scope = None;
    later.synced.insert(peer(1), SeqNum::parse(9).unwrap());
    reopened.commit(&[], &later).unwrap();
    assert_eq!(reopened.load_coverage().unwrap(), later);
    reopened.commit(&rows[..1], &later).unwrap();
    assert_eq!(reopened.load_all().unwrap(), state);

    reopened.clear().unwrap();
    assert!(reopened.is_empty().unwrap());
    assert_eq!(reopened.load_all().unwrap(), State::new());
    assert_eq!(reopened.load_coverage().unwrap(), Coverage::default());
}

#[test]
fn a_corrupt_record_blob_makes_load_all_an_error_never_a_partial_state() {
    let dir = TempDir::new("corrupt");
    let entries = signed_entries(&[1], 3);
    let mut folder = memory_engine(9);
    folder.receive_batch(entries.clone()).unwrap();
    let rows = rows_for(
        folder.state(),
        &write_keys_of(entries.iter().map(|e| &e.event)),
    );
    let coverage = folder.coverage();
    {
        let (_, mut store) = open_stores(&dir.db()).unwrap();
        store.commit(&rows, &coverage).unwrap();
    }

    // one row's bytes rot; the other two are sound
    {
        let raw = rusqlite::Connection::open(dir.db()).unwrap();
        let changed = raw
            .execute(
                "UPDATE sm_state SET record = x'ff01' WHERE tbl = 'notes' AND key = 'k1-1'",
                [],
            )
            .unwrap();
        assert_eq!(changed, 1);
    }

    let (_, store) = open_stores(&dir.db()).unwrap();
    let err = store.load_all().unwrap_err();
    assert!(err.message.contains("k1-1"), "{err}");
    assert!(err.message.contains("does not decode"), "{err}");
    // the coverage is still readable: the damage is one row, not the cache's shape
    assert_eq!(store.load_coverage().unwrap(), coverage);
    assert!(!store.is_empty().unwrap());
}

#[test]
fn an_engine_reopens_over_the_sqlite_pair_after_a_restart() {
    let dir = TempDir::new("restart");
    let foreign = signed_entries(&[2], 3);

    let (state_before, cursors_before, top_before) = {
        let (log, rows) = open_stores(&dir.db()).unwrap();
        let mut a = Engine::open(
            identity(1),
            Box::new(log),
            Some(Box::new(rows)),
            EngineOptions::default(),
        )
        .unwrap();
        a.mutate("notes.create", vec![insert("mine-1", "a")], None)
            .unwrap();
        a.mutate("notes.create", vec![insert("mine-2", "b")], None)
            .unwrap();
        let received = a.receive_batch(foreign[..2].to_vec()).unwrap();
        assert_eq!(received.report.folded, 2);
        let top = a
            .all_events()
            .unwrap()
            .iter()
            .map(|e| e.event.hlc)
            .max()
            .unwrap();
        (a.state().clone(), a.cursors(), top)
    };
    // dropped: both connections closed, as a process exit would

    // a write that reached the log but never the state store — the crash between the two
    {
        let mut log = SqliteEventStore::open(&dir.db()).unwrap();
        log.append(&foreign[2]).unwrap();
    }

    let (log, rows) = open_stores(&dir.db()).unwrap();
    let mut a = Engine::open(
        identity(1),
        Box::new(log),
        Some(Box::new(rows)),
        EngineOptions::default(),
    )
    .unwrap();

    // what the state store held, plus the log above it
    let mut expected_cursors = cursors_before.clone();
    expected_cursors.insert(peer(2), SeqNum::parse(3).unwrap());
    assert_eq!(a.cursors(), expected_cursors);
    assert!(a.ahead().is_empty());
    for key in ["mine-1", "mine-2", "k2-0", "k2-1", "k2-2"] {
        assert!(a.state().read_row("notes", key).is_some(), "{key}");
    }
    for (table, records) in &state_before.tables {
        for (key, record) in records {
            assert_eq!(a.state().record(table, key), Some(record), "{table}/{key}");
        }
    }
    assert_eq!(a.all_events().unwrap().len(), 5);

    // numbering and the clock continue above everything held
    let next = a
        .mutate("notes.create", vec![insert("mine-3", "c")], None)
        .unwrap()
        .entry;
    assert_eq!(next.event.seq_num.get(), 3);
    assert!(next.event.hlc > top_before);
    assert!(next.event.hlc > foreign[2].event.hlc);
    drop(a);

    // the replay and the new write both reached the state store, so a third open replays nothing
    let (log, rows) = open_stores(&dir.db()).unwrap();
    let coverage = rows.load_coverage().unwrap();
    assert_eq!(coverage.synced[&peer(1)].get(), 3);
    assert_eq!(coverage.synced[&peer(2)].get(), 3);
    assert!(log.all_since(&coverage.synced).unwrap().is_empty());
    let again = Engine::open(
        identity(1),
        Box::new(log),
        Some(Box::new(rows)),
        EngineOptions::default(),
    )
    .unwrap();
    assert!(again.state().read_row("notes", "mine-3").is_some());
    assert_eq!(again.cursors(), coverage.synced);
}

#[test]
fn the_in_memory_pair_serves_an_engine_and_two_authors_converge_through_it() {
    let (log, rows) = open_in_memory().unwrap();
    let mut a = Engine::open(
        identity(1),
        Box::new(log),
        Some(Box::new(rows)),
        EngineOptions::default(),
    )
    .unwrap();
    let mut b = memory_engine(2);
    let from_a = a
        .mutate("notes.create", vec![insert("n1", "from a")], None)
        .unwrap()
        .entry;
    let from_b = b
        .mutate("notes.create", vec![insert("n2", "from b")], None)
        .unwrap()
        .entry;
    let wire = from_a.envelope().unwrap();
    b.receive(StoredEvent::from_verified(
        syncmesh_core::decode_and_verify(&wire).unwrap(),
    ))
    .unwrap();
    a.receive(StoredEvent::from_verified(
        syncmesh_core::decode_and_verify(&from_b.envelope().unwrap()).unwrap(),
    ))
    .unwrap();
    assert_eq!(a.state(), b.state());
    assert_eq!(a.cursors(), b.cursors());
    // a forwards a's own bytes and b's bytes exactly as they were signed
    let held: Vec<Vec<u8>> = a
        .all_events()
        .unwrap()
        .iter()
        .map(|e| e.envelope().unwrap())
        .collect();
    assert!(held.contains(&wire));
    assert!(held.contains(&from_b.envelope().unwrap()));
}

#[test]
fn blobs_persist_across_reopen_and_share_the_file_with_the_stores() {
    let dir = TempDir::new("blobs");
    {
        let (mut log, _) = open_stores(&dir.db()).unwrap();
        log.append(&signed_entries(&[1], 1)[0]).unwrap();
        let mut blobs = SqliteBlobStore::open(&dir.db()).unwrap();
        blobs.put("sha256:abc", &[1, 2, 3]).unwrap();
        blobs.put("sha256:abc", &[9, 9, 9]).unwrap();
        assert!(blobs.has("sha256:abc").unwrap());
    }
    let blobs = SqliteBlobStore::open(&dir.db()).unwrap();
    assert_eq!(blobs.get("sha256:abc").unwrap(), Some(vec![1, 2, 3]));
    assert_eq!(blobs.get("sha256:missing").unwrap(), None);
    let (log, _) = open_stores(&dir.db()).unwrap();
    assert_eq!(log.len().unwrap(), 1);
}
