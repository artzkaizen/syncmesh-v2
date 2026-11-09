//! The join exchange and D46's rejoin from state in the Rust device, the properties
//! `transport/src/__tests__/join.test.ts`, `rejoin.test.ts` and `resurrection.test.ts` hold the
//! TypeScript to: state instead of history, adoption only once every page is here, an unasked
//! manifest installing nothing, the per-author bound, and the four `$recovery` reasons.

use std::collections::BTreeMap;

use syncmesh_client::{
    Accepted, BelowFloor, BelowFloorReason, Cursors, Engine, EngineOptions, FloorSource, Interest,
    JoinExchange, JoinOptions, JoinOutcome, JoinPolicy, MemoryEventStore, MemoryStateStore,
    PeerJoin, Rejoins, Settled, StateStore, Withheld,
};
use syncmesh_core::checkpoint::{
    CheckpointRequest, CheckpointRow, checkpoint_hash, issue_checkpoint,
};
use syncmesh_core::doc::DocColumns;
use syncmesh_core::event::{Change, PartitionKey, PeerId, SeqNum};
use syncmesh_core::frames::{Frame, SnapshotFrame, decode_frame, snap_manifest_frame};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::CellValue;

fn identity(n: u8) -> Identity {
    Identity::from_seed(&[n; 32])
}

fn engine_with(n: u8, docs: Option<DocColumns>) -> Engine {
    let tick = std::sync::atomic::AtomicI64::new(0);
    Engine::open(
        identity(n),
        Box::new(MemoryEventStore::new()),
        Some(Box::new(MemoryStateStore::new())),
        EngineOptions {
            docs,
            now_ms: Some(Box::new(move || {
                1_700_000_000_000 + tick.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            })),
            ..EngineOptions::default()
        },
    )
    .unwrap()
}

fn engine(n: u8) -> Engine {
    engine_with(n, None)
}

fn part(p: &str) -> PartitionKey {
    PartitionKey::parse(p).unwrap()
}

fn insert(key: &str, body: &str) -> Change {
    Change::Insert {
        table: "notes".into(),
        key: key.into(),
        row: BTreeMap::from([("body".to_owned(), CellValue::text(body))]),
    }
}

fn write(e: &mut Engine, key: &str, partition: Option<&str>) {
    e.mutate("notes.create", vec![insert(key, key)], partition.map(part))
        .unwrap();
}

fn snapshot_frame(bytes: &[u8]) -> SnapshotFrame {
    match decode_frame(bytes).unwrap() {
        Frame::Snapshot(f) => f,
        other => panic!("not a snapshot frame: {}", other.kind()),
    }
}

fn seq(n: u64) -> SeqNum {
    SeqNum::parse(n).unwrap()
}

fn at(author: &PeerId) -> impl Fn(&Engine) -> u64 + '_ {
    move |e| e.cursors().get(author).map_or(0, |s| s.get())
}

/// One side of a session: its engine and its exchange.
struct Side {
    engine: Engine,
    join: JoinExchange,
}

fn side(engine: Engine, options: JoinOptions) -> Side {
    Side {
        engine,
        join: JoinExchange::new(options),
    }
}

/// Carries frames between the two sides until neither has anything left to say; `drop` names the
/// chunk indexes the link loses once each. Returns every install that settled on either side.
fn run(from: &mut Side, to: &mut Side, first: Vec<Vec<u8>>, drop: &mut Vec<u64>) -> Vec<Settled> {
    let mut settled = Vec::new();
    let mut flight = first;
    let mut towards_to = true;
    while !flight.is_empty() {
        let mut next = Vec::new();
        let (target, _) = if towards_to {
            (&mut *to, &mut *from)
        } else {
            (&mut *from, &mut *to)
        };
        for bytes in flight {
            let frame = snapshot_frame(&bytes);
            if let SnapshotFrame::Chunk { index, .. } = &frame
                && let Some(at) = drop.iter().position(|d| d == index)
            {
                drop.remove(at);
                continue;
            }
            let step = target.join.dispatch(&mut target.engine, frame).unwrap();
            next.extend(step.send);
            settled.extend(step.settled);
        }
        flight = next;
        towards_to = !towards_to;
    }
    settled
}

#[test]
fn a_cold_join_installs_state_and_adopts_only_what_its_policy_allows() {
    let mut holder = side(engine(1), JoinOptions::new("holder"));
    for k in ["a", "b", "c"] {
        write(&mut holder.engine, k, None);
    }
    let author = holder.engine.peer_id().clone();

    // a device empty by chance takes the rows and keeps its own coverage
    let mut joiner = side(engine(2), JoinOptions::new("joiner"));
    let (ticket, ask) = joiner.join.request(None, false);
    let settled = run(&mut joiner, &mut holder, vec![ask], &mut vec![]);
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0].ticket, ticket);
    let JoinOutcome::Installed { installed, vouched } = &settled[0].outcome else {
        panic!("refused")
    };
    assert_eq!(
        (installed.rows, installed.provisional, *vouched),
        (3, true, false)
    );
    assert!(joiner.engine.state().read_row("notes", "b").is_some());
    assert_eq!(
        at(&author)(&joiner.engine),
        0,
        "nothing vouched, nothing adopted"
    );
    assert!(joiner.engine.floor().is_empty());

    // a rebuild takes the coverage, and with it a floor: the log holds none of those events
    let mut rebuilt = side(engine(3), JoinOptions::new("rebuilt"));
    let (_, ask) = rebuilt.join.request(None, true);
    run(&mut rebuilt, &mut holder, vec![ask], &mut vec![]);
    assert_eq!(at(&author)(&rebuilt.engine), 3);
    assert_eq!(rebuilt.engine.floor()[&author].get(), 3);
}

#[test]
fn a_manifest_nobody_asked_for_installs_nothing() {
    // gaps U20: with or without trust, an unasked manifest with a huge `at` changes nothing
    for trust in [None, Some(identity(9).peer_id().clone())] {
        let mut victim = engine(2);
        let mut options = JoinOptions::new("victim");
        options.trust = trust;
        let mut join = JoinExchange::new(options);
        let author = identity(1).peer_id().clone();
        let forged = snap_manifest_frame(
            "evil:1",
            0,
            0,
            &[(author.clone(), seq(1_000_000))],
            None,
            None,
        );
        let step = join.dispatch(&mut victim, snapshot_frame(&forged)).unwrap();
        assert!(step.send.is_empty() && step.settled.is_none());
        assert_eq!(at(&author)(&victim), 0);
        assert!(victim.floor().is_empty());
    }
}

#[test]
fn a_lost_page_is_named_at_the_last_one_and_sent_again() {
    let mut options = JoinOptions::new("holder");
    options.rows_per_chunk = 1;
    let mut holder = side(engine(1), options);
    for k in ["a", "b", "c"] {
        write(&mut holder.engine, k, None);
    }
    let mut joiner = side(engine(2), JoinOptions::new("joiner"));
    let (_, ask) = joiner.join.request(None, true);
    let settled = run(&mut joiner, &mut holder, vec![ask], &mut vec![1]);
    assert_eq!(settled.len(), 1);
    for k in ["a", "b", "c"] {
        assert!(joiner.engine.state().read_row("notes", k).is_some(), "{k}");
    }
    assert_eq!(at(holder.engine.peer_id())(&joiner.engine), 3);
}

/// The authority's certificate over exactly the holder's rows, as `issueCheckpoint` mints one.
fn certificate(issuer: &Identity, holder: &Engine, coverage: u64) -> Vec<u8> {
    let rows: Vec<CheckpointRow> = holder
        .snapshot(None)
        .rows
        .iter()
        .map(|r| CheckpointRow {
            table: r.table.clone(),
            key: r.key.clone(),
            record: r.record_bytes(),
        })
        .collect();
    issue_checkpoint(
        issuer,
        &CheckpointRequest {
            partition: None,
            state_hash: checkpoint_hash(&rows).to_vec(),
            coverage: BTreeMap::from([(holder.peer_id().clone(), coverage)]),
            now_ms: 1_700_000_000_000,
        },
    )
}

#[test]
fn a_vouched_answer_adopts_what_the_certificate_signs_not_the_manifests_at() {
    let issuer = identity(9);
    let mut holder_engine = engine(1);
    for k in ["a", "b", "c"] {
        write(&mut holder_engine, k, None);
    }
    let author = holder_engine.peer_id().clone();
    // a genuine certificate for two events, relayed beside a state that claims three
    let mut options = JoinOptions::new("holder");
    options.certificate = Some(certificate(&issuer, &holder_engine, 2));
    let mut holder = side(holder_engine, options);
    let mut options = JoinOptions::new("joiner");
    options.trust = Some(issuer.peer_id().clone());
    let mut joiner = side(engine(2), options);
    let (_, ask) = joiner.join.request(None, false);
    let settled = run(&mut joiner, &mut holder, vec![ask], &mut vec![]);
    let JoinOutcome::Installed { installed, vouched } = &settled[0].outcome else {
        panic!("refused")
    };
    assert!(*vouched && !installed.provisional);
    assert_eq!(at(&author)(&joiner.engine), 2);

    // the same certificate over rows that were altered vouches for nothing
    holder
        .engine
        .mutate("notes.edit", vec![insert("a", "changed")], None)
        .unwrap();
    let mut late = side(engine(3), {
        let mut o = JoinOptions::new("late");
        o.trust = Some(issuer.peer_id().clone());
        o
    });
    let (_, ask) = late.join.request(None, false);
    let settled = run(&mut late, &mut holder, vec![ask], &mut vec![]);
    let JoinOutcome::Installed { vouched, .. } = &settled[0].outcome else {
        panic!("refused")
    };
    assert!(!vouched);
    assert_eq!(at(&author)(&late.engine), 0);
}

#[test]
fn a_sender_scoped_to_another_slice_claims_no_coverage() {
    let mut holder_engine = engine(1);
    write(&mut holder_engine, "a", Some("org:a"));
    write(&mut holder_engine, "b", Some("org:b"));
    let scope = Interest::partitions([part("org:a")]);
    let mut scoped = holder_engine.coverage();
    scoped.scope = Some(syncmesh_client::interest_text(Some(&scope)));
    holder_engine.adopt_coverage(&scoped);
    let author = holder_engine.peer_id().clone();
    let mut holder = side(holder_engine, JoinOptions::new("holder"));

    let mut inside = side(engine(2), JoinOptions::new("inside"));
    let (_, ask) = inside.join.request(Some(&scope), true);
    run(&mut inside, &mut holder, vec![ask], &mut vec![]);
    assert_eq!(at(&author)(&inside.engine), 2);
    assert_eq!(
        inside.engine.coverage().scope.as_deref(),
        Some(r#"{"partitions":["org:a"]}"#)
    );
    assert!(inside.engine.state().read_row("notes", "b").is_none());

    let other = Interest::partitions([part("org:b")]);
    let mut outside = side(engine(3), JoinOptions::new("outside"));
    let (_, ask) = outside.join.request(Some(&other), true);
    run(&mut outside, &mut holder, vec![ask], &mut vec![]);
    assert!(outside.engine.state().read_row("notes", "b").is_some());
    assert_eq!(
        at(&author)(&outside.engine),
        0,
        "the holder does not hold org:b's run"
    );
}

#[test]
fn a_sender_under_a_window_claims_no_coverage_even_for_that_window() {
    // events are never windowed, so a holder under a window may hold a row in part (D23)
    let mut holder_engine = engine(1);
    write(&mut holder_engine, "a", Some("org:a"));
    write(&mut holder_engine, "b", Some("org:a"));
    let windowed = Interest::partitions([part("org:a")]).windowed(1);
    let mut scoped = holder_engine.coverage();
    scoped.scope = Some(syncmesh_client::interest_text(Some(&windowed)));
    holder_engine.adopt_coverage(&scoped);
    let author = holder_engine.peer_id().clone();
    let mut holder = side(holder_engine, JoinOptions::new("holder"));

    let mut joiner = side(engine(2), JoinOptions::new("joiner"));
    let (_, ask) = joiner.join.request(Some(&windowed), true);
    run(&mut joiner, &mut holder, vec![ask], &mut vec![]);
    assert!(joiner.engine.state().read_row("notes", "b").is_some());
    assert_eq!(
        at(&author)(&joiner.engine),
        0,
        "a window's rows are not claimed whole"
    );
}

#[test]
fn withheld_tables_travel_in_no_snapshot_and_their_author_is_claimed_by_none() {
    let mut holder_engine = engine(1);
    write(&mut holder_engine, "a", None);
    holder_engine
        .mutate(
            "feed.post",
            vec![Change::Insert {
                table: "feed".into(),
                key: "f1".into(),
                row: BTreeMap::from([("line".to_owned(), CellValue::text("x"))]),
            }],
            None,
        )
        .unwrap();
    let author = holder_engine.peer_id().clone();
    let mut options = JoinOptions::new("holder");
    options.withheld = Some(Withheld {
        tables: ["feed".to_owned()].into(),
        author: Some(author.clone()),
    });
    let mut holder = side(holder_engine, options);
    let mut joiner = side(engine(2), JoinOptions::new("joiner"));
    let (_, ask) = joiner.join.request(None, true);
    run(&mut joiner, &mut holder, vec![ask], &mut vec![]);
    assert!(joiner.engine.state().read_row("notes", "a").is_some());
    assert!(joiner.engine.state().read_row("feed", "f1").is_none());
    assert_eq!(at(&author)(&joiner.engine), 0);
}

#[test]
fn a_floor_bounds_what_unvouched_state_adopts_per_author() {
    let mut holder = side(engine(1), JoinOptions::new("holder"));
    for k in ["a", "b", "c", "d"] {
        write(&mut holder.engine, k, None);
    }
    let mut other = engine(5);
    write(&mut other, "x", None);
    let wire = other.events_since(&Cursors::new(), None).unwrap();
    holder.engine.receive_batch(wire).unwrap();
    let (a, b) = (holder.engine.peer_id().clone(), other.peer_id().clone());
    let mut joiner = side(engine(2), JoinOptions::new("joiner"));
    let policy = JoinPolicy {
        adopt_unvouched: true,
        floor: Some(Cursors::from([(a.clone(), seq(2))])),
    };
    let (_, ask) = joiner.join.request_under(None, policy);
    run(&mut joiner, &mut holder, vec![ask], &mut vec![]);
    assert_eq!(at(&a)(&joiner.engine), 2, "capped at the claimed floor");
    assert_eq!(
        at(&b)(&joiner.engine),
        0,
        "an author not below the floor is not adopted"
    );
}

/// A cursors frame's parts from `holder` claiming `floor` for its own author.
fn claim(holder: &Engine, floor: u64) -> (PeerId, Cursors, Cursors) {
    let author = holder.peer_id().clone();
    (
        author.clone(),
        holder.cursors(),
        Cursors::from([(author, seq(floor))]),
    )
}

#[test]
fn below_a_trusted_peers_floor_the_device_asks_and_a_vouched_install_clears_it() {
    let issuer = identity(9);
    let mut holder_engine = engine(1);
    for k in ["a", "b", "c"] {
        write(&mut holder_engine, k, None);
    }
    let mut options = JoinOptions::new("holder");
    options.certificate = Some(certificate(&issuer, &holder_engine, 3));
    let mut holder = side(holder_engine, options);
    let mut rejoins = Rejoins::new();
    let mut options = JoinOptions::new("x");
    options.trust = Some(issuer.peer_id().clone());
    let mut x = PeerJoin::open(&mut rejoins, JoinExchange::new(options), None);
    let mut x_engine = engine(2);
    let (peer, theirs, floor) = claim(&holder.engine, 2);

    let ask = x.on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor));
    assert_eq!(ask.len(), 1, "one request");
    // the same floor again asks nothing more
    assert!(
        x.on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor))
            .is_empty()
    );
    let mut flight = ask;
    while !flight.is_empty() {
        let mut back = Vec::new();
        for bytes in flight {
            back.extend(
                holder
                    .join
                    .dispatch(&mut holder.engine, snapshot_frame(&bytes))
                    .unwrap()
                    .send,
            );
        }
        flight = Vec::new();
        for bytes in back {
            let step = x
                .on_snapshot(&mut rejoins, &mut x_engine, snapshot_frame(&bytes))
                .unwrap();
            flight.extend(step.send);
        }
    }
    assert_eq!(at(&peer)(&x_engine), 3);
    assert!(rejoins.issues(&x_engine.coverage().synced).is_empty());
}

#[test]
fn with_no_trust_nothing_is_asked_until_the_app_accepts_and_then_at_most_the_floor() {
    let mut holder = side(engine(1), JoinOptions::new("holder"));
    for k in ["a", "b", "c"] {
        write(&mut holder.engine, k, None);
    }
    let mut rejoins = Rejoins::new();
    let mut x_engine = engine(2);
    let (peer, theirs, floor) = claim(&holder.engine, 2);
    let mut x = PeerJoin::open(&mut rejoins, JoinExchange::new(JoinOptions::new("x")), None);
    assert!(
        x.on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor))
            .is_empty()
    );
    let ours = x_engine.coverage().synced;
    let issues = rejoins.issues(&ours);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].reason, BelowFloorReason::Untrusted);
    assert_eq!(issues[0].floor, floor);

    assert_eq!(rejoins.accept(&peer, &ours), Accepted::Requested);
    let ask = x.flush(&mut rejoins);
    assert_eq!(ask.len(), 1);
    let mut back = Vec::new();
    for bytes in ask {
        back.extend(
            holder
                .join
                .dispatch(&mut holder.engine, snapshot_frame(&bytes))
                .unwrap()
                .send,
        );
    }
    for bytes in back {
        x.on_snapshot(&mut rejoins, &mut x_engine, snapshot_frame(&bytes))
            .unwrap();
    }
    assert_eq!(at(&peer)(&x_engine), 2, "the floor, not the manifest's 3");
    assert!(
        x_engine.state().read_row("notes", "c").is_some(),
        "the rows all merged"
    );
    assert!(rejoins.issues(&x_engine.coverage().synced).is_empty());
    x.close(&mut rejoins);
    assert_eq!(
        rejoins.accept(&peer, &x_engine.coverage().synced),
        Accepted::NothingToAccept
    );
}

#[test]
fn trust_and_no_certificate_merges_the_rows_and_raises_unvouched_once() {
    let mut holder = side(engine(1), JoinOptions::new("holder"));
    for k in ["a", "b"] {
        write(&mut holder.engine, k, None);
    }
    let mut rejoins = Rejoins::new();
    let mut x_engine = engine(2);
    let (peer, theirs, floor) = claim(&holder.engine, 2);
    let mut options = JoinOptions::new("x");
    options.trust = Some(identity(9).peer_id().clone());
    for _session in 0..2 {
        let mut x = PeerJoin::open(
            &mut rejoins,
            JoinExchange::new(options_like(&options)),
            None,
        );
        let ask = x.on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor));
        let mut back = Vec::new();
        for bytes in ask {
            back.extend(
                holder
                    .join
                    .dispatch(&mut holder.engine, snapshot_frame(&bytes))
                    .unwrap()
                    .send,
            );
        }
        for bytes in back {
            x.on_snapshot(&mut rejoins, &mut x_engine, snapshot_frame(&bytes))
                .unwrap();
        }
        x.close(&mut rejoins);
    }
    let issues = rejoins.issues(&x_engine.coverage().synced);
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].reason, BelowFloorReason::Unvouched);
    assert!(x_engine.state().read_row("notes", "b").is_some());
    assert_eq!(at(&peer)(&x_engine), 0);
}

fn options_like(o: &JoinOptions) -> JoinOptions {
    let mut next = JoinOptions::new(o.id_prefix.clone());
    next.trust = o.trust.clone();
    next
}

#[test]
fn three_sessions_unanswered_raise_the_issue_instead_of_a_fourth_request() {
    let holder = engine(1);
    let mut rejoins = Rejoins::new();
    let x_engine = engine(2);
    let mut h = holder;
    write(&mut h, "a", None);
    let (peer, theirs, floor) = claim(&h, 1);
    let mut options = JoinOptions::new("x");
    options.trust = Some(identity(9).peer_id().clone());
    for session in 0..4 {
        let mut x = PeerJoin::open(
            &mut rejoins,
            JoinExchange::new(options_like(&options)),
            None,
        );
        let ask = x.on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor));
        // the link drops before any answer
        assert_eq!(ask.len(), usize::from(session < 3), "session {session}");
        x.close(&mut rejoins);
    }
    let issues = rejoins.issues(&x_engine.coverage().synced);
    assert_eq!(issues[0].reason, BelowFloorReason::Unanswered);
}

#[test]
fn a_repage_frame_with_no_cursors_ignores_every_floor_and_uses_no_guard() {
    let mut h = engine(1);
    write(&mut h, "a", None);
    let mut rejoins = Rejoins::new();
    let x_engine = engine(2);
    let (peer, theirs, floor) = claim(&h, 1);
    let mut options = JoinOptions::new("x");
    options.trust = Some(identity(9).peer_id().clone());
    let mut x = PeerJoin::open(&mut rejoins, JoinExchange::new(options), None);
    assert!(
        x.on_cursors(
            &mut rejoins,
            &x_engine,
            &peer,
            &Cursors::new(),
            Some(&floor)
        )
        .is_empty()
    );
    assert_eq!(
        x.on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor))
            .len(),
        1
    );
}

#[test]
fn on_a_schema_with_document_columns_a_floor_answer_adopts_nothing_and_says_incomplete() {
    let docs = DocColumns::from([(
        "boards".to_owned(),
        BTreeMap::from([("content".to_owned(), "loro@1".to_owned())]),
    )]);
    let mut holder = side(
        engine_with(1, Some(docs.clone())),
        JoinOptions::new("holder"),
    );
    write(&mut holder.engine, "a", None);
    let mut rejoins = Rejoins::new();
    let mut x_engine = engine_with(2, Some(docs));
    let (peer, theirs, floor) = claim(&holder.engine, 1);
    let mut x = PeerJoin::open(&mut rejoins, JoinExchange::new(JoinOptions::new("x")), None);
    x.on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor));
    assert_eq!(
        rejoins.accept(&peer, &x_engine.coverage().synced),
        Accepted::Requested
    );
    let mut back = Vec::new();
    for bytes in x.flush(&mut rejoins) {
        back.extend(
            holder
                .join
                .dispatch(&mut holder.engine, snapshot_frame(&bytes))
                .unwrap()
                .send,
        );
    }
    for bytes in back {
        x.on_snapshot(&mut rejoins, &mut x_engine, snapshot_frame(&bytes))
            .unwrap();
    }
    assert_eq!(at(&peer)(&x_engine), 0);
    let issues = rejoins.issues(&x_engine.coverage().synced);
    assert_eq!(issues[0].reason, BelowFloorReason::Incomplete);
}

#[test]
fn an_install_keeps_its_floor_across_a_reopen_and_tombstones_win() {
    let mut holder = engine(1);
    write(&mut holder, "a", None);
    holder
        .mutate(
            "notes.delete",
            vec![Change::Delete {
                table: "notes".into(),
                key: "a".into(),
            }],
            None,
        )
        .unwrap();
    let mut state = MemoryStateStore::new();
    let mut log = MemoryEventStore::new();
    {
        let mut x = Engine::open(
            identity(2),
            Box::new(MemoryEventStore::new()),
            None,
            EngineOptions::default(),
        )
        .unwrap();
        // x still holds the row the holder deleted
        let mut stale = engine(1);
        write(&mut stale, "a", None);
        x.receive_batch(stale.events_since(&Cursors::new(), None).unwrap())
            .unwrap();
        assert!(x.state().read_row("notes", "a").is_some());
        let snapshot = holder.snapshot(None);
        x.install_snapshot(snapshot).unwrap();
        assert!(
            x.state().read_row("notes", "a").is_none(),
            "the delete merges over the stale row"
        );
        let rows: Vec<_> = x
            .state()
            .tables
            .iter()
            .flat_map(|(t, r)| {
                r.iter().map(move |(k, rec)| syncmesh_client::RowWrite {
                    table: t.clone(),
                    key: k.clone(),
                    record: rec.clone(),
                })
            })
            .collect();
        state.commit(&rows, &x.coverage()).unwrap();
        for e in x.all_events().unwrap() {
            syncmesh_client::EventStore::append(&mut log, &e).unwrap();
        }
    }
    let author = holder.peer_id().clone();
    let reopened = Engine::open(
        identity(2),
        Box::new(log),
        Some(Box::new(state)),
        EngineOptions::default(),
    )
    .unwrap();
    assert_eq!(
        reopened.floor()[&author].get(),
        2,
        "seq 2 is in no log here"
    );
    assert_eq!(reopened.cursors()[&author].get(), 2);
    // and what this device claims to a joiner carries no floor
    assert!(reopened.snapshot(None).coverage.floor.is_empty());
}

/// Carries `ask` to `holder` and every answer back through `x`, until neither says more.
fn answer(
    x: &mut PeerJoin,
    rejoins: &mut Rejoins,
    x_engine: &mut Engine,
    holder: &mut Side,
    ask: Vec<Vec<u8>>,
) -> Vec<Settled> {
    let mut settled = Vec::new();
    let mut flight = ask;
    while !flight.is_empty() {
        let mut back = Vec::new();
        for bytes in flight {
            let step = holder
                .join
                .dispatch(&mut holder.engine, snapshot_frame(&bytes))
                .unwrap();
            back.extend(step.send);
        }
        flight = Vec::new();
        for bytes in back {
            let step = x
                .on_snapshot(rejoins, x_engine, snapshot_frame(&bytes))
                .unwrap();
            flight.extend(step.send);
            settled.extend(step.settled);
        }
    }
    settled
}

fn trusting(prefix: &str) -> JoinExchange {
    let mut options = JoinOptions::new(prefix);
    options.trust = Some(identity(9).peer_id().clone());
    JoinExchange::new(options)
}

#[test]
fn an_install_the_device_refuses_stays_unanswered_and_the_next_session_asks_again() {
    let mut holder = side(engine(1), JoinOptions::new("holder"));
    write(&mut holder.engine, "a", None);
    // the device declares `notes.body` a document column: the holder's text there is no lineage
    // cell, so the install is refused whole (RFC-0023 §16.1)
    let docs = DocColumns::from([(
        "notes".to_owned(),
        BTreeMap::from([("body".to_owned(), "loro@1".to_owned())]),
    )]);
    let mut x_engine = engine_with(2, Some(docs));
    let mut rejoins = Rejoins::new();
    let (peer, theirs, floor) = claim(&holder.engine, 1);
    let mut x = PeerJoin::open(&mut rejoins, trusting("x"), None);
    let ask = x.on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor));
    assert_eq!(ask.len(), 1);
    let settled = answer(&mut x, &mut rejoins, &mut x_engine, &mut holder, ask);
    assert!(matches!(&settled[..], [s] if matches!(s.outcome, JoinOutcome::Refused(_))));
    assert!(x_engine.state().read_row("notes", "a").is_none());
    // no issue: the refusal is an ask still unanswered, not an install that left it below
    assert!(rejoins.issues(&x_engine.coverage().synced).is_empty());
    x.close(&mut rejoins);
    let mut next = PeerJoin::open(&mut rejoins, trusting("y"), None);
    assert_eq!(
        next.on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor))
            .len(),
        1,
        "a later session asks again"
    );
}

#[test]
fn two_links_to_one_peer_put_one_request_on_the_wire_and_a_closed_one_frees_it() {
    let mut h = engine(1);
    write(&mut h, "a", None);
    let (peer, theirs, floor) = claim(&h, 1);
    let x_engine = engine(2);
    let mut rejoins = Rejoins::new();
    let mut first = PeerJoin::open(&mut rejoins, trusting("x"), None);
    let mut second = PeerJoin::open(&mut rejoins, trusting("y"), None);
    let cursors = |link: &mut PeerJoin, rejoins: &mut Rejoins| {
        link.on_cursors(rejoins, &x_engine, &peer, &theirs, Some(&floor))
            .len()
    };
    assert_eq!(cursors(&mut first, &mut rejoins), 1);
    assert_eq!(
        cursors(&mut second, &mut rejoins),
        0,
        "the first link's ask stands"
    );
    // the first link drops unanswered: the second may ask now
    first.close(&mut rejoins);
    assert_eq!(cursors(&mut second, &mut rejoins), 1);
}

#[test]
fn an_accepted_ask_a_closed_session_never_sent_is_sent_by_the_next() {
    let mut h = engine(1);
    write(&mut h, "a", None);
    let (peer, theirs, floor) = claim(&h, 1);
    let x_engine = engine(2);
    let mut rejoins = Rejoins::new();
    let untrusting = |prefix: &str| JoinExchange::new(JoinOptions::new(prefix));
    let mut first = PeerJoin::open(&mut rejoins, untrusting("x"), None);
    assert!(
        first
            .on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor))
            .is_empty()
    );
    assert_eq!(
        rejoins.accept(&peer, &x_engine.coverage().synced),
        Accepted::Requested
    );
    // the session closes before the host flushed it: the accepted ask never went out
    first.close(&mut rejoins);
    let mut next = PeerJoin::open(&mut rejoins, untrusting("y"), None);
    assert_eq!(
        next.on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor))
            .len(),
        1
    );
}

/// Gaps U37: a relay's `retention` refusal is an issue beside the peers', named by the relay and
/// cleared by the link (which reads its next join's cursors), never by a sweep of the coverage.
#[test]
fn a_relays_refusal_is_listed_beside_the_peers_and_cleared_by_the_link() {
    let mut rejoins = Rejoins::new();
    let author = identity(3).peer_id().clone();
    let floor: Cursors = [(author.clone(), seq(4))].into_iter().collect();
    let before = rejoins.changes();
    rejoins.relay_refused("relay", floor.clone());
    assert_eq!(rejoins.changes(), before + 1);
    let issue = BelowFloor {
        source: FloorSource::Relay("relay".to_owned()),
        floor: floor.clone(),
        reason: BelowFloorReason::Retention,
    };
    assert_eq!(rejoins.issues(&Cursors::new()), vec![issue.clone()]);
    assert_eq!(BelowFloorReason::Retention.as_str(), "retention");
    // a coverage at the floor does not clear it: a re-paging join sends nothing, whatever it says
    assert_eq!(rejoins.issues(&floor), vec![issue]);
    // nothing to accept from a relay: it serves no state
    assert_eq!(
        rejoins.accept(&author, &Cursors::new()),
        Accepted::NothingToAccept
    );
    rejoins.relay_cleared("relay");
    assert!(rejoins.issues(&Cursors::new()).is_empty());
    let after = rejoins.changes();
    rejoins.relay_cleared("relay");
    assert_eq!(rejoins.changes(), after, "a second clear changes nothing");
}

/// Gaps U52: a peer's floor a relay passed on is an issue of its own, raised once per floor, gone
/// once the device catches up — and never over the issue a link of this device's own raised.
#[test]
fn a_floor_heard_through_a_relay_raises_a_relayed_issue() {
    let mut rejoins = Rejoins::new();
    let peer = identity(2).peer_id().clone();
    let author = identity(3).peer_id().clone();
    let floor: Cursors = [(author.clone(), seq(4))].into_iter().collect();
    assert!(rejoins.relayed_floor(&peer, floor.clone()));
    assert!(
        !rejoins.relayed_floor(&peer, floor.clone()),
        "the same floor twice"
    );
    assert_eq!(
        rejoins.issues(&Cursors::new()),
        vec![BelowFloor {
            source: FloorSource::Peer(peer.clone()),
            floor: floor.clone(),
            reason: BelowFloorReason::Relayed,
        }]
    );
    assert_eq!(BelowFloorReason::Relayed.as_str(), "relayed");
    assert!(rejoins.issues(&floor).is_empty(), "caught up, however");
    assert!(!rejoins.relayed_floor(&peer, Cursors::new()));

    // a link of this device's own to the peer asks for the state itself
    let x_engine = engine(1);
    let theirs: Cursors = [(author.clone(), seq(9))].into_iter().collect();
    let untrusting = JoinExchange::new(JoinOptions::new("y"));
    let mut link = PeerJoin::open(&mut rejoins, untrusting, None);
    link.on_cursors(&mut rejoins, &x_engine, &peer, &theirs, Some(&floor));
    assert!(!rejoins.relayed_floor(&peer, floor.clone()));
    link.close(&mut rejoins);
    let raised = rejoins.issues(&Cursors::new());
    assert_eq!(raised.len(), 1);
    assert_eq!(raised[0].reason, BelowFloorReason::Untrusted);
    // and its issue stands once it is gone
    let moved: Cursors = [(author, seq(6))].into_iter().collect();
    assert!(!rejoins.relayed_floor(&peer, moved));
    assert_eq!(
        rejoins.issues(&Cursors::new())[0].reason,
        BelowFloorReason::Untrusted
    );
}
