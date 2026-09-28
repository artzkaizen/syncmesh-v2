//! How a column merges when two devices wrote it while apart (D25): `lww`, `max`, `min`, `counter`.
//! All four are lattice joins — commutative, associative and idempotent over their normal forms.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::cbor::cmp_utf16;
use crate::record::{Cell, CellValue, JsonValue, canonical_json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StrategyName {
    Lww,
    Max,
    Min,
    Counter,
    /// A doc column's lineage cell (RFC-0023 §5.3). Put there by `doc::with_doc_columns`, never
    /// declared by an app, so `parse` does not know its name.
    Lineage,
}

impl StrategyName {
    pub fn parse(name: &str) -> Option<StrategyName> {
        Some(match name {
            "lww" => StrategyName::Lww,
            "max" => StrategyName::Max,
            "min" => StrategyName::Min,
            "counter" => StrategyName::Counter,
            _ => return None,
        })
    }
}

/// table → column → strategy; anything not named is `lww`.
pub type MergeSpec = BTreeMap<String, BTreeMap<String, StrategyName>>;

fn rank(v: &CellValue) -> u8 {
    match v {
        CellValue::Null => 0,
        CellValue::Bool(_) => 1,
        CellValue::Number(_) => 2,
        CellValue::Text(_) => 3,
        CellValue::Bytes(_) => 4,
        CellValue::Array(_) | CellValue::Object(_) => 5,
    }
}

/// Total order on cell values: null < booleans < numbers < strings < bytes < JSON containers, each by
/// its natural order, containers by their canonical text. Total on every value and never failing.
pub fn compare_value(a: &CellValue, b: &CellValue) -> Ordering {
    let by_kind = rank(a).cmp(&rank(b));
    if by_kind != Ordering::Equal {
        return by_kind;
    }
    match (a, b) {
        (CellValue::Null, CellValue::Null) => Ordering::Equal,
        (CellValue::Bool(x), CellValue::Bool(y)) => x.cmp(y),
        (CellValue::Number(x), CellValue::Number(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (CellValue::Text(x), CellValue::Text(y)) => cmp_utf16(x, y),
        (CellValue::Bytes(x), CellValue::Bytes(y)) => x.cmp(y),
        _ => {
            let (x, y) = (
                a.as_json().expect("rank 5 is json"),
                b.as_json().expect("rank 5 is json"),
            );
            cmp_utf16(&canonical_json(&x), &canonical_json(&y))
        }
    }
}

fn lww(incoming: Cell, current: Option<Cell>) -> Cell {
    match current {
        Some(current) if incoming.stamp <= current.stamp => current,
        _ => incoming,
    }
}

fn by_value(sign: Ordering, incoming: Cell, current: Option<Cell>) -> Cell {
    let Some(current) = current else {
        return incoming;
    };
    let order = compare_value(&incoming.value, &current.value);
    if order == sign {
        incoming
    } else if order == Ordering::Equal {
        lww(incoming, Some(current))
    } else {
        current
    }
}

type AuthorTotals = BTreeMap<String, f64>;

fn totals_of(v: Option<&JsonValue>) -> AuthorTotals {
    match v {
        Some(JsonValue::Object(o)) => o
            .iter()
            .filter_map(|(k, v)| match v {
                JsonValue::Number(n) => Some((k.clone(), *n)),
                _ => None,
            })
            .collect(),
        _ => AuthorTotals::new(),
    }
}

/// Per-author running totals up (`p`) and down (`n`); anything not in normal form reads as empty.
fn contributions_of(value: &CellValue) -> (AuthorTotals, AuthorTotals) {
    match value.as_object() {
        Some(o) => (totals_of(o.get("p")), totals_of(o.get("n"))),
        None => (AuthorTotals::new(), AuthorTotals::new()),
    }
}

/// `{"+": n}` — the shape an increment travels in; anything else is normal form.
fn delta_of(value: &CellValue) -> Option<f64> {
    match value.as_object()?.get("+")? {
        JsonValue::Number(n) => Some(*n),
        _ => None,
    }
}

fn join_totals(mut a: AuthorTotals, b: AuthorTotals) -> AuthorTotals {
    for (author, total) in b {
        let held = a.entry(author).or_insert(0.0);
        *held = held.max(total);
    }
    a
}

fn totals_json(t: AuthorTotals) -> JsonValue {
    JsonValue::Object(
        t.into_iter()
            .map(|(k, v)| (k, JsonValue::Number(v)))
            .collect(),
    )
}

fn normal_form(p: AuthorTotals, n: AuthorTotals) -> CellValue {
    let mut o = BTreeMap::new();
    o.insert("p".to_owned(), totals_json(p));
    o.insert("n".to_owned(), totals_json(n));
    CellValue::Object(o)
}

/// A PN-counter per cell: an increment adds to its author's total; a cell in normal form joins by per-author max.
fn counter(incoming: Cell, current: Option<Cell>) -> Cell {
    let (held_p, held_n) = match &current {
        Some(c) => contributions_of(&c.value),
        None => (AuthorTotals::new(), AuthorTotals::new()),
    };
    let stamp = match &current {
        Some(c) if incoming.stamp <= c.stamp => c.stamp.clone(),
        _ => incoming.stamp.clone(),
    };
    if let Some(delta) = delta_of(&incoming.value) {
        let author = incoming.stamp.peer.as_str().to_owned();
        let (mut p, mut n) = (held_p, held_n);
        let side = if delta >= 0.0 { &mut p } else { &mut n };
        *side.entry(author).or_insert(0.0) += delta.abs();
        return Cell {
            value: normal_form(p, n),
            stamp,
        };
    }
    let (arrived_p, arrived_n) = contributions_of(&incoming.value);
    Cell {
        value: normal_form(
            join_totals(held_p, arrived_p),
            join_totals(held_n, arrived_n),
        ),
        stamp,
    }
}

/// What a `counter` cell reads as: every author's ups minus every author's downs.
pub fn counter_value(value: &CellValue) -> f64 {
    let (p, n) = contributions_of(value);
    p.values().sum::<f64>() - n.values().sum::<f64>()
}

/// The join for one column: `lww` picks the newer stamp; `max`/`min` pick by value and fall back to
/// the stamp on an exact tie; `counter` accumulates.
pub fn join(strategy: StrategyName, incoming: Cell, current: Option<Cell>) -> Cell {
    match strategy {
        StrategyName::Lww => lww(incoming, current),
        StrategyName::Max => by_value(Ordering::Greater, incoming, current),
        StrategyName::Min => by_value(Ordering::Less, incoming, current),
        StrategyName::Counter => counter(incoming, current),
        StrategyName::Lineage => crate::doc::lineage_rule(incoming, current),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::PeerId;
    use crate::hlc::Hlc;
    use crate::stamp::Stamp;

    fn peer(c: char) -> PeerId {
        PeerId::parse(&c.to_string().repeat(64)).unwrap()
    }

    fn cell(v: CellValue, ms: i64, p: char) -> Cell {
        Cell {
            value: v,
            stamp: Stamp::new(Hlc::new(ms, 0), peer(p)),
        }
    }

    fn inc(n: f64) -> CellValue {
        let mut o = BTreeMap::new();
        o.insert("+".to_owned(), JsonValue::Number(n));
        CellValue::Object(o)
    }

    #[test]
    fn value_order_is_total_across_kinds() {
        let order = [
            CellValue::Null,
            CellValue::Bool(false),
            CellValue::Bool(true),
            CellValue::Number(-1.0),
            CellValue::Number(2.5),
            CellValue::text("a"),
            CellValue::text("b"),
            CellValue::Bytes(vec![1]),
            CellValue::Bytes(vec![1, 0]),
            CellValue::Array(vec![]),
            CellValue::Object(BTreeMap::new()),
        ];
        for w in order.windows(2) {
            assert_eq!(
                compare_value(&w[0], &w[1]),
                Ordering::Less,
                "{:?} < {:?}",
                w[0],
                w[1]
            );
        }
    }

    #[test]
    fn max_and_min_fall_back_to_the_stamp_on_a_tie() {
        let a = cell(CellValue::Number(3.0), 10, 'a');
        let b = cell(CellValue::Number(3.0), 20, 'b');
        assert_eq!(join(StrategyName::Max, a.clone(), Some(b.clone())), b);
        assert_eq!(join(StrategyName::Min, b.clone(), Some(a.clone())), b);
        let small = cell(CellValue::Number(1.0), 99, 'c');
        assert_eq!(join(StrategyName::Max, small.clone(), Some(a.clone())), a);
        assert_eq!(join(StrategyName::Min, small.clone(), Some(a)), small);
    }

    #[test]
    fn counter_accumulates_increments_and_joins_normal_forms_by_max() {
        let one = join(StrategyName::Counter, cell(inc(3.0), 1, 'a'), None);
        let two = join(
            StrategyName::Counter,
            cell(inc(-1.0), 2, 'b'),
            Some(one.clone()),
        );
        assert_eq!(counter_value(&two.value), 2.0);
        // the same author's normal form arriving twice does not double
        let again = join(StrategyName::Counter, two.clone(), Some(two.clone()));
        assert_eq!(counter_value(&again.value), 2.0);
        // an increment landing on nothing reads as itself
        assert_eq!(counter_value(&one.value), 3.0);
        // garbage in normal-form position reads as the empty counter
        assert_eq!(counter_value(&CellValue::text("x")), 0.0);
    }
}
