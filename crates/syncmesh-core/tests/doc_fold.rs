//! The doc change at the fold and on the wire, as the TypeScript's `doc.test.ts` and
//! `doc-fuzz.test.ts` hold it: a genesis joins one lineage cell by the lineage rule — the first
//! genesis wins, as a tree (RFC-0023 §16.1) — whatever order the geneses land in; every other doc change leaves the state alone; and no bytes under tag 6,
//! nor any flip of a valid doc frame, make the decoder panic or pass as the original.

use std::collections::BTreeMap;
use std::path::PathBuf;

use proptest::prelude::*;
use syncmesh_core::cbor::{Key, Value};
use syncmesh_core::doc::{
    DocChange, DocUpdate, GENESIS_RULE, Id16, Settled, lineage_text, read_lineage_cell,
};
use syncmesh_core::envelope::envelope;
use syncmesh_core::record::CellValue;
use syncmesh_core::record::{JsonValue, RowRecord};
use syncmesh_core::state::State;
use syncmesh_core::strategy::StrategyName;
use syncmesh_core::*;

fn peer(n: u8) -> PeerId {
    PeerId::parse(&to_hex(&[n; 32])).unwrap()
}

fn doc(lineage: Option<Id16>, genesis: bool) -> Change {
    replace_of(lineage, genesis, None)
}

fn replace_of(lineage: Option<Id16>, genesis: bool, parent: Option<Id16>) -> Change {
    Change::Doc(DocChange {
        table: "notes".into(),
        key: "n1".into(),
        column: "content".into(),
        adapter: "loro@1".into(),
        lineage,
        update: DocUpdate::Bytes(vec![1, 2, 3]),
        genesis,
        legacy: false,
        parent,
        settles: None,
    })
}

fn genesis(fill: u8, ms: i64, p: u8, parent: Option<u8>) -> (Change, Stamp) {
    (
        replace_of(Some([fill; 16]), true, parent.map(|f| [f; 16])),
        Stamp::new(Hlc::new(ms, 0), peer(p)),
    )
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
fn a_genesis_adds_only_itself_to_the_lineage_cell_and_never_the_write_stamp() {
    let at = Stamp::new(Hlc::new(3, 0), peer(2));
    let written = Stamp::new(Hlc::new(1, 0), peer(1));
    let state = fold(&[insert(&written), (doc(Some([9; 16]), true), at.clone())]);
    let record = state.record("notes", "n1").unwrap();
    let cell = record.cells.get("content").unwrap();
    // the set as the TypeScript holds it: [1, lineage hex → [parent | null, ms, logical, peer]]
    let entry = JsonValue::Array(vec![
        JsonValue::Null,
        JsonValue::Number(3.0),
        JsonValue::Number(0.0),
        JsonValue::Text(peer(2).as_str().to_owned()),
    ]);
    // tagged with the rule's version, as a snapshot page, a repair or persisted state keeps it
    assert_eq!(
        cell.value,
        CellValue::Array(vec![
            JsonValue::Number(GENESIS_RULE as f64),
            JsonValue::Object(BTreeMap::from([(lineage_text(&[9; 16]), entry)])),
        ])
    );
    assert_eq!(cell.stamp, at);
    assert_eq!(record.write_stamp, Some(written));
    assert_eq!(lineage(&state), Some([9; 16]));
}

#[test]
fn the_first_replace_of_a_lineage_wins_and_a_replace_of_the_winner_wins_however_late() {
    let first = genesis(0xa, 1, 1, None);
    let late = genesis(0xb, 5, 2, None);
    assert_eq!(
        lineage(&fold(&[first.clone(), late.clone()])),
        Some([0xa; 16])
    );
    assert_eq!(
        lineage(&fold(&[late.clone(), first.clone()])),
        Some([0xa; 16])
    );
    let restored = genesis(0xc, 9, 2, Some(0xa));
    assert_eq!(
        lineage(&fold(&[restored.clone(), late, first])),
        Some([0xc; 16])
    );
}

#[test]
fn a_genesis_whose_parent_is_missing_waits_and_a_cycle_is_never_walked() {
    let child = genesis(0xb, 2, 2, Some(0xa));
    assert_eq!(lineage(&fold(std::slice::from_ref(&child))), None);
    assert_eq!(
        lineage(&fold(&[child, genesis(0xa, 1, 1, None)])),
        Some([0xb; 16])
    );
    let cycle = [
        genesis(0x1, 1, 1, Some(0x2)),
        genesis(0x2, 2, 1, Some(0x1)),
        genesis(0x3, 3, 1, Some(0x3)),
    ];
    assert_eq!(lineage(&fold(&cycle)), None);
}

/// The rule written out the slow way, as the TypeScript test's `reference`.
fn reference(geneses: &[(Change, Stamp)]) -> Option<Id16> {
    let named: Vec<(Id16, Option<Id16>, &Stamp)> = geneses
        .iter()
        .filter_map(|(c, s)| match c {
            Change::Doc(d) => Some((d.lineage?, d.parent, s)),
            _ => None,
        })
        .collect();
    let mut current = None;
    for _ in 0..=named.len() {
        let first = named
            .iter()
            .filter(|(_, parent, _)| *parent == current)
            .min_by(|a, b| a.2.cmp(b.2).then(a.0.cmp(&b.0)));
        match first {
            Some((l, _, _)) => current = Some(*l),
            None => return current,
        }
    }
    current
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 300, ..ProptestConfig::default() })]

    /// Any tree of geneses — each replacing the root or one before it — in any delivery order, any
    /// replay and any split between two peers that then exchange records, holds one cell and
    /// settles on the reference winner. Stamps are distinct, as a real log's are.
    #[test]
    fn geneses_resolve_as_a_tree_in_every_order(
        specs in proptest::collection::btree_map((0i64..7, 0u8..3), (any::<u32>(), any::<u32>()), 1..8),
        cut in 0usize..8,
    ) {
        let geneses: Vec<(Change, Stamp)> = specs
            .iter()
            .enumerate()
            .map(|(i, ((ms, p), (parent, _)))| {
                let at = (*parent as usize) % (i + 1);
                let parent = (at != i).then_some(at as u8);
                genesis(i as u8, *ms, *p, parent)
            })
            .collect();
        let mut shuffled: Vec<_> = specs.values().map(|(_, order)| *order).zip(geneses.clone()).collect();
        shuffled.sort_by_key(|(order, _)| *order);
        let shuffled: Vec<_> = shuffled.into_iter().map(|(_, g)| g).collect();
        let forward = fold(&geneses);
        prop_assert_eq!(&fold(&shuffled), &forward);
        prop_assert_eq!(&fold(&[shuffled.clone(), geneses.clone()].concat()), &forward);
        let cut = cut.min(shuffled.len());
        let spec = BTreeMap::from([(
            "notes".to_owned(),
            BTreeMap::from([("content".to_owned(), StrategyName::Lineage)]),
        )]);
        let mut joined = State::new();
        for half in [&shuffled[..cut], &shuffled[cut..]] {
            if let Some(record) = fold(half).record("notes", "n1") {
                let record: RowRecord = record.clone();
                merge_record(&mut joined, "notes", "n1", record, Some(&spec));
            }
        }
        prop_assert_eq!(lineage(&joined), lineage(&forward));
        prop_assert_eq!(lineage(&forward), reference(&geneses));
    }

    /// An anchor written over an honest history — every genesis stamped by the cutoff held when it
    /// is computed, each genesis replacing only what came before it — keeps the walk's result in
    /// every order, whatever lands after it, and leaves nothing it passed in the cell (gaps U21),
    /// as the TypeScript's "an anchor written over every honest history" property.
    #[test]
    fn an_anchor_over_an_honest_history_keeps_the_walk_in_every_order(
        settled in proptest::collection::btree_set((0i64..7, 0u8..3), 1..6),
        later in proptest::collection::btree_set((8i64..15, 0u8..3), 0..4),
        parents in proptest::collection::vec(any::<u32>(), 9),
        order in proptest::collection::vec(any::<u32>(), 10),
        cutoff in 0i64..7,
    ) {
        // sorted by stamp, so a genesis only ever replaces one written before it
        let stamps: Vec<(i64, u8)> = settled.iter().chain(later.iter()).copied().collect();
        let tree: Vec<(Change, Stamp)> = stamps
            .iter()
            .enumerate()
            .map(|(i, (ms, p))| {
                let at = (parents[i] as usize) % (i + 1);
                genesis(i as u8, *ms, *p, (at != i).then_some(at as u8))
            })
            .collect();
        let ms = |s: &Stamp| s.hlc.ms;
        let held: Vec<_> = tree.iter().filter(|(_, s)| ms(s) <= cutoff).cloned().collect();
        let held_state = fold(&held);
        let cell = held_state
            .record("notes", "n1")
            .and_then(|r| r.cells.get("content"))
            .map(|c| &c.value);
        // the deepest lineage on the walk replaced by the cutoff, as `settleWalk` names it
        let read = read_lineage_cell(cell);
        let mut anchor: Option<Settled> = None;
        let mut at = None;
        loop {
            let next = read
                .geneses
                .iter()
                .filter(|g| g.parent == at)
                .min_by(|a, b| a.stamp.cmp(&b.stamp).then(a.lineage.cmp(&b.lineage)));
            match next {
                Some(g) if ms(&g.stamp) <= cutoff => {
                    anchor = Some(Settled { lineage: g.lineage, stamp: g.stamp.clone() });
                    at = Some(g.lineage);
                }
                _ => break,
            }
        }
        let settling = (
            Change::Doc(DocChange {
                settles: anchor,
                ..match replace_of(Some([0xf; 16]), true, lineage(&held_state)) {
                    Change::Doc(d) => d,
                    _ => unreachable!(),
                }
            }),
            Stamp::new(Hlc::new(7, 0), peer(0)),
        );
        let all: Vec<_> = tree.iter().cloned().chain([settling]).collect();
        let mut shuffled: Vec<_> = order.iter().copied().zip(all.clone()).collect();
        shuffled.sort_by_key(|(o, _)| *o);
        let shuffled: Vec<_> = shuffled.into_iter().map(|(_, g)| g).collect();
        let forward = fold(&all);
        prop_assert_eq!(&fold(&shuffled), &forward);
        prop_assert_eq!(&fold(&[shuffled.clone(), all.clone()].concat()), &forward);
        let untrimmed: Vec<_> = all
            .iter()
            .map(|(c, s)| match c {
                Change::Doc(d) => (Change::Doc(DocChange { settles: None, ..d.clone() }), s.clone()),
                other => (other.clone(), s.clone()),
            })
            .collect();
        prop_assert_eq!(lineage(&forward), lineage(&fold(&untrimmed)));
        let kept = read_lineage_cell(
            forward
                .record("notes", "n1")
                .and_then(|r| r.cells.get("content"))
                .map(|c| &c.value),
        );
        if let Some(anchor) = &kept.settled {
            for g in &kept.geneses {
                prop_assert!(g.stamp > anchor.stamp && g.lineage != anchor.lineage);
            }
        }
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
