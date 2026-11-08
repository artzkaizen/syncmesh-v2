//! `conformance/doc-vectors.json`, byte for byte (RFC-0023 §13). The TypeScript generates the
//! file from fixed seeds; this rebuilds every event and the checkpoint from the same seeds and
//! must land on the same core and signature bytes, and must read the frozen bytes back to them.

use std::collections::BTreeMap;
use std::path::PathBuf;

use syncmesh_core::doc::{DocBlobRef, DocChange, DocColumns, DocUpdate, Id16, parse_lineage_cells};
use syncmesh_core::doc_checkpoint::{DocCheckpoint, encode_doc_checkpoint_core};
use syncmesh_core::envelope::envelope;
use syncmesh_core::event::{PartitionKey, SeqNum};
use syncmesh_core::event_codec::encode_event_core;
use syncmesh_core::record::CellValue;
use syncmesh_core::record_codec::{decode_record, encode_record};
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

fn seq(n: u64) -> SeqNum {
    SeqNum::parse(n).unwrap()
}

fn id16(s: &str) -> Id16 {
    from_hex(s).unwrap().try_into().unwrap()
}

const T0: i64 = 1_700_000_000_000;

fn author() -> Identity {
    Identity::from_seed(&std::array::from_fn(|i| 0x40 + i as u8))
}

fn producer() -> Identity {
    Identity::from_seed(&std::array::from_fn(|i| 0x80 + i as u8))
}

fn doc(lineage: Option<Id16>, update: DocUpdate, genesis: bool) -> Change {
    replace_of(lineage, update, genesis, None)
}

fn replace_of(
    lineage: Option<Id16>,
    update: DocUpdate,
    genesis: bool,
    parent: Option<Id16>,
) -> Change {
    Change::Doc(DocChange {
        table: "notes".into(),
        key: "n1".into(),
        column: "content".into(),
        adapter: "loro@1".into(),
        lineage,
        update,
        genesis,
        legacy: false,
        parent,
    })
}

fn loro() -> DocUpdate {
    DocUpdate::Bytes(b"loro".to_vec())
}

/// The six frozen events, built here from scratch.
fn events() -> Vec<SyncEvent> {
    let a = author();
    let at = |n: u64, procedure: &str, changes: Vec<Change>| SyncEvent {
        peer_id: a.peer_id().clone(),
        seq_num: seq(n),
        hlc: Hlc::new(T0 + n as i64, 0),
        procedure: procedure.into(),
        partition: Some(PartitionKey::parse("workspace:w1").unwrap()),
        changes,
        sealed: false,
        action: None,
        undo_of: None,
        schema_version: None,
    };
    let action = id16("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf");
    let undone = id16("b0b1b2b3b4b5b6b7b8b9babbbcbdbebf");
    let genesis = derive_lineage(a.peer_id(), seq(3), 1);
    vec![
        at(1, "notes.edit", vec![doc(None, loro(), false)]),
        at(
            2,
            "notes.edit",
            vec![doc(
                Some(id16("0102030405060708090a0b0c0d0e0f10")),
                DocUpdate::Blob(DocBlobRef {
                    hash: [0xab; 32],
                    size: 70_000,
                }),
                false,
            )],
        ),
        at(
            3,
            "notes.replace",
            vec![
                Change::Insert {
                    table: "notes".into(),
                    key: "n1".into(),
                    row: BTreeMap::from([("content".to_owned(), CellValue::Null)]),
                },
                doc(Some(genesis), DocUpdate::Bytes(vec![1, 2, 3]), true),
            ],
        ),
        SyncEvent {
            action: Some(action),
            ..at(4, "notes.edit", vec![doc(None, loro(), false)])
        },
        SyncEvent {
            action: Some(undone),
            undo_of: Some(action),
            ..at(5, "revert", vec![doc(None, loro(), false)])
        },
        at(
            6,
            "notes.replace",
            vec![replace_of(
                Some(derive_lineage(a.peer_id(), seq(6), 0)),
                DocUpdate::Bytes(vec![4, 5, 6]),
                true,
                Some(genesis),
            )],
        ),
    ]
}

/// Every order of a short list: each frozen lineage tree is folded in all of them.
fn permutations<T: Clone>(xs: &[T]) -> Vec<Vec<T>> {
    if xs.len() <= 1 {
        return vec![xs.to_vec()];
    }
    (0..xs.len())
        .flat_map(|i| {
            let mut rest = xs.to_vec();
            let x = rest.remove(i);
            permutations(&rest).into_iter().map(move |mut p| {
                p.insert(0, x.clone());
                p
            })
        })
        .collect()
}

#[test]
fn every_frozen_lineage_tree_folds_to_one_record_and_one_winner_in_every_order() {
    let file = vectors("doc-vectors.json");
    let trees = file["lineageTrees"].as_array().unwrap();
    assert!(!trees.is_empty());
    for tree in trees {
        let what = tree["description"].as_str().unwrap();
        let geneses: Vec<(Change, Stamp)> = tree["geneses"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| {
                let parent = g["parent"].as_str().map(id16);
                let change = replace_of(
                    Some(id16(g["lineage"].as_str().unwrap())),
                    DocUpdate::Bytes(Vec::new()),
                    true,
                    parent,
                );
                let stamp = Stamp::new(
                    Hlc::new(
                        g["ms"].as_i64().unwrap(),
                        g["logical"].as_u64().unwrap() as u32,
                    ),
                    PeerId::parse(g["peer"].as_str().unwrap()).unwrap(),
                );
                (change, stamp)
            })
            .collect();
        let winner = tree["winner"].as_str().map(id16);
        for order in permutations(&geneses) {
            let mut state = syncmesh_core::state::State::new();
            for (change, stamp) in &order {
                apply_change(&mut state, change, stamp, None, None).unwrap();
            }
            let record = state.record("notes", "n1");
            let bytes = record
                .map(|r| to_hex(&encode_record(r)))
                .unwrap_or_default();
            assert_eq!(bytes, tree["recordHex"].as_str().unwrap(), "record: {what}");
            assert_eq!(lineage_of(record, "content"), winner, "winner: {what}");
        }
    }
}

#[test]
fn every_doc_event_is_rebuilt_and_signed_byte_for_byte() {
    let file = vectors("doc-vectors.json");
    let a = author();
    assert_eq!(file["authorId"], a.peer_id().as_str());
    let frozen = file["events"].as_array().unwrap();
    let built = events();
    assert_eq!(frozen.len(), built.len());
    for (v, event) in frozen.iter().zip(&built) {
        let what = v["description"].as_str().unwrap();
        let core = encode_event_core(event);
        assert_eq!(
            to_hex(&core),
            v["coreHex"].as_str().unwrap(),
            "core: {what}"
        );
        assert_eq!(
            to_hex(&a.sign(&core)),
            v["sigHex"].as_str().unwrap(),
            "sig: {what}"
        );
    }
}

#[test]
fn every_frozen_doc_event_decodes_verifies_and_reencodes() {
    let file = vectors("doc-vectors.json");
    let built = events();
    for (v, expected) in file["events"].as_array().unwrap().iter().zip(built) {
        let wire = envelope(&hex(v, "coreHex"), &hex(v, "sigHex"));
        let verified = decode_and_verify(&wire).expect("verifies");
        assert_eq!(verified.event, expected);
        assert_eq!(encode_event_core(&verified.event), hex(v, "coreHex"));
        for (index, change) in verified.event.changes.iter().enumerate() {
            if let Change::Doc(d) = change
                && d.genesis
            {
                let derived = derive_lineage(
                    &verified.event.peer_id,
                    verified.event.seq_num,
                    index as u32,
                );
                assert_eq!(d.lineage, Some(derived));
            }
        }
    }
}

#[test]
fn every_frozen_lineage_derives_the_same() {
    let file = vectors("doc-vectors.json");
    for l in file["lineages"].as_array().unwrap() {
        let peer = PeerId::parse(l["peerId"].as_str().unwrap()).unwrap();
        let seq = seq(l["seq"].as_u64().unwrap());
        let index = l["index"].as_u64().unwrap() as u32;
        assert_eq!(
            to_hex(&doc_change_id(&peer, seq, index)),
            l["changeIdHex"].as_str().unwrap()
        );
        assert_eq!(
            to_hex(&derive_lineage(&peer, seq, index)),
            l["lineageHex"].as_str().unwrap()
        );
    }
}

#[test]
fn every_frozen_lineage_cell_reaches_the_typescripts_verdict() {
    let file = vectors("doc-vectors.json");
    let cells = file["lineageCells"].as_array().unwrap();
    assert_eq!(cells.len(), 4);
    let docs = DocColumns::from([(
        "notes".to_owned(),
        BTreeMap::from([("content".to_owned(), "loro@1".to_owned())]),
    )]);
    for cell in cells {
        let what = cell["description"].as_str().unwrap();
        let bytes = hex(cell, "recordHex");
        let record = decode_record(&bytes).unwrap_or_else(|e| panic!("{what}: {e:?}"));
        assert_eq!(encode_record(&record), bytes, "re-encoded: {what}");
        let parsed = parse_lineage_cells([("notes", "n1", &record)], &docs);
        assert_eq!(
            parsed.is_err(),
            cell["refused"].as_bool().unwrap(),
            "verdict: {what}"
        );
        match parsed {
            Err(refused) => assert_eq!(refused.version, cell["version"].as_i64(), "{what}"),
            Ok(()) => assert_eq!(
                lineage_of(Some(&record), "content"),
                cell["winner"].as_str().map(id16),
                "winner: {what}"
            ),
        }
    }
}

#[test]
fn the_frozen_checkpoint_is_rebuilt_signed_and_read_back() {
    let file = vectors("doc-vectors.json");
    let (a, p) = (author(), producer());
    assert_eq!(file["producerId"], p.peer_id().as_str());
    let checkpoint = DocCheckpoint {
        table: "notes".into(),
        key: "n1".into(),
        column: "content".into(),
        adapter: "loro@1".into(),
        lineage: Some(derive_lineage(a.peer_id(), seq(3), 1)),
        covers: BTreeMap::from([(a.peer_id().clone(), seq(5)), (p.peer_id().clone(), seq(2))]),
        version: vec![0x01, 0x05],
        snapshot: DocBlobRef {
            hash: [0xcd; 32],
            size: 4_096,
        },
        derived: BTreeMap::from([
            ("title".to_owned(), CellValue::text("Q3")),
            ("wordCount".to_owned(), CellValue::Number(812.0)),
        ]),
        at: Hlc::new(T0 + 10, 1),
    };
    let v = &file["checkpoint"];
    let core = encode_doc_checkpoint_core(&checkpoint);
    assert_eq!(to_hex(&core), v["coreHex"].as_str().unwrap());
    assert_eq!(to_hex(&p.sign(&core)), v["sigHex"].as_str().unwrap());
    let wire = envelope(&hex(v, "coreHex"), &hex(v, "sigHex"));
    assert_eq!(decode_doc_checkpoint(&wire, p.peer_id()), Ok(checkpoint));
    assert!(
        decode_doc_checkpoint(&wire, a.peer_id()).is_err(),
        "another producer's key"
    );
}

#[test]
fn the_frozen_v1_vector_is_undisturbed_by_the_new_keys() {
    let file = vectors("doc-vectors.json");
    let wire_vectors = vectors("wire-vectors.json");
    let core_hex = file["v1"]["coreHex"].as_str().unwrap();
    assert_eq!(
        core_hex,
        wire_vectors["vectors"][0]["coreHex"].as_str().unwrap()
    );
    let event = decode_event_core(&from_hex(core_hex).unwrap()).unwrap();
    assert_eq!(to_hex(&encode_event_core(&event)), core_hex);
    assert_eq!((event.action, event.undo_of), (None, None));
    assert!(matches!(event.changes.as_slice(), [Change::Insert { .. }]));
}
