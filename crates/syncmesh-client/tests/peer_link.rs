//! The peer link (gap U3's radios), two Rust devices with nothing between them, synchronously and
//! with explicit clocks: every framing a medium may need, the handshake's refusals and its restart,
//! the gap rule, digests, custody, presence, the join exchange and a floor (D46), and liveness.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use syncmesh_client::peer::{DEFAULT_KEEPALIVE_MS, NOT_ADMITTED, QUIET, UNPINNED};
use syncmesh_client::{
    Engine, EngineOptions, Framing, JoinOutcome, Manifest, MemoryEventStore, MemoryStateStore,
    PeerAction, PeerLink, PeerOptions, PeerSession, Rejoins, SessionOptions, ValidatorOptions,
};
use syncmesh_core::event::{Change, PartitionKey, PeerId};
use syncmesh_core::frames::{Frame, decode_frame, event_frame};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::{CellValue, Row};

const NOW: i64 = 1_700_000_000_000;

fn identity(n: u8) -> Identity {
    Identity::from_seed(&[n; 32])
}

fn engine(n: u8) -> Engine {
    Engine::open(
        identity(n),
        Box::new(MemoryEventStore::new()),
        Some(Box::new(MemoryStateStore::new())),
        EngineOptions {
            now_ms: Some(Box::new(|| NOW)),
            ..EngineOptions::default()
        },
    )
    .expect("engine")
}

fn note(key: &str, body: &str) -> Change {
    let mut row = Row::new();
    row.insert("body".to_owned(), CellValue::text(body));
    Change::Insert {
        table: "notes".into(),
        key: key.into(),
        row,
    }
}

fn write(engine: &mut Engine, key: &str, body: &str) -> syncmesh_client::StoredEvent {
    engine
        .mutate("notes.create", vec![note(key, body)], None)
        .expect("a write")
        .entry
}

fn body(engine: &Engine, key: &str) -> Option<CellValue> {
    engine
        .state()
        .read_row("notes", key)
        .and_then(|row| row.get("body").cloned())
}

/// One end of a link under test: the device, its link, and what it has been told.
struct End {
    engine: Engine,
    link: PeerLink,
    facts: Vec<PeerAction>,
    /// What this end put on the medium and the other has not read yet.
    wire: Vec<Vec<u8>>,
    closed: Option<String>,
    /// The first unit this end put on the medium: its hello.
    hello: Vec<u8>,
}

impl End {
    fn open(n: u8, options: PeerOptions) -> End {
        End::over(engine(n), n, options)
    }

    fn over(engine: Engine, n: u8, options: PeerOptions) -> End {
        let (link, actions) = PeerLink::open(identity(n), options, NOW);
        let mut end = End {
            engine,
            link,
            facts: Vec::new(),
            wire: Vec::new(),
            closed: None,
            hello: Vec::new(),
        };
        end.take(actions);
        end.hello = end.wire.first().cloned().expect("a hello first");
        end
    }

    fn take(&mut self, actions: Vec<PeerAction>) {
        for action in actions {
            match action {
                PeerAction::Send(bytes) => self.wire.push(bytes),
                PeerAction::SendLatest { units, .. } => self.wire.extend(units),
                PeerAction::Close { reason } => self.closed = Some(reason),
                fact => self.facts.push(fact),
            }
        }
    }
}

/// What `from` wrote, read by `to`.
fn deliver(from: &mut End, to: &mut End, split: bool) {
    let units = std::mem::take(&mut from.wire);
    if from.closed.is_some() {
        return;
    }
    for unit in units {
        let pieces: Vec<Vec<u8>> = if split {
            unit.iter().map(|byte| vec![*byte]).collect()
        } else {
            vec![unit]
        };
        for piece in pieces {
            let actions = to.link.on_bytes(&mut to.engine, &piece, NOW);
            to.take(actions);
        }
    }
}

/// Delivers what each end wrote to the other until neither has anything left to say. `split`
/// cuts every unit into single bytes, as a stream may deliver them.
fn pump(a: &mut End, b: &mut End, split: bool) {
    for _ in 0..200 {
        if a.wire.is_empty() && b.wire.is_empty() {
            return;
        }
        deliver(a, b, split);
        deliver(b, a, split);
    }
    panic!("the two ends never went quiet");
}

fn options(framing: Framing) -> PeerOptions {
    PeerOptions {
        framing,
        ..PeerOptions::default()
    }
}

fn converge(framing: Framing, split: bool) {
    let mut a = End::open(1, options(framing));
    let mut b = End::open(2, options(framing));
    // written before the link: the cursors exchanged on open carry them across
    write(&mut a.engine, "a1", "from a");
    write(&mut b.engine, "b1", "from b");
    pump(&mut a, &mut b, split);
    assert_eq!(a.link.peer(), Some(identity(2).peer_id()));
    assert_eq!(b.link.peer(), Some(identity(1).peer_id()));
    assert_eq!(body(&a.engine, "b1"), Some(CellValue::text("from b")));
    assert_eq!(body(&b.engine, "a1"), Some(CellValue::text("from a")));

    // and live: a write handed to the link is folded on the far side
    let entry = write(&mut a.engine, "a2", "live");
    let actions = a.link.on_local_write(&entry);
    a.take(actions);
    pump(&mut a, &mut b, split);
    assert_eq!(body(&b.engine, "a2"), Some(CellValue::text("live")));
    assert_eq!(a.engine.state(), b.engine.state(), "one state on both ends");
    for end in [&a, &b] {
        assert!(end.closed.is_none(), "{:?}", end.closed);
        assert!(
            !end.facts
                .iter()
                .any(|f| matches!(f, PeerAction::Dropped(_))),
            "{:?}",
            end.facts
        );
    }
}

#[test]
fn two_devices_converge_directly_over_a_stream() {
    converge(Framing::STREAM, false);
}

#[test]
fn a_stream_delivered_one_byte_at_a_time_still_converges() {
    converge(Framing::STREAM, true);
}

#[test]
fn two_devices_converge_over_a_message_medium() {
    converge(Framing::Messages, false);
}

#[test]
fn two_devices_converge_over_ble_fragments_no_wider_than_a_write() {
    let mut a = End::open(1, options(Framing::fragments(40)));
    let mut b = End::open(2, options(Framing::fragments(40)));
    write(
        &mut a.engine,
        "a1",
        "a body long enough to need several fragments of forty bytes",
    );
    pump(&mut a, &mut b, false);
    assert!(body(&b.engine, "a1").is_some());
    // every unit is one write: header and all, within the limit
    let entry = write(
        &mut b.engine,
        "b1",
        "and back the other way, cut up the same",
    );
    let actions = b.link.on_local_write(&entry);
    b.take(actions);
    assert!(b.wire.len() > 1, "a frame took several fragments");
    assert!(b.wire.iter().all(|unit| unit.len() <= 40));
    // and arriving in reverse, as a radio may deliver them, still one frame
    b.wire.reverse();
    pump(&mut a, &mut b, false);
    assert!(body(&a.engine, "b1").is_some());
    assert_eq!(a.engine.state(), b.engine.state());
}

#[test]
fn a_pinned_link_refuses_a_hello_from_another_key() {
    let pinned = PeerOptions {
        peer_key: Some(identity(9).peer_id().clone()),
        ..PeerOptions::default()
    };
    let mut a = End::open(1, pinned);
    let mut b = End::open(2, PeerOptions::default());
    write(&mut b.engine, "b1", "secret");
    pump(&mut a, &mut b, false);
    assert_eq!(a.closed.as_deref(), Some(UNPINNED));
    assert!(a.facts.contains(&PeerAction::Refused {
        peer: identity(2).peer_id().clone(),
        reason: UNPINNED.to_owned(),
    }));
    assert!(!a.link.is_established());
    assert_eq!(
        body(&a.engine, "b1"),
        None,
        "nothing crossed a refused link"
    );
}

#[test]
fn the_door_refuses_a_proved_peer_it_does_not_admit() {
    let door = PeerOptions {
        admits: Some(Box::new(|peer: &PeerId| peer != identity(2).peer_id())),
        ..PeerOptions::default()
    };
    let mut a = End::open(1, door);
    let mut b = End::open(2, PeerOptions::default());
    pump(&mut a, &mut b, false);
    assert_eq!(a.closed.as_deref(), Some(NOT_ADMITTED));
    assert!(
        a.facts
            .iter()
            .any(|f| matches!(f, PeerAction::Refused { reason, .. } if reason == NOT_ADMITTED))
    );
}

#[test]
fn a_peer_that_restarts_on_the_same_link_supersedes_the_session() {
    let mut a = End::open(1, PeerOptions::default());
    let mut b = End::open(2, PeerOptions::default());
    pump(&mut a, &mut b, false);
    assert!(a.link.is_established() && b.link.is_established());

    // b's process restarts; its medium is the one a was already holding, and nothing said so
    let mut engine = std::mem::replace(&mut b.engine, engine(2));
    write(&mut engine, "b1", "after the restart");
    let mut b = End::over(engine, 2, PeerOptions::default());
    pump(&mut a, &mut b, false);
    assert!(
        a.facts
            .contains(&PeerAction::Superseded(identity(2).peer_id().clone())),
        "{:?}",
        a.facts
    );
    assert_eq!(
        body(&a.engine, "b1"),
        Some(CellValue::text("after the restart"))
    );
    assert!(a.closed.is_none());

    // a hello this link has already agreed a session under, offered again, is refused
    let replayed = b.hello.clone();
    let actions = a.link.on_bytes(&mut a.engine, &replayed, NOW);
    assert!(
        actions.iter().any(
            |f| matches!(f, PeerAction::Dropped(why) if why.contains("already agreed a session"))
        ),
        "{actions:?}"
    );
    assert!(a.link.is_established());
}

// --- the session, over plaintext frames -------------------------------------------------------

/// A session on `engine` with a peer `n`, and the frames it opened with.
fn session(
    engine: &Engine,
    me: u8,
    peer: u8,
    options: SessionOptions,
) -> (PeerSession, Vec<PeerAction>) {
    PeerSession::open(
        identity(me),
        identity(peer).peer_id().clone(),
        options,
        engine,
    )
}

fn sent(actions: &[PeerAction]) -> Vec<Vec<u8>> {
    actions
        .iter()
        .flat_map(|a| match a {
            PeerAction::Send(bytes) => vec![bytes.clone()],
            PeerAction::SendLatest { units, .. } => units.clone(),
            _ => Vec::new(),
        })
        .collect()
}

fn kinds(actions: &[PeerAction]) -> Vec<&'static str> {
    sent(actions)
        .iter()
        .map(|bytes| decode_frame(bytes).expect("a frame").kind())
        .collect()
}

/// `n` events by author `who`, as event frames in sequence order.
fn authored(who: u8, n: usize) -> Vec<Vec<u8>> {
    let mut author = engine(who);
    for i in 0..n {
        write(&mut author, &format!("{who}-{i}"), "x");
    }
    author
        .all_events()
        .unwrap()
        .iter()
        .map(|e| event_frame(&e.envelope().unwrap()))
        .collect()
}

#[test]
fn an_event_past_a_hole_waits_for_the_hole_and_then_folds_in_order() {
    let mut receiver = engine(1);
    let (mut s, _) = session(&receiver, 1, 3, SessionOptions::default());
    let frames = authored(3, 3);
    for frame in [&frames[1], &frames[2]] {
        let actions = s.on_frame(&mut receiver, frame, NOW);
        assert!(!actions.iter().any(|a| matches!(a, PeerAction::Folded(_))));
    }
    assert!(receiver.state().read_rows("notes").is_empty());
    let actions = s.on_frame(&mut receiver, &frames[0], NOW);
    let folded: Vec<usize> = actions
        .iter()
        .filter_map(|a| match a {
            PeerAction::Folded(batch) => Some(batch.event_count),
            _ => None,
        })
        .collect();
    assert_eq!(
        folded,
        vec![3],
        "the run folds whole once the hole is filled"
    );
    // and the fold is announced: our cursors follow it
    assert_eq!(kinds(&actions).last(), Some(&"cursors"));
    assert_eq!(receiver.cursors()[identity(3).peer_id()].get(), 3);
}

#[test]
fn a_hole_the_holdback_cannot_hold_asks_again_from_the_cursors() {
    let mut receiver = engine(1);
    let options = SessionOptions {
        gap_limit: 1,
        ..SessionOptions::default()
    };
    let (mut s, _) = session(&receiver, 1, 3, options);
    let frames = authored(3, 3);
    let first = s.on_frame(&mut receiver, &frames[2], NOW);
    assert!(kinds(&first).is_empty());
    let overflowed = s.on_frame(&mut receiver, &frames[1], NOW);
    assert_eq!(kinds(&overflowed), vec!["cursors"]);
    let Frame::Cursors { cursors, .. } = decode_frame(&sent(&overflowed)[0]).unwrap() else {
        unreachable!()
    };
    assert!(cursors.is_empty(), "nothing of the author is held yet");
}

#[test]
fn a_cursors_frame_is_answered_with_what_the_peer_lacks_and_a_digest() {
    let mut holder = engine(1);
    write(&mut holder, "h1", "one");
    write(&mut holder, "h2", "two");
    let (mut s, opened) = session(&holder, 1, 2, SessionOptions::default());
    assert_eq!(kinds(&opened), vec!["cursors"]);
    // the asker's own cursors, from a session on its own engine
    let mut asker = engine(2);
    let (mut theirs, asked) = session(&asker, 2, 1, SessionOptions::default());
    let answer = s.on_frame(&mut holder, &sent(&asked)[0], NOW);
    assert_eq!(kinds(&answer), vec!["event", "event", "digest"]);
    for frame in sent(&answer) {
        let actions = theirs.on_frame(&mut asker, &frame, NOW);
        assert!(
            !actions
                .iter()
                .any(|a| matches!(a, PeerAction::Divergence { .. })),
            "{actions:?}"
        );
    }
    assert_eq!(asker.state(), holder.state());
}

#[test]
fn a_digest_at_the_same_position_over_other_rows_is_divergence() {
    let mut a = engine(1);
    let mut b = engine(2);
    // a local-only row: no cursor counts it, and the digest does
    a.mutate_local("notes.create", vec![note("mine", "only here")], None)
        .expect("a local write");
    let (mut sa, opened_a) = session(&a, 1, 2, SessionOptions::default());
    let (mut sb, _) = session(&b, 2, 1, SessionOptions::default());
    let answer = sb.on_frame(&mut b, &sent(&opened_a)[0], NOW);
    let digest = sent(&answer)
        .into_iter()
        .find(|f| decode_frame(f).unwrap().kind() == "digest")
        .expect("a digest answers the cursors");
    let actions = sa.on_frame(&mut a, &digest, NOW);
    assert!(
        actions.contains(&PeerAction::Divergence {
            tables: vec!["notes".to_owned()]
        }),
        "{actions:?}"
    );

    // a peer at another position is merely behind or ahead, and says nothing comparable
    write(&mut b, "b1", "one");
    let (mut sb, _) = session(&b, 2, 1, SessionOptions::default());
    let answer = sb.on_frame(&mut b, &sent(&opened_a)[0], NOW);
    for frame in sent(&answer) {
        if decode_frame(&frame).unwrap().kind() != "digest" {
            continue;
        }
        let actions = sa.on_frame(&mut a, &frame, NOW);
        assert!(
            !actions
                .iter()
                .any(|a| matches!(a, PeerAction::Divergence { .. }))
        );
    }
}

#[test]
fn a_holder_with_an_incarnation_signs_what_it_folded_back_to_the_author() {
    let mut author = engine(1);
    let entry = write(&mut author, "a1", "held");
    let mut holder = engine(2);
    let options = SessionOptions {
        incarnation: Some("disk-1".to_owned()),
        ..SessionOptions::default()
    };
    let (mut held, _) = session(&holder, 2, 1, options);
    let actions = held.on_frame(&mut holder, &event_frame(&entry.envelope().unwrap()), NOW);
    assert_eq!(kinds(&actions), vec!["receipt", "cursors"]);
    let (mut back, _) = session(&author, 1, 2, SessionOptions::default());
    let receipt = &sent(&actions)[0];
    let told = back.on_frame(&mut author, receipt, NOW);
    let Some(PeerAction::Receipt(receipt)) = told.first() else {
        panic!("{told:?}");
    };
    assert_eq!(&receipt.holder, identity(2).peer_id());
    assert_eq!(receipt.through_seq.get(), 1);
    assert_eq!(receipt.incarnation, "disk-1");
}

fn snapshot_vectors() -> serde_json::Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "snapshot-vectors.json",
    ]
    .iter()
    .collect();
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn a_parked_event_is_refused_back_to_its_author_once_per_seating() {
    let mut author = engine(1);
    // `notes` lives in an `org` here, and this write names none
    let entry = write(&mut author, "a1", "nowhere");
    let manifest = Manifest::from_json(&snapshot_vectors()["localSchema"]).unwrap();
    let mut judge = Engine::open(
        identity(2),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            now_ms: Some(Box::new(|| NOW)),
            validator: Some(ValidatorOptions::new(manifest)),
            ..EngineOptions::default()
        },
    )
    .unwrap();
    let (mut s, _) = session(&judge, 2, 1, SessionOptions::default());
    let actions = s.on_frame(&mut judge, &event_frame(&entry.envelope().unwrap()), NOW);
    assert_eq!(kinds(&actions), vec!["refusal"]);
    assert_eq!(judge.quarantine().len(), 1);

    let (mut back, opened) = session(&author, 1, 2, SessionOptions::default());
    let told = back.on_frame(&mut author, &sent(&actions)[0], NOW);
    let Some(PeerAction::Refusal(refusal)) = told.first() else {
        panic!("{told:?}");
    };
    assert_eq!(&refusal.refuser, identity(2).peer_id());
    assert_eq!(refusal.seq.get(), 1);

    // the author's cursors on this link do not make it say the same refusal again
    let again = s.on_frame(&mut judge, &sent(&opened)[0], NOW);
    assert!(!kinds(&again).contains(&"refusal"), "{:?}", kinds(&again));
}

#[test]
fn a_presence_value_goes_out_slotted_by_topic_instance_and_author() {
    let me = engine(1);
    let (s, _) = session(&me, 1, 2, SessionOptions::default());
    let partition = PartitionKey::parse("org:acme").unwrap();
    let mut tier = syncmesh_client::PresenceTier::new(identity(1), "s1".to_owned());
    let mut value = Row::new();
    value.insert("x".to_owned(), CellValue::Number(1.0));
    let wire = tier.set("cursor", &partition, value, 10_000, NOW);
    let actions = s.send_presence(&wire);
    let [PeerAction::SendLatest { slot, units }] = actions.as_slice() else {
        panic!("{actions:?}");
    };
    assert_eq!(
        slot,
        &format!("cursor org:acme {}", identity(1).peer_id().as_str())
    );
    assert_eq!(
        kinds(&[PeerAction::Send(units[0].clone())]),
        vec!["presence"]
    );
}

// --- the join exchange and the floor, over whole links ----------------------------------------

#[test]
fn a_device_asks_its_peer_for_state_and_installs_it() {
    let mut a = End::open(1, PeerOptions::default());
    let mut b = End::open(2, PeerOptions::default());
    pump(&mut a, &mut b, false);
    write(&mut b.engine, "b1", "one");
    write(&mut b.engine, "b2", "two");
    let (ticket, actions) = a.link.request_snapshot(None, true);
    assert!(ticket.is_some());
    a.take(actions);
    pump(&mut a, &mut b, false);
    let settled = a
        .facts
        .iter()
        .find_map(|f| match f {
            PeerAction::Snapshot(settled) => Some(settled.clone()),
            _ => None,
        })
        .expect("the install settled");
    assert_eq!(Some(settled.ticket), ticket);
    let JoinOutcome::Installed { installed, vouched } = settled.outcome else {
        panic!("refused");
    };
    assert_eq!(installed.rows, 2);
    assert!(!vouched && installed.provisional);
    assert_eq!(body(&a.engine, "b2"), Some(CellValue::text("two")));
}

#[test]
fn a_device_below_its_peers_floor_is_told_and_installs_state_once_it_consents() {
    // c writes; b takes c's state rather than its history, so b's log stands on a floor
    let mut c = End::open(3, PeerOptions::default());
    write(&mut c.engine, "c1", "one");
    write(&mut c.engine, "c2", "two");
    let mut b = End::open(2, PeerOptions::default());
    // b asks c for state before c's cursors can page it history
    let mut b_hello = std::mem::take(&mut b.wire);
    let mut c_hello = std::mem::take(&mut c.wire);
    let opened = c.link.on_bytes(&mut c.engine, &b_hello.remove(0), NOW);
    let opened_b = b.link.on_bytes(&mut b.engine, &c_hello.remove(0), NOW);
    let (_, ask) = b.link.request_snapshot(None, true);
    b.take(opened_b);
    // the snapshot request leaves before b's cursors reach c
    let cursors = std::mem::take(&mut b.wire);
    b.take(ask);
    b.wire.extend(cursors);
    c.take(opened);
    c.wire.retain(|_| false);
    pump(&mut b, &mut c, false);
    let floor = b.engine.floor();
    assert_eq!(floor.get(identity(3).peer_id()).map(|s| s.get()), Some(2));

    // a, empty, meets b: below b's floor for c, with nothing it trusts to vouch
    let rejoins = Arc::new(Mutex::new(Rejoins::new()));
    let mut a = End::open(
        1,
        PeerOptions {
            session: SessionOptions {
                rejoins: Some(rejoins.clone()),
                ..SessionOptions::default()
            },
            ..PeerOptions::default()
        },
    );
    let mut b = End::over(
        std::mem::replace(&mut b.engine, engine(2)),
        2,
        PeerOptions::default(),
    );
    pump(&mut a, &mut b, false);
    let ours = a.engine.coverage().synced;
    let issues = rejoins.lock().unwrap().issues(&ours);
    assert_eq!(issues.len(), 1, "{issues:?}");
    assert_eq!(
        issues[0].source,
        syncmesh_client::FloorSource::Peer(identity(2).peer_id().clone())
    );

    let (accepted, ask) = a.link.accept_floor(&a.engine);
    assert_eq!(accepted, Some(syncmesh_client::Accepted::Requested));
    assert_eq!(ask.len(), 1);
    a.take(ask);
    pump(&mut a, &mut b, false);
    assert_eq!(body(&a.engine, "c2"), Some(CellValue::text("two")));
    assert_eq!(a.engine.coverage().synced[identity(3).peer_id()].get(), 2);
    let ours = a.engine.coverage().synced;
    assert!(rejoins.lock().unwrap().issues(&ours).is_empty());
}

// --- liveness ---------------------------------------------------------------------------------

#[test]
fn a_quiet_link_is_prodded_with_cursors_and_hung_up_on_past_its_deadline() {
    let mut a = End::open(1, PeerOptions::default());
    let mut b = End::open(2, PeerOptions::default());
    pump(&mut a, &mut b, false);
    let every = DEFAULT_KEEPALIVE_MS as i64;
    assert_eq!(a.link.next_deadline_ms(), Some(NOW + every));
    // a keepalive of silence: the probe is our cursors, which the far side answers
    let prod = a.link.on_tick(&a.engine, NOW + every);
    assert_eq!(prod.len(), 1, "{prod:?}");
    a.take(prod);
    let heard_back = std::mem::take(&mut a.wire);
    let answer = b.link.on_bytes(&mut b.engine, &heard_back[0], NOW + every);
    assert!(
        !sent(&answer).is_empty(),
        "a digest answers every cursors frame"
    );
    // past two and a half keepalives with nothing heard, the link is over
    let ticks: Vec<PeerAction> = [2, 3]
        .into_iter()
        .flat_map(|n| a.link.on_tick(&a.engine, NOW + every * n + 1))
        .collect();
    assert!(
        ticks.contains(&PeerAction::Close {
            reason: QUIET.to_owned()
        }),
        "{ticks:?}"
    );
    assert_eq!(
        a.link.on_closed(QUIET),
        vec![PeerAction::Ended {
            reason: QUIET.to_owned()
        }]
    );
    assert!(a.link.on_closed(QUIET).is_empty(), "idempotent");
}

#[test]
fn an_announced_length_past_the_cap_ends_the_link() {
    let mut a = End::open(
        1,
        options(Framing::Stream {
            max_frame_bytes: 1024,
        }),
    );
    let actions = a.link.on_bytes(&mut a.engine, &[0, 0, 0x10, 0], NOW);
    assert!(
        actions
            .iter()
            .any(|f| matches!(f, PeerAction::Close { .. })),
        "{actions:?}"
    );
    assert!(a.link.is_closed());
}
