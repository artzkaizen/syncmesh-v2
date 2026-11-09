//! Two assembled devices through the Rust room server: rows, presence and blobs converge with
//! no Bun anywhere — the shape licnep runs in, and the shape a process that is its own relay runs in.

#![cfg(feature = "tokio")]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use syncmesh_client::driver::{PeerCommand, StreamMedium, serve_room};
use syncmesh_client::mesh::{Mesh, MeshEvent, MeshOptions};
use syncmesh_client::relay::RelayOptions;
use syncmesh_client::room::{Room, RoomOptions};
use syncmesh_client::{
    BelowFloorReason, Cursors, Engine, EngineOptions, FloorSource, JoinOutcome, Manifest,
    MemoryEventStore, PeerAction, PeerOptions, ValidatorOptions,
};
use syncmesh_core::event::{Change, PartitionKey};
use syncmesh_core::grant::{GrantRequest, issue_grant};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::CellValue;
use tokio::time::timeout;

const STEP: Duration = Duration::from_secs(20);

async fn room() -> (String, syncmesh_core::event::PeerId) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    serve(listener)
}

/// The room on a listener the caller already holds, so a device can be pointed at a port before
/// anything answers there.
fn serve(listener: tokio::net::TcpListener) -> (String, syncmesh_core::event::PeerId) {
    let identity = Identity::from_seed(&[9; 32]);
    let key = identity.peer_id().clone();
    let room = Room::new(
        identity,
        Box::new(MemoryEventStore::new()),
        RoomOptions {
            keepalive_ms: 500,
            page_size: 2,
            ..RoomOptions::default()
        },
    )
    .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(serve_room(listener, room));
    (format!("ws://127.0.0.1:{port}/licnep"), key)
}

fn device(n: u8, url: &str, key: &syncmesh_core::event::PeerId) -> Mesh {
    Mesh::open(
        MeshOptions {
            identity: Identity::from_seed(&[n; 32]),
            url: url.to_owned(),
            relay: RelayOptions {
                relay_key: Some(key.clone()),
                reconnect_ms: 50,
                ..RelayOptions::default()
            },
            engine: EngineOptions::default(),
            store: Box::new(MemoryEventStore::new()),
            state_store: None,
            blob_store: None,
            issuer: None,
        },
        &tokio::runtime::Handle::current(),
    )
    .unwrap()
}

async fn until(mesh: &mut Mesh, want: impl Fn(&MeshEvent) -> bool) -> MeshEvent {
    timeout(STEP, async {
        loop {
            let e = mesh.next_event().await.expect("the mesh ended");
            if want(&e) {
                return e;
            }
        }
    })
    .await
    .expect("waited too long for a mesh event")
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

#[tokio::test]
async fn two_devices_converge_through_the_rust_room_with_presence_and_blobs() {
    let (url, key) = room().await;
    let partition = PartitionKey::parse("project:demo").unwrap();

    // a writes before anyone is connected: the log is the outbox
    let mut a = device(1, &url, &key);
    a.mutate(
        "notes.create",
        vec![insert("n1", "first")],
        Some(partition.clone()),
    )
    .unwrap();
    until(&mut a, |e| *e == MeshEvent::CaughtUp).await;

    // b joins later and receives history, then live writes
    let mut b = device(2, &url, &key);
    until(&mut b, |e| *e == MeshEvent::CaughtUp).await;
    assert_eq!(
        b.engine().state().read_row("notes", "n1").unwrap()["body"],
        CellValue::text("first")
    );
    a.mutate(
        "notes.create",
        vec![insert("n2", "live")],
        Some(partition.clone()),
    )
    .unwrap();
    until(
        &mut b,
        |e| matches!(e, MeshEvent::Folded(batch) if batch.write_keys["notes"].contains("n2")),
    )
    .await;
    // and back the other way
    b.mutate(
        "notes.create",
        vec![insert("n3", "reply")],
        Some(partition.clone()),
    )
    .unwrap();
    until(
        &mut a,
        |e| matches!(e, MeshEvent::Folded(batch) if batch.write_keys["notes"].contains("n3")),
    )
    .await;
    assert_eq!(a.engine().state(), b.engine().state());
    assert_eq!(a.engine().cursors(), b.engine().cursors());

    // presence: a's cursor appears at b, and a departure removes it
    let mut cursor = BTreeMap::new();
    cursor.insert("x".to_owned(), CellValue::Number(12.0));
    a.presence_set("cursor", &partition, cursor, 10_000);
    until(
        &mut b,
        |e| matches!(e, MeshEvent::Presence(t) if t.topic == "cursor"),
    )
    .await;
    let peers = b.presence_peers("cursor", &partition);
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].peer_id, *a.peer_id());
    assert_eq!(peers[0].value["x"], CellValue::Number(12.0));
    a.presence_clear("cursor", &partition);
    until(&mut b, |e| matches!(e, MeshEvent::Presence(_))).await;
    assert!(b.presence_peers("cursor", &partition).is_empty());

    // blobs: put at a, fetched by hash at b; an unknown hash is a value
    // the room answers the put, so it settles well inside the wait a silent relay would cost
    let hash = timeout(
        Duration::from_secs(2),
        a.blob_put(b"a large snapshot", None),
    )
    .await
    .expect("the put waited out the answer it was given")
    .unwrap();
    let fetched = timeout(STEP, b.blob_fetch(&hash, Duration::from_secs(5)))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fetched, b"a large snapshot");
    assert!(b.blob_has(&hash));
    let missing = b.blob_fetch(&"0".repeat(64), Duration::from_secs(5)).await;
    assert!(matches!(
        missing,
        Err(syncmesh_client::BlobError::NotFound { .. })
    ));

    // a pinned key that is not the room's is refused for good
    let mut c = Mesh::open(
        MeshOptions {
            identity: Identity::from_seed(&[3; 32]),
            url: url.clone(),
            relay: RelayOptions {
                relay_key: Some(Identity::from_seed(&[42; 32]).peer_id().clone()),
                ..RelayOptions::default()
            },
            engine: EngineOptions::default(),
            store: Box::new(MemoryEventStore::new()),
            state_store: None,
            blob_store: None,
            issuer: None,
        },
        &tokio::runtime::Handle::current(),
    )
    .unwrap();
    until(&mut c, |e| matches!(e, MeshEvent::Ended(_))).await;

    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn a_put_made_with_no_link_answers_at_once_rather_than_waiting_for_a_room() {
    let port = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        probe.local_addr().unwrap().port()
    };
    // nothing listens: the frame has no socket to leave on, so no answer to it can come
    let url = format!("ws://127.0.0.1:{port}/licnep");
    let a = device(1, &url, &Identity::from_seed(&[9; 32]).peer_id().clone());
    let hash = timeout(Duration::from_secs(2), a.blob_put(b"kept here", None))
        .await
        .expect("an offline put waited out an answer no room could give")
        .unwrap();
    assert!(a.blob_has(&hash), "the bytes are still this device's");
    a.stop().await;
}

#[tokio::test]
async fn a_peer_sees_presence_set_before_the_link_came_up() {
    let port = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        probe.local_addr().unwrap().port()
    };
    let url = format!("ws://127.0.0.1:{port}/licnep");
    let key = Identity::from_seed(&[9; 32]).peer_id().clone();
    let partition = PartitionKey::parse("project:demo").unwrap();

    // nothing listens yet: a's value is set offline and its first wire goes nowhere
    let mut a = device(1, &url, &key);
    let mut cursor = BTreeMap::new();
    cursor.insert("x".to_owned(), CellValue::Number(7.0));
    a.presence_set("cursor", &partition, cursor, 10_000);
    tokio::time::sleep(Duration::from_millis(200)).await;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    serve(listener);
    until(&mut a, |e| *e == MeshEvent::Online(true)).await;
    let mut b = device(2, &url, &key);
    until(
        &mut b,
        |e| matches!(e, MeshEvent::Presence(t) if t.topic == "cursor"),
    )
    .await;
    let peers = b.presence_peers("cursor", &partition);
    assert_eq!(peers.len(), 1, "the value set offline arrived");
    assert_eq!(peers[0].peer_id, *a.peer_id());
    assert_eq!(peers[0].value["x"], CellValue::Number(7.0));

    a.stop().await;
    b.stop().await;
}

/// The policy vectors' manifest: `notes` in an `org` partition, inserted by a `member`.
fn vectors_manifest() -> Manifest {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "policy-vectors.json",
    ]
    .iter()
    .collect();
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("vectors")).expect("json");
    Manifest::from_json(&doc["schema"]).expect("manifest")
}

fn granted_device(
    n: u8,
    url: &str,
    key: &syncmesh_core::event::PeerId,
    issuer: &Identity,
    validator: Option<ValidatorOptions>,
) -> Mesh {
    Mesh::open(
        MeshOptions {
            identity: Identity::from_seed(&[n; 32]),
            url: url.to_owned(),
            relay: RelayOptions {
                relay_key: Some(key.clone()),
                reconnect_ms: 50,
                ..RelayOptions::default()
            },
            engine: EngineOptions {
                validator,
                ..EngineOptions::default()
            },
            store: Box::new(MemoryEventStore::new()),
            state_store: None,
            blob_store: None,
            issuer: Some(issuer.peer_id().clone()),
        },
        &tokio::runtime::Handle::current(),
    )
    .unwrap()
}

#[tokio::test]
async fn a_late_joiner_admits_an_event_whose_grant_came_on_the_same_page() {
    let port = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        probe.local_addr().unwrap().port()
    };
    let url = format!("ws://127.0.0.1:{port}/licnep");
    let key = Identity::from_seed(&[9; 32]).peer_id().clone();
    let issuer = Identity::from_seed(&[100; 32]);
    let partition = PartitionKey::parse("org:acme").unwrap();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    // a holds its own grant before its link comes up, so it hands the room the grant on joining
    let a = Identity::from_seed(&[1; 32]);
    let grant = issue_grant(
        &issuer,
        &GrantRequest {
            account: "acct_a".to_owned(),
            device: a.peer_id().clone(),
            role: Some("member".to_owned()),
            partitions: vec![partition.clone()],
            claims: BTreeMap::new(),
            keys: Vec::new(),
            valid_for_ms: 86_400_000,
            now_ms,
        },
    );
    let mut a = granted_device(1, &url, &key, &issuer, None);
    a.grants().register(&grant, now_ms).unwrap();
    let mut row = BTreeMap::new();
    for (column, value) in [("id", "n1"), ("title", "t"), ("ownerId", "acct_a")] {
        row.insert(column.to_owned(), CellValue::text(value));
    }
    a.mutate(
        "notes.create",
        vec![Change::Insert {
            table: "notes".into(),
            key: "n1".into(),
            row,
        }],
        Some(partition.clone()),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
    serve(listener);
    until(&mut a, |e| *e == MeshEvent::CaughtUp).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    // b joins later with a granted validator: a's grant and n1 arrive on one page
    let validator = ValidatorOptions {
        manifest: vectors_manifest(),
        grants: None,
        authority: None,
        accounts: false,
        checks: Default::default(),
    };
    let mut b = granted_device(2, &url, &key, &issuer, Some(validator));
    until(&mut b, |e| *e == MeshEvent::CaughtUp).await;
    {
        let engine = b.engine();
        let parked: Vec<_> = engine
            .quarantine()
            .iter()
            .map(|p| p.verdict.tag())
            .collect();
        assert_eq!(parked, Vec::<&str>::new());
        assert!(engine.state().read_row("notes", "n1").is_some());
    }

    a.stop().await;
    b.stop().await;
}

/// A room that challenges, takes the join and refuses it with `retention` below `floor`, every
/// time; counts the sockets it was dialled on.
fn retaining_room(
    listener: tokio::net::TcpListener,
    floor: Vec<(syncmesh_core::event::PeerId, syncmesh_core::event::SeqNum)>,
) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use futures_util::{SinkExt, StreamExt};
    use std::sync::atomic::Ordering;
    use syncmesh_core::relay_frames::{challenge_frame, retention_error_frame};
    use tokio_tungstenite::tungstenite::Message;
    let dials = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = dials.clone();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            counted.fetch_add(1, Ordering::SeqCst);
            let floor = floor.clone();
            tokio::spawn(async move {
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                let challenge = challenge_frame(&[7; 32]);
                if socket
                    .send(Message::Binary(challenge.into()))
                    .await
                    .is_err()
                {
                    return;
                }
                // the join
                let _ = socket.next().await;
                let refusal = retention_error_frame("retention", "trimmed", &floor);
                let _ = socket.send(Message::Binary(refusal.into())).await;
                let _ = socket.close(None).await;
            });
        }
    });
    (format!("ws://127.0.0.1:{port}/retained"), dials)
}

/// Gaps U37: a Rust device the room refuses with `retention` raises the relay's issue, stops
/// redialling, and dials again once it holds the floor — the TypeScript's `retained.ts`.
#[tokio::test]
async fn a_device_the_room_refuses_with_retention_waits_for_the_floor_instead_of_redialling() {
    use std::sync::atomic::Ordering;
    // what another device wrote, and the floor the room trimmed that author to
    let mut author = Engine::open(
        Identity::from_seed(&[4; 32]),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions::default(),
    )
    .unwrap();
    for i in 0..3 {
        author
            .mutate("notes.create", vec![insert(&format!("k{i}"), "x")], None)
            .unwrap();
    }
    let written = author.events_since(&Cursors::new(), None).unwrap();
    let floor = vec![(
        author.peer_id().clone(),
        syncmesh_core::event::SeqNum::parse(3).unwrap(),
    )];
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (url, dials) = retaining_room(listener, floor);
    let mut mesh = Mesh::open(
        MeshOptions {
            identity: Identity::from_seed(&[1; 32]),
            url,
            relay: RelayOptions {
                versions: vec![2],
                reconnect_ms: 20,
                ..RelayOptions::default()
            },
            engine: EngineOptions::default(),
            store: Box::new(MemoryEventStore::new()),
            state_store: None,
            blob_store: None,
            issuer: None,
        },
        &tokio::runtime::Handle::current(),
    )
    .unwrap();

    until(&mut mesh, |e| matches!(e, MeshEvent::Recovery)).await;
    let issues = mesh.below_floor();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].source, FloorSource::Relay("relay".to_owned()));
    assert_eq!(issues[0].reason, BelowFloorReason::Retention);
    // twenty backoffs' worth of quiet: one dial, where a redialling link makes a dozen
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(dials.load(Ordering::SeqCst), 1);

    // the history arrives some other way: the link clears the issue and dials again
    mesh.engine().receive_batch(written).unwrap();
    mesh.folded_elsewhere();
    until(&mut mesh, |e| matches!(e, MeshEvent::Recovery)).await;
    assert!(mesh.below_floor().is_empty());
    timeout(STEP, async {
        while dials.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the link dialled again once it held the floor");
    mesh.stop().await;
}

#[tokio::test]
async fn two_meshes_with_no_relay_to_reach_converge_over_a_peer_link() {
    // a port nothing listens on: the relay link dials and fails, and keeps failing
    let nowhere = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "ws://127.0.0.1:{}/nowhere",
        nowhere.local_addr().unwrap().port()
    );
    drop(nowhere);
    let key = Identity::from_seed(&[9; 32]).peer_id().clone();
    let partition = PartitionKey::parse("project:demo").unwrap();
    let mut a = device(1, &url, &key);
    let mut b = device(2, &url, &key);
    a.mutate("notes.create", vec![insert("n1", "offline")], None)
        .unwrap();

    // a cable between them: any byte duplex does
    let (x, y) = tokio::io::duplex(64 * 1024);
    let handle = tokio::runtime::Handle::current();
    // no keepalive: nothing but the mesh handing a write on would carry it
    let cable = || PeerOptions {
        name: "cable".to_owned(),
        keepalive_ms: None,
        ..PeerOptions::default()
    };
    let a_link = a.attach_peer(StreamMedium::new(x), cable(), &handle);
    b.attach_peer(StreamMedium::new(y), cable(), &handle);
    until(&mut a, |e| {
        matches!(e, MeshEvent::Peer { link, name, fact: PeerAction::Established(peer) }
            if *link == a_link.id() && name == "cable"
                && peer == Identity::from_seed(&[2; 32]).peer_id())
    })
    .await;
    until(
        &mut b,
        |e| matches!(e, MeshEvent::Folded(batch) if batch.write_keys["notes"].contains("n1")),
    )
    .await;

    // live writes and presence ride the peer link as they would the relay
    b.mutate("notes.create", vec![insert("n2", "back")], None)
        .unwrap();
    until(
        &mut a,
        |e| matches!(e, MeshEvent::Folded(batch) if batch.write_keys["notes"].contains("n2")),
    )
    .await;
    let mut value = BTreeMap::new();
    value.insert("x".to_owned(), CellValue::Number(4.0));
    // a short TTL: stopping waits out the heartbeat it sets
    b.presence_set("cursor", &partition, value, 3_000);
    until(&mut a, |e| matches!(e, MeshEvent::Presence(_))).await;
    let here = a.presence_peers("cursor", &partition);
    assert!(
        here.iter()
            .any(|entry| &entry.peer_id == Identity::from_seed(&[2; 32]).peer_id()),
        "{here:?}"
    );
    assert_eq!(a.engine().state(), b.engine().state());
    a.stop().await;
    b.stop().await;
}

/// A relay URL nothing answers at, so only peer links carry anything.
async fn nowhere() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "ws://127.0.0.1:{}/nowhere",
        listener.local_addr().unwrap().port()
    );
    drop(listener);
    url
}

/// Default options but no keepalive: nothing but the mesh handing something on carries it.
fn quiet() -> PeerOptions {
    PeerOptions {
        keepalive_ms: None,
        ..PeerOptions::default()
    }
}

#[tokio::test]
async fn a_fold_from_one_peer_link_reaches_another_that_shares_its_name() {
    let url = nowhere().await;
    let key = Identity::from_seed(&[9; 32]).peer_id().clone();
    let handle = tokio::runtime::Handle::current();
    // a hub between two spokes, every link under the default name
    let mut hub = device(1, &url, &key);
    let mut left = device(2, &url, &key);
    let mut right = device(3, &url, &key);
    let (x, y) = tokio::io::duplex(64 * 1024);
    let to_left = hub.attach_peer(StreamMedium::new(x), quiet(), &handle);
    left.attach_peer(StreamMedium::new(y), quiet(), &handle);
    let (x, y) = tokio::io::duplex(64 * 1024);
    let to_right = hub.attach_peer(StreamMedium::new(x), quiet(), &handle);
    right.attach_peer(StreamMedium::new(y), quiet(), &handle);
    assert_eq!(to_left.name(), to_right.name());
    assert_ne!(to_left.id(), to_right.id());
    for link in [to_left.id(), to_right.id()] {
        until(&mut hub, |e| {
            matches!(e, MeshEvent::Peer { link: l, fact: PeerAction::Established(_), .. }
                if *l == link)
        })
        .await;
    }
    until(&mut right, |e| {
        matches!(
            e,
            MeshEvent::Peer {
                fact: PeerAction::Established(_),
                ..
            }
        )
    })
    .await;
    until(&mut left, |e| {
        matches!(
            e,
            MeshEvent::Peer {
                fact: PeerAction::Established(_),
                ..
            }
        )
    })
    .await;

    // left writes; the hub folds it off one link and offers it down the other
    left.mutate("notes.create", vec![insert("n1", "across")], None)
        .unwrap();
    until(
        &mut right,
        |e| matches!(e, MeshEvent::Folded(batch) if batch.write_keys["notes"].contains("n1")),
    )
    .await;
    assert_eq!(right.engine().state(), left.engine().state());
    hub.stop().await;
    left.stop().await;
    right.stop().await;
}

#[tokio::test]
async fn a_host_commands_a_peer_link_the_mesh_runs_through_its_handle() {
    let url = nowhere().await;
    let key = Identity::from_seed(&[9; 32]).peer_id().clone();
    let issuer = Identity::from_seed(&[100; 32]);
    let handle = tokio::runtime::Handle::current();
    let mut a = granted_device(1, &url, &key, &issuer, None);
    let mut b = granted_device(2, &url, &key, &issuer, None);
    let (x, y) = tokio::io::duplex(64 * 1024);
    let a_link = a.attach_peer(StreamMedium::new(x), quiet(), &handle);
    let b_link = b.attach_peer(StreamMedium::new(y), quiet(), &handle);
    until(&mut a, |e| {
        matches!(
            e,
            MeshEvent::Peer {
                fact: PeerAction::Established(_),
                ..
            }
        )
    })
    .await;

    // a grant request comes up under the link it arrived on, and the answer goes back down it
    a_link
        .try_send(PeerCommand::RequestGrant(Some("invite".to_owned())))
        .unwrap();
    let asked = until(&mut b, |e| {
        matches!(
            e,
            MeshEvent::Peer {
                fact: PeerAction::GrantRequest { .. },
                ..
            }
        )
    })
    .await;
    let MeshEvent::Peer {
        link,
        fact: PeerAction::GrantRequest { peer_id, invite },
        ..
    } = asked
    else {
        unreachable!()
    };
    assert_eq!(link, b_link.id());
    assert_eq!(invite.as_deref(), Some("invite"));
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let grant = issue_grant(
        &issuer,
        &GrantRequest {
            account: "acct_a".to_owned(),
            device: peer_id.clone(),
            role: Some("member".to_owned()),
            partitions: vec![PartitionKey::parse("org:acme").unwrap()],
            claims: BTreeMap::new(),
            keys: Vec::new(),
            valid_for_ms: 86_400_000,
            now_ms,
        },
    );
    b_link.try_send(PeerCommand::Grants(vec![grant])).unwrap();
    timeout(STEP, async {
        while a.grants().grant_for(&peer_id, now_ms).is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the grant came back down the link");

    // a asks b for state rather than history, and installs it
    b.mutate("notes.create", vec![insert("n1", "state")], None)
        .unwrap();
    until(
        &mut a,
        |e| matches!(e, MeshEvent::Folded(batch) if batch.write_keys["notes"].contains("n1")),
    )
    .await;
    a_link
        .try_send(PeerCommand::RequestSnapshot {
            interest: None,
            adopt_unvouched: true,
        })
        .unwrap();
    until(&mut a, |e| {
        matches!(e, MeshEvent::Peer { link, fact: PeerAction::Snapshot(settled), .. }
            if *link == a_link.id()
                && matches!(settled.outcome, JoinOutcome::Installed { .. }))
    })
    .await;

    // closing one link through its handle ends it
    a_link.try_send(PeerCommand::Close).unwrap();
    until(&mut a, |e| {
        matches!(e, MeshEvent::Peer { link, fact: PeerAction::Ended { .. }, .. }
            if *link == a_link.id())
    })
    .await;
    a.stop().await;
    b.stop().await;
}

#[tokio::test]
async fn two_meshes_with_a_backlog_each_way_converge_over_a_narrow_pipe() {
    let url = nowhere().await;
    let key = Identity::from_seed(&[9; 32]).peer_id().clone();
    let handle = tokio::runtime::Handle::current();
    let mut a = device(1, &url, &key);
    let mut b = device(2, &url, &key);
    // each side owes the other far more than the pipe holds, and both answer at once
    for n in 0..60 {
        a.mutate(
            "notes.create",
            vec![insert(&format!("a{n}"), "from a")],
            None,
        )
        .unwrap();
        b.mutate(
            "notes.create",
            vec![insert(&format!("b{n}"), "from b")],
            None,
        )
        .unwrap();
    }
    let (x, y) = tokio::io::duplex(1024);
    a.attach_peer(StreamMedium::new(x), quiet(), &handle);
    b.attach_peer(StreamMedium::new(y), quiet(), &handle);
    let has = |mesh: &Mesh, key: &str| mesh.engine().state().read_row("notes", key).is_some();
    timeout(STEP, async {
        while !(has(&a, "b59") && has(&b, "a59")) {
            let _ = a.poll_events();
            let _ = b.poll_events();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("both backlogs crossed");
    assert_eq!(a.engine().state(), b.engine().state());
    a.stop().await;
    b.stop().await;
}
