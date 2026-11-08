//! Which of a peer's compaction floors a device is below, against
//! `conformance/rejoin-vectors.json` (D46): the TypeScript's `belowFloor`, answer for answer.

use std::path::PathBuf;

use syncmesh_core::event::{PeerId, SeqNum};
use syncmesh_core::rejoin::below_peer_floor;

fn vectors() -> serde_json::Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "rejoin-vectors.json",
    ]
    .iter()
    .collect();
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("json")
}

fn pairs(v: &serde_json::Value) -> Vec<(PeerId, SeqNum)> {
    v.as_array()
        .expect("pairs")
        .iter()
        .map(|pair| {
            let peer = PeerId::parse(pair[0].as_str().expect("peer")).expect("peer id");
            let seq = SeqNum::parse(pair[1].as_u64().expect("seq")).expect("seq");
            (peer, seq)
        })
        .collect()
}

#[test]
fn below_peer_floor_matches_every_frozen_answer() {
    let doc = vectors();
    let own = PeerId::parse(doc["self"].as_str().expect("self")).expect("peer id");
    let list = doc["vectors"].as_array().expect("vectors");
    assert_eq!(list.len(), 7);
    for v in list {
        let what = v["description"].as_str().expect("description");
        let below = below_peer_floor(
            &own,
            &pairs(&v["ours"]),
            &pairs(&v["theirs"]),
            &pairs(&v["floor"]),
        );
        assert_eq!(below, pairs(&v["below"]), "{what}");
    }
}
