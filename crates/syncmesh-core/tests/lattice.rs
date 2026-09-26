//! The four strategies are lattice joins over their normal forms, and the fold is order-independent.

use std::collections::BTreeMap;

use proptest::prelude::*;
use syncmesh_core::event::{Change, PeerId};
use syncmesh_core::hlc::Hlc;
use syncmesh_core::record::{Cell, CellValue, JsonValue};
use syncmesh_core::stamp::Stamp;
use syncmesh_core::state::State;
use syncmesh_core::strategy::{StrategyName, join};
use syncmesh_core::*;

fn peer(n: u8) -> PeerId {
    PeerId::parse(&to_hex(&[n; 32])).unwrap()
}

fn stamp() -> impl Strategy<Value = Stamp> {
    (0i64..1000, 0u32..4, 0u8..4).prop_map(|(ms, l, p)| Stamp::new(Hlc::new(ms, l), peer(p)))
}

fn scalar() -> impl Strategy<Value = CellValue> {
    prop_oneof![
        Just(CellValue::Null),
        any::<bool>().prop_map(CellValue::Bool),
        (-50i32..50).prop_map(|n| CellValue::Number(n as f64)),
        "[a-c]{0,3}".prop_map(CellValue::Text),
        proptest::collection::vec(any::<u8>(), 0..3).prop_map(CellValue::Bytes),
        proptest::collection::btree_map(
            "[a-b]",
            (0i32..3).prop_map(|n| JsonValue::Number(n as f64)),
            0..3
        )
        .prop_map(CellValue::Object),
    ]
}

fn totals() -> impl Strategy<Value = JsonValue> {
    proptest::collection::btree_map(
        "[a-c]",
        (0u32..5).prop_map(|n| JsonValue::Number(n as f64)),
        0..3,
    )
    .prop_map(JsonValue::Object)
}

/// A counter cell in normal form.
fn counter_form() -> impl Strategy<Value = CellValue> {
    (totals(), totals()).prop_map(|(p, n)| {
        let mut o = BTreeMap::new();
        o.insert("p".to_owned(), p);
        o.insert("n".to_owned(), n);
        CellValue::Object(o)
    })
}

fn cell(value: impl Strategy<Value = CellValue>) -> impl Strategy<Value = Cell> {
    (value, stamp()).prop_map(|(value, stamp)| Cell { value, stamp })
}

fn laws(name: StrategyName, a: Cell, b: Cell, c: Cell) {
    let j = |x: Cell, y: Cell| join(name, x, Some(y));
    assert_eq!(
        j(a.clone(), b.clone()),
        j(b.clone(), a.clone()),
        "commutative"
    );
    assert_eq!(j(a.clone(), a.clone()), a, "idempotent");
    assert_eq!(
        j(j(a.clone(), b.clone()), c.clone()),
        j(a.clone(), j(b.clone(), c.clone())),
        "associative"
    );
}

proptest! {
    #[test]
    fn lww_max_min_are_lattices(a in cell(scalar()), b in cell(scalar()), c in cell(scalar())) {
        for name in [StrategyName::Lww, StrategyName::Max, StrategyName::Min] {
            laws(name, a.clone(), b.clone(), c.clone());
        }
    }

    #[test]
    fn counter_is_a_lattice_over_normal_forms(a in cell(counter_form()), b in cell(counter_form()), c in cell(counter_form())) {
        laws(StrategyName::Counter, a, b, c);
    }

    #[test]
    fn counter_increments_sum_in_any_order(deltas in proptest::collection::vec((-5i32..6, 0u8..3), 1..6)) {
        let cells: Vec<Cell> = deltas.iter().enumerate().map(|(i, (d, p))| {
            let mut o = BTreeMap::new();
            o.insert("+".to_owned(), JsonValue::Number(*d as f64));
            Cell { value: CellValue::Object(o), stamp: Stamp::new(Hlc::new(i as i64, 0), peer(*p)) }
        }).collect();
        let fold = |order: &[usize]| order.iter().fold(None, |held, &i| Some(join(StrategyName::Counter, cells[i].clone(), held))).unwrap();
        let forward: Vec<usize> = (0..cells.len()).collect();
        let backward: Vec<usize> = forward.iter().rev().copied().collect();
        let expected: f64 = deltas.iter().map(|(d, _)| *d as f64).sum();
        prop_assert_eq!(counter_value(&fold(&forward).value), expected);
        prop_assert_eq!(fold(&forward).value, fold(&backward).value);
    }

    #[test]
    fn the_fold_is_order_independent(
        steps in proptest::collection::vec((0u8..3, 0u8..3, 0u8..3, scalar()), 1..8),
        seed in 0u64..1000,
    ) {
        let changes: Vec<(Change, Stamp)> = steps.iter().enumerate().map(|(i, (kind, key, p, v))| {
            let key = format!("k{key}");
            let change = match kind {
                0 => Change::Insert { table: "t".into(), key, row: [("x".to_owned(), v.clone())].into_iter().collect() },
                1 => Change::Update { table: "t".into(), key, patch: [("y".to_owned(), v.clone())].into_iter().collect() },
                _ => Change::Delete { table: "t".into(), key },
            };
            // stamps are unique per event, as they are in a real log; the peer is free to repeat
            (change, Stamp::new(Hlc::new(i as i64 % 3, i as u32 / 3), peer(*p)))
        }).collect();
        let fold = |order: &[usize]| {
            let mut state = State::new();
            for &i in order {
                let (c, s) = &changes[i];
                apply_change(&mut state, c, s, None, None).unwrap();
            }
            state
        };
        let forward: Vec<usize> = (0..changes.len()).collect();
        // a deterministic shuffle from the seed, plus one replay of every step
        let mut shuffled = forward.clone();
        let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        for i in (1..shuffled.len()).rev() {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            shuffled.swap(i, (x >> 33) as usize % (i + 1));
        }
        let mut replayed = shuffled.clone();
        replayed.extend(forward.iter().copied());
        prop_assert_eq!(fold(&forward), fold(&shuffled));
        prop_assert_eq!(fold(&forward), fold(&replayed));
    }
}
