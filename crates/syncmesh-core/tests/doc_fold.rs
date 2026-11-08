//! The doc change at the fold and on the wire, as the TypeScript's `doc.test.ts` and
//! `doc-fuzz.test.ts` hold it: a genesis joins one lineage cell by the lineage rule, whatever order
//! the geneses land in; every other doc change leaves the state alone; and no bytes under tag 6,
//! nor any flip of a valid doc frame, make the decoder panic or pass as the original.

use std::collections::BTreeMap;
use std::path::PathBuf;

use proptest::prelude::*;
use syncmesh_core::cbor::{Key, Value};
use syncmesh_core::doc::{DocChange, DocUpdate, Id16, lineage_text};
use syncmesh_core::envelope::envelope;
use syncmesh_core::record::CellValue;
use syncmesh_core::state::State;
use syncmesh_core::*;

fn peer(n: u8) -> PeerId {
    PeerId::parse(&to_hex(&[n; 32])).unwrap()
}

fn doc(lineage: Option<Id16>, genesis: bool) -> Change {
    Change::Doc(DocChange {
        table: "notes".into(),
        key: "n1".into(),
        column: "content".into(),
        adapter: "loro@1".into(),
        lineage,
        update: DocUpdate::Bytes(vec![1, 2, 3]),
        genesis,
    })
}

fn insert(stamp: &Stamp) -> (Change, Stamp) {
    let row = BTreeMap::from([("title".to_owned(), CellValue::text("t"))]);
    let change = Change::Insert {
        table: "notes".into(),
        key: "n1".into(),
        row,
    };
    (change, stamp.clone())
}

fn fold(changes: &[(Change, Stamp)]) -> State {
    let mut state = State::new();
    for (change, stamp) in changes {
        apply_change(&mut state, change, stamp, None, None).unwrap();
    }
    state
}

fn lineage(state: &State) -> Option<Id16> {
    lineage_of(state.record("notes", "n1"), "content")
}

#[test]
fn an_ordinary_doc_change_leaves_the_state_as_it_was() {
    let base = fold(&[insert(&Stamp::new(Hlc::new(1, 0), peer(1)))]);
    let mut after = base.clone();
    let stamp = Stamp::new(Hlc::new(2, 0), peer(2));
    apply_change(&mut after, &doc(None, false), &stamp, None, None).unwrap();
    apply_change(&mut after, &doc(Some([7; 16]), false), &stamp, None, None).unwrap();
    assert_eq!(after, base);
}

#[test]
fn a_genesis_sets_only_the_lineage_cell_and_never_the_write_stamp() {
    let at = Stamp::new(Hlc::new(3, 0), peer(2));
    let written = Stamp::new(Hlc::new(1, 0), peer(1));
    let state = fold(&[insert(&written), (doc(Some([9; 16]), true), at.clone())]);
    let record = state.record("notes", "n1").unwrap();
    let cell = record.cells.get("content").unwrap();
    // the id as the TypeScript holds it: 32 lowercase hex characters
    assert_eq!(cell.value, CellValue::Text(lineage_text(&[9; 16])));
    assert_eq!(cell.stamp, at);
    assert_eq!(record.write_stamp, Some(written));
    assert_eq!(lineage(&state), Some([9; 16]));
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 300, ..ProptestConfig::default() })]

    /// Any delivery order, and any replay, of geneses with distinct stamps — one author's clock never
    /// repeats, and one event starts one lineage per document — lands on the greatest stamp's lineage.
    #[test]
    fn geneses_resolve_by_stamp_in_every_order(
        specs in proptest::collection::btree_map((0i64..6, 0u8..3), (0u8..16, any::<u32>()), 1..6),
    ) {
        let geneses: Vec<(Change, Stamp)> = specs
            .iter()
            .map(|((ms, p), (fill, _))| (doc(Some([*fill; 16]), true), Stamp::new(Hlc::new(*ms, 0), peer(*p))))
            .collect();
        let mut shuffled: Vec<_> = specs.values().map(|(_, order)| *order).zip(geneses.clone()).collect();
        shuffled.sort_by_key(|(order, _)| *order);
        let shuffled: Vec<_> = shuffled.into_iter().map(|(_, g)| g).collect();
        let forward = fold(&geneses);
        prop_assert_eq!(&fold(&shuffled), &forward);
        prop_assert_eq!(&fold(&[geneses.clone(), geneses.clone()].concat()), &forward);
        let winner = geneses.iter().max_by(|a, b| a.1.cmp(&b.1)).unwrap();
        let Change::Doc(d) = &winner.0 else { unreachable!() };
        prop_assert_eq!(lineage(&forward), d.lineage);
    }

    /// Flips and truncations of the frozen insert+genesis frame: refused unless byte-identical.
    #[test]
    fn flipped_doc_frames_never_pass_as_the_original(flip in 0usize..10_000, cut in proptest::option::of(0usize..400)) {
        let pristine = frozen_genesis_frame();
        let mut frame = match cut {
            Some(at) if at < pristine.len() => pristine[..at].to_vec(),
            _ => pristine.clone(),
        };
        if !frame.is_empty() {
            let i = flip % frame.len();
            frame[i] ^= 1 << (flip % 8);
        }
        if let Ok(verified) = decode_and_verify(&frame) {
            prop_assert_eq!(verified.wire, pristine);
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 500, ..ProptestConfig::default() })]

    /// Arbitrary `data` under tag 6, validly signed: decoding is a value every time.
    #[test]
    fn garbage_doc_data_never_panics(data in garbage()) {
        let id = Identity::from_seed(&[0x40; 32]);
        let change = Value::map([
            (Key::Int(0), Value::Int(6)),
            (Key::Int(1), Value::text("notes")),
            (Key::Int(2), Value::text("n1")),
            (Key::Int(3), data),
        ]);
        let core = encode_cbor(&Value::map([
            (Key::Int(0), Value::Int(1)),
            (Key::Int(1), Value::Bytes(id.public_key().to_vec())),
            (Key::Int(2), Value::Int(1)),
            (Key::Int(3), Value::Array(vec![Value::Int(1), Value::Int(0)])),
            (Key::Int(5), Value::text("notes.edit")),
            (Key::Int(7), Value::Array(vec![change])),
        ]));
        if let Ok(event) = decode_event_core(&core) {
            prop_assert!(matches!(event.changes.as_slice(), [Change::Doc(_)]));
            prop_assert_eq!(syncmesh_core::event_codec::decode_event_core(&syncmesh_core::event_codec::encode_event_core(&event)), Ok(event));
        }
        let _ = decode_and_verify(&envelope(&core, &id.sign(&core)));
    }
}

fn garbage() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i32>().prop_map(|n| Value::Int(n as i64)),
        "[a-z@0-9]{0,8}".prop_map(Value::Text),
        proptest::collection::vec(any::<u8>(), 0..40).prop_map(Value::Bytes),
    ];
    prop_oneof![
        leaf.clone(),
        proptest::collection::btree_map((0i64..8).prop_map(Key::Int), leaf, 0..7)
            .prop_map(Value::Map),
    ]
}

fn frozen_genesis_frame() -> Vec<u8> {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "doc-vectors.json",
    ]
    .iter()
    .collect();
    let file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let v = &file["events"][2];
    envelope(
        &from_hex(v["coreHex"].as_str().unwrap()).unwrap(),
        &from_hex(v["sigHex"].as_str().unwrap()).unwrap(),
    )
}
