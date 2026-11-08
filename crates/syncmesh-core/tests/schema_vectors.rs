//! D31's wire, byte for byte against `conformance/schema-vectors.json`: `schemaVersion` under
//! event core key 9, the sender's version at index 5 of the cursors frame, and the refusal a
//! dropped table's write is answered with. Each one decodes to what TypeScript reads, and the
//! well-formed ones Rust mints to the frozen bytes.

use std::path::PathBuf;

use syncmesh_core::envelope::envelope;
use syncmesh_core::event::{PeerId, SchemaVersion, SeqNum};
use syncmesh_core::frames::{self, Frame, decode_frame};
use syncmesh_core::refusal::{self, QuarantineReason, RefusalRequest};
use syncmesh_core::{Identity, decode_and_verify, encode_event_core, from_hex, to_hex};

const NOW: i64 = 1_700_000_000_000;

fn vectors() -> serde_json::Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "schema-vectors.json",
    ]
    .iter()
    .collect();
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("json")
}

fn hex(v: &serde_json::Value, key: &str) -> Vec<u8> {
    from_hex(v[key].as_str().expect(key)).expect("hex")
}

fn text<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("{key} is text"))
}

/// `seed(n)` in the TypeScript fixtures: bytes `n, n+1, …` mod 256.
fn seed(n: u8) -> Identity {
    Identity::from_seed(&std::array::from_fn(|i| n.wrapping_add(i as u8)))
}

fn version(v: &serde_json::Value) -> Option<SchemaVersion> {
    v["schemaVersion"]
        .as_u64()
        .map(|n| SchemaVersion::parse(n).unwrap())
}

#[test]
fn key_9_is_a_reading_every_event_still_decodes() {
    let doc = vectors();
    let device = seed(200);
    assert_eq!(text(&doc, "peerId"), device.peer_id().as_str());
    let list = doc["events"].as_array().unwrap();
    assert_eq!(list.len(), 4);
    for v in list {
        let what = text(v, "description");
        let (core, sig) = (hex(v, "coreHex"), hex(v, "sigHex"));
        // Ed25519 is deterministic: the same seed signs the same core to the same bytes
        assert_eq!(
            to_hex(&device.sign(&core)),
            to_hex(&sig),
            "{what}: signature"
        );
        let verified =
            decode_and_verify(&envelope(&core, &sig)).unwrap_or_else(|e| panic!("{what}: {e}"));
        assert_eq!(verified.event.schema_version, version(v), "{what}");
        assert_eq!(verified.event.changes.len(), 1, "{what}");
        let reencoded = to_hex(&encode_event_core(&verified.event)) == to_hex(&core);
        assert_eq!(
            reencoded,
            v["reencodes"].as_bool().unwrap(),
            "{what}: re-encode"
        );
    }
}

#[test]
fn the_cursors_frame_carries_the_version_at_index_5() {
    let doc = vectors();
    let device = seed(200);
    let other = seed(121);
    let cursors = vec![
        (device.peer_id().clone(), SeqNum::parse(7).unwrap()),
        (other.peer_id().clone(), SeqNum::parse(3).unwrap()),
    ];
    let ahead = vec![(
        other.peer_id().clone(),
        vec![SeqNum::parse(5).unwrap(), SeqNum::parse(6).unwrap()],
    )];
    let list = doc["frames"].as_array().unwrap();
    assert_eq!(list.len(), 3);
    for v in list {
        let what = text(v, "description");
        let wire = hex(v, "wireHex");
        let Frame::Cursors {
            from,
            cursors: read,
            ahead: above,
            schema_version,
        } = decode_frame(&wire).unwrap_or_else(|e| panic!("{what}: {e:?}"))
        else {
            panic!("{what}: expected cursors");
        };
        assert_eq!(&from, device.peer_id(), "{what}");
        assert_eq!(read, cursors, "{what}");
        assert_eq!(schema_version, version(v), "{what}");
        let held = v["ahead"].as_bool().unwrap();
        assert_eq!(
            above.as_ref().is_some_and(|a| !a.is_empty()),
            held,
            "{what}"
        );
        // the well-formed ones, minted here
        if let Some(declared) = schema_version {
            let minted = frames::cursors_frame(
                device.peer_id(),
                &cursors,
                held.then_some(ahead.as_slice()),
                Some(declared),
            );
            assert_eq!(
                to_hex(&minted),
                to_hex(&wire),
                "{what}: Rust mints the frozen bytes"
            );
        }
    }
}

#[test]
fn a_dropped_tables_refusal_travels_as_refused() {
    let doc = vectors();
    let (refuser, author) = (seed(21), seed(121));
    assert_eq!(text(&doc, "refuserId"), refuser.peer_id().as_str());
    assert_eq!(text(&doc, "authorId"), author.peer_id().as_str());
    let list = doc["refusals"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    for v in list {
        let what = text(v, "description");
        let wire = hex(v, "wireHex");
        let signed = refusal::verify_refusal(&wire).unwrap_or_else(|e| panic!("{what}: {e}"));
        assert_eq!(signed.value.reason, QuarantineReason::Refused, "{what}");
        assert_eq!(signed.value.verdict, "TableDropped", "{what}");
        let request = RefusalRequest {
            author: PeerId::parse(text(&doc, "authorId")).unwrap(),
            seq: SeqNum::parse(v["seq"].as_u64().unwrap()).unwrap(),
            reason: QuarantineReason::parse(text(v, "reason")).unwrap(),
            verdict: text(v, "verdict").to_owned(),
            now_ms: NOW,
        };
        assert_eq!(
            to_hex(&refusal::issue_refusal(&refuser, &request)),
            to_hex(&wire),
            "{what}: Rust mints the frozen bytes"
        );
    }
}
