//! The frozen vectors, byte for byte (D35: a slice is done when its vectors pass from Rust).

use std::path::PathBuf;

use syncmesh_core::cbor::{Key, Value};
use syncmesh_core::event::Change;
use syncmesh_core::record::CellValue;
use syncmesh_core::*;

fn vectors(name: &str) -> serde_json::Value {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "..", "..", "conformance", name]
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

#[test]
fn wire_vectors_decode_verify_and_reencode_byte_for_byte() {
    let doc = vectors("wire-vectors.json");
    let peer = doc["peerId"].as_str().unwrap();
    let list = doc["vectors"].as_array().unwrap();
    assert_eq!(list.len(), 3);
    for (i, v) in list.iter().enumerate() {
        let (core, sig) = (hex(v, "coreHex"), hex(v, "sigHex"));
        let wire = envelope::envelope(&core, &sig);
        let verified =
            decode_and_verify(&wire).unwrap_or_else(|e| panic!("{}: {e}", v["description"]));
        assert_eq!(verified.event.peer_id.as_str(), peer);
        assert_eq!(verified.event.seq_num.get(), i as u64 + 1);
        assert!(verified.event.partition.is_none());
        assert!(!verified.event.sealed);
        assert_eq!(verified.event.changes.len(), 1);
        // the decoder dropped nothing: encoding the event reproduces the signed bytes
        assert_eq!(
            to_hex(&encode_event_core(&verified.event)),
            to_hex(&core),
            "{}",
            v["description"]
        );
        assert_eq!(verified.event.id(), format!("{peer}-{}", i + 1));

        // a flipped byte in either half is refused as a value
        let mut bad_sig = sig.clone();
        bad_sig[0] ^= 1;
        assert_eq!(
            decode_and_verify(&envelope::envelope(&core, &bad_sig)),
            Err(envelope::WireError::BadSignature)
        );
        let mut bad_core = core.clone();
        *bad_core.last_mut().unwrap() ^= 1;
        assert!(decode_and_verify(&envelope::envelope(&bad_core, &sig)).is_err());
    }

    let first = decode_event_core(&hex(&list[0], "coreHex")).unwrap();
    assert_eq!(first.procedure, "notes.create");
    let Change::Insert { table, key, row } = &first.changes[0] else {
        panic!("insert")
    };
    assert_eq!((table.as_str(), key.as_str()), ("notes", "k1"));
    assert_eq!(row["title"], CellValue::text("hello"));
    assert_eq!(row["pinned"], CellValue::Bool(false));
    assert_eq!(row["body"], CellValue::text(""));
    assert_eq!(row["updatedAt"], CellValue::Number(first.hlc.ms as f64));

    let second = decode_event_core(&hex(&list[1], "coreHex")).unwrap();
    let Change::Update { patch, .. } = &second.changes[0] else {
        panic!("update")
    };
    assert_eq!(patch["title"], CellValue::text("h\u{eb}llo \u{2728}"));
    assert_eq!(second.hlc.logical, 1);

    let third = decode_event_core(&hex(&list[2], "coreHex")).unwrap();
    assert!(matches!(&third.changes[0], Change::Delete { .. }));
    assert_eq!(third.procedure, "notes.delete");
}

/// A fold of the three vectors lands on the deleted note, in any order.
#[test]
fn wire_vectors_fold_to_one_state_in_any_order() {
    let doc = vectors("wire-vectors.json");
    let events: Vec<_> = doc["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| decode_event_core(&hex(v, "coreHex")).unwrap())
        .collect();
    let fold = |order: &[usize]| {
        let mut state = state::State::new();
        for &i in order {
            let e = &events[i];
            for c in &e.changes {
                apply_change(&mut state, c, &e.stamp(), None, e.partition.as_ref()).unwrap();
            }
        }
        state
    };
    let expected = fold(&[0, 1, 2]);
    for order in [[2, 1, 0], [1, 0, 2], [0, 2, 1], [2, 0, 1], [1, 2, 0]] {
        assert_eq!(fold(&order), expected, "{order:?}");
    }
    assert!(expected.read_row("notes", "k1").is_none());
    let mut two = state::State::new();
    for e in &events[..2] {
        for c in &e.changes {
            apply_change(&mut two, c, &e.stamp(), None, None).unwrap();
        }
    }
    let row = two.read_row("notes", "k1").unwrap();
    assert_eq!(row["title"], CellValue::text("h\u{eb}llo \u{2728}"));
    assert_eq!(row["pinned"], CellValue::Bool(false));
}

/// Every other signed thing on the wire is `[core, sig]` over canonical CBOR, signed by the key the
/// document names. The core is not re-shaped here (those codecs are a later slice), but its bytes
/// must already be canonical: decode → encode reproduces them.
fn check_signed_vectors(file: &str, signer_key: &str) {
    let doc = vectors(file);
    let signer = from_hex(doc[signer_key].as_str().unwrap()).unwrap();
    let list = doc["vectors"].as_array().unwrap();
    assert!(!list.is_empty(), "{file} has vectors");
    for v in list {
        let wire = hex(v, "wireHex");
        let (core, sig) =
            split_envelope(&wire).unwrap_or_else(|e| panic!("{file} {}: {e}", v["description"]));
        assert!(
            verify(&core, &sig, &signer),
            "{file} {}: signature by {signer_key}",
            v["description"]
        );
        let value = decode_cbor(&core).unwrap();
        assert_eq!(
            encode_cbor(&value),
            core,
            "{file} {}: core is canonical",
            v["description"]
        );
        assert_eq!(
            encode_cbor(&decode_cbor(&wire).unwrap()),
            wire,
            "{file} {}: envelope is canonical",
            v["description"]
        );
        // a signed core is a map with integer keys, version 1 under key 0
        let Value::Map(m) = value else {
            panic!("{file}: core is a map")
        };
        assert_eq!(m.get(&Key::Int(0)), Some(&Value::Int(1)), "{file}: v=1");
    }
}

#[test]
fn grant_vectors_are_signed_by_the_issuer() {
    check_signed_vectors("grant-vectors.json", "issuerId");
}

#[test]
fn account_link_vectors_are_signed_by_the_account() {
    check_signed_vectors("account-vectors.json", "accountId");
}

#[test]
fn receipt_vectors_are_signed_by_the_holder() {
    check_signed_vectors("receipt-vectors.json", "holderId");
}

#[test]
fn checkpoint_vectors_are_signed_by_the_issuer() {
    check_signed_vectors("checkpoint-vectors.json", "issuerId");
}

/// What Rust signs, Rust reads back: the envelope round-trips and the signature binds the exact core.
#[test]
fn a_rust_signed_event_round_trips_through_the_envelope() {
    let id = Identity::from_seed(&std::array::from_fn(|i| i as u8));
    let mut row = record::Row::new();
    row.insert("title".to_owned(), CellValue::text("hello"));
    row.insert("n".to_owned(), CellValue::Number(1.5));
    row.insert("blob".to_owned(), CellValue::Bytes(vec![1, 2, 3]));
    let event = SyncEvent {
        peer_id: id.peer_id().clone(),
        seq_num: event::SeqNum::parse(1).unwrap(),
        hlc: Hlc::new(1_700_000_000_000, 2),
        procedure: "notes.create".to_owned(),
        partition: Some(event::PartitionKey::parse("org:acme").unwrap()),
        changes: vec![Change::Insert {
            table: "notes".into(),
            key: "k1".into(),
            row,
        }],
        sealed: false,
    };
    let signed = sign_event(event.clone(), &id);
    let back = decode_and_verify(&signed.wire).unwrap();
    assert_eq!(back.event, event);
    assert_eq!(back.core, signed.core);
    // the same bytes signed by another key are refused
    let other = Identity::from_seed(&[9; 32]);
    let forged = envelope::envelope(&signed.core, &other.sign(&signed.core));
    assert_eq!(
        decode_and_verify(&forged),
        Err(envelope::WireError::BadSignature)
    );
}
