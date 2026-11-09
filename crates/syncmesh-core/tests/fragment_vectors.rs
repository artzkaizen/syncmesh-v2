//! BLE fragmentation against `conformance/fragment-vectors.json`: the same frame cuts into the same
//! fragments, byte for byte, and the fragments come back together in any order (gap U3's radios).

use std::path::PathBuf;

use syncmesh_core::fragment::{HEADER_BYTES, Reassembler, fragment};
use syncmesh_core::{from_hex, to_hex};

fn vectors() -> serde_json::Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "fragment-vectors.json",
    ]
    .iter()
    .collect();
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("json")
}

#[test]
fn every_frame_cuts_into_the_typescripts_fragments_and_back() {
    let doc = vectors();
    assert_eq!(doc["headerBytes"].as_u64(), Some(HEADER_BYTES as u64));
    for v in doc["vectors"].as_array().expect("vectors") {
        let description = v["description"].as_str().unwrap();
        let frame = from_hex(v["frameHex"].as_str().unwrap()).unwrap();
        let limit = v["limit"].as_u64().unwrap() as usize;
        let message = u32::try_from(v["message"].as_u64().unwrap()).unwrap();
        let expected: Vec<&str> = v["fragmentsHex"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h.as_str().unwrap())
            .collect();
        let parts = fragment(&frame, limit, message).unwrap();
        let hex: Vec<String> = parts.iter().map(|p| to_hex(p)).collect();
        assert_eq!(hex, expected, "{description}");
        // reversed, as a radio may deliver them: the frame comes back once, at the last one
        let mut reader = Reassembler::default();
        let rebuilt: Vec<Vec<u8>> = parts
            .iter()
            .rev()
            .filter_map(|p| reader.accept(p))
            .collect();
        assert_eq!(rebuilt, vec![frame], "{description}");
    }
}

#[test]
fn every_refusal_is_the_typescripts() {
    let doc = vectors();
    for r in doc["refusals"].as_array().expect("refusals") {
        let frame = vec![0u8; r["frameBytes"].as_u64().unwrap() as usize];
        let limit = r["limit"].as_u64().unwrap() as usize;
        let error = fragment(&frame, limit, 1).expect_err(r["description"].as_str().unwrap());
        assert_eq!(error.tag(), r["error"].as_str().unwrap());
    }
}
