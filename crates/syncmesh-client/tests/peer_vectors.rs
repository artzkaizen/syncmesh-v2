//! The peer session against `conformance/peer-link-vectors.json` (gap U3's radios): a Rust holder of
//! the same events opens a session with the TypeScript's frames and answers every cursors frame
//! with them, byte for byte — events, digest and cursors — and a Rust device taking the same event
//! frames out of order sends the same frames after each.

use std::path::PathBuf;

use serde_json::Value;
use syncmesh_client::{
    Engine, EngineOptions, Interest, MemoryEventStore, MemoryStateStore, PeerAction, PeerSession,
    SessionOptions, StoredEvent,
};
use syncmesh_core::envelope::decode_and_verify;
use syncmesh_core::event::{PartitionKey, PeerId};
use syncmesh_core::hex::{from_hex, to_hex};
use syncmesh_core::identity::Identity;

const NOW_MS: i64 = 1_700_000_000_000;

fn vectors() -> Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "peer-link-vectors.json",
    ]
    .iter()
    .collect();
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("json")
}

/// The generator's seeds: `(start + i * 7) % 256`.
fn identity(start: u32) -> Identity {
    let seed: Vec<u8> = (0..32u32).map(|i| ((start + i * 7) % 256) as u8).collect();
    Identity::from_seed(&seed.try_into().expect("32 bytes"))
}

fn engine(identity: Identity) -> Engine {
    Engine::open(
        identity,
        Box::new(MemoryEventStore::new()),
        Some(Box::new(MemoryStateStore::new())),
        EngineOptions {
            now_ms: Some(Box::new(|| NOW_MS)),
            ..EngineOptions::default()
        },
    )
    .expect("engine")
}

fn bytes(hex: &Value) -> Vec<u8> {
    from_hex(hex.as_str().expect("hex")).expect("hex")
}

fn hexes(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("frames")
        .iter()
        .map(|h| h.as_str().expect("hex").to_owned())
        .collect()
}

/// The plaintext frames a session sent, as hex.
fn sent(actions: &[PeerAction]) -> Vec<String> {
    actions
        .iter()
        .flat_map(|a| match a {
            PeerAction::Send(bytes) => vec![to_hex(bytes)],
            PeerAction::SendLatest { units, .. } => units.iter().map(|u| to_hex(u)).collect(),
            _ => Vec::new(),
        })
        .collect()
}

fn holder(doc: &Value) -> Engine {
    let mut holder = engine(identity(3));
    assert_eq!(holder.peer_id().as_str(), doc["holder"].as_str().unwrap());
    let entries: Vec<StoredEvent> = doc["events"]
        .as_array()
        .expect("events")
        .iter()
        .map(|hex| StoredEvent::from_verified(decode_and_verify(&bytes(hex)).expect("verifies")))
        .collect();
    let count = entries.len();
    let received = holder.receive_batch(entries).expect("folds");
    assert_eq!(received.report.folded, count);
    holder
}

fn interest(value: &Value) -> Option<Interest> {
    let partitions = value.get("partitions")?.as_array()?;
    Some(Interest::partitions(partitions.iter().map(|p| {
        PartitionKey::parse(p.as_str().expect("partition")).expect("partition key")
    })))
}

#[test]
fn a_holder_opens_and_answers_cursors_with_the_typescripts_frames() {
    let doc = vectors();
    let joiner = PeerId::parse(doc["joiner"].as_str().unwrap()).unwrap();
    for case in doc["answers"].as_array().expect("answers") {
        let description = case["description"].as_str().unwrap();
        let mut engine = holder(&doc);
        let options = SessionOptions {
            interest: interest(&case["interest"]),
            ..SessionOptions::default()
        };
        let (mut session, opened) =
            PeerSession::open(identity(3), joiner.clone(), options, &engine);
        assert_eq!(sent(&opened), hexes(&case["open"]), "{description}: open");
        let answer = session.on_frame(&mut engine, &bytes(&case["cursors"]), NOW_MS);
        assert_eq!(sent(&answer), hexes(&case["sent"]), "{description}: answer");
        session.close();
    }
}

#[test]
fn a_receiver_sends_the_typescripts_frames_after_each_event() {
    let doc = vectors();
    let holder_peer = PeerId::parse(doc["holder"].as_str().unwrap()).unwrap();
    for case in doc["receives"].as_array().expect("receives") {
        let description = case["description"].as_str().unwrap();
        let mut engine = engine(identity(5));
        assert_eq!(engine.peer_id().as_str(), doc["joiner"].as_str().unwrap());
        let (mut session, opened) = PeerSession::open(
            identity(5),
            holder_peer.clone(),
            SessionOptions::default(),
            &engine,
        );
        assert_eq!(sent(&opened), hexes(&case["open"]), "{description}: open");
        for (i, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let actions = session.on_frame(&mut engine, &bytes(&step["frame"]), NOW_MS);
            assert_eq!(
                sent(&actions),
                hexes(&step["sent"]),
                "{description}: step {i}"
            );
        }
        session.close();
    }
}
