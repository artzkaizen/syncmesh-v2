//! Two assembled devices through the Rust room server: rows, presence and blobs converge with
//! no Bun anywhere — the shape licnep runs in, and the shape a process that is its own relay runs in.

#![cfg(feature = "tokio")]

use std::collections::BTreeMap;
use std::time::Duration;

use syncmesh_client::driver::serve_room;
use syncmesh_client::mesh::{Mesh, MeshEvent, MeshOptions};
use syncmesh_client::relay::RelayOptions;
use syncmesh_client::room::{Room, RoomOptions};
use syncmesh_client::{EngineOptions, MemoryEventStore};
use syncmesh_core::event::{Change, PartitionKey};
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
    let hash = a.blob_put(b"a large snapshot").unwrap();
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
