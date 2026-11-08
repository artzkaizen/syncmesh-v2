//! Convergence over the real wire — the property `engine/src/__tests__/convergence.test.ts` and
//! `counter-convergence.test.ts` hold the TypeScript to. Four devices each author a random run of
//! inserts, updates and deletes across a few tables, keys and partitions, with `max`, `min` and
//! `counter` columns beside the `lww` ones; then every author's entries reach every other device
//! as `[core, sig]` bytes, verified on arrival, in a random permutation and random batch splits.
//! Every device must end with the same rows and the same cursors.
//!
//! **The oracle is computed, never written down.** Beside agreeing with each other, the rows must
//! agree with an expectation derived from the writes as the engines actually stamped them — which
//! cell wins under each strategy, which rows are visible, what every counter sums to — so the
//! expectation moves when the merge rules do and cannot be wrong in the same direction as the code.
//!
//! One invariant the generator keeps rather than the fold: a row belongs to one partition. The
//! fold fixes a row's partition by the first write that reaches it, so two writes placing the same
//! row in two partitions would end differently on devices that saw them in a different order.
//! That is the policy ladder's job to refuse (no port yet), so here every key has one partition,
//! which some writes name and others leave out — `None` beside `Some` does converge.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use syncmesh_client::{Engine, EngineOptions, MemoryEventStore, StoredEvent};
use syncmesh_core::event::{Change, PartitionKey, PeerId};
use syncmesh_core::record::{CellValue, JsonValue, Row};
use syncmesh_core::stamp::Stamp;
use syncmesh_core::state::State;
use syncmesh_core::strategy::{MergeSpec, StrategyName, compare_value, counter_value};
use syncmesh_core::{Identity, decode_and_verify};

const AUTHORS: usize = 4;
const TABLES: [&str; 2] = ["notes", "stats"];
const KEYS: [&str; 3] = ["k1", "k2", "k3"];
/// The one partition each key lives in; `k3` lives in none.
const PARTITION_OF: [Option<&str>; 3] = [Some("org:a"), Some("org:b"), None];
/// A narrow window of wall-clock milliseconds, so stamps collide on the millisecond and the HLC's
/// logical counter and the peer-id tie-break are what order them.
const BASE_MS: i64 = 1_700_000_000_000;
const WINDOW_MS: i64 = 6;

/// `stats` has one column per strategy beside an `lww` one; `notes` is all `lww`.
fn merge_spec() -> MergeSpec {
    let mut stats = BTreeMap::new();
    stats.insert("high".to_owned(), StrategyName::Max);
    stats.insert("low".to_owned(), StrategyName::Min);
    stats.insert("views".to_owned(), StrategyName::Counter);
    let mut spec = MergeSpec::new();
    spec.insert("stats".to_owned(), stats);
    spec
}

fn strategy_of(table: &str, column: &str) -> StrategyName {
    merge_spec()
        .get(table)
        .and_then(|c| c.get(column).copied())
        .unwrap_or(StrategyName::Lww)
}

// --- generators ------------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Kind {
    Insert(Row),
    Update(Row),
    Delete,
}

#[derive(Debug, Clone)]
struct Op {
    author: usize,
    at_ms: i64,
    table: usize,
    key: usize,
    /// Whether the write names the key's partition; the partition itself is fixed per key.
    placed: bool,
    kind: Kind,
}

/// Numbers that survive the CBOR round trip exactly: safe integers and dyadic fractions.
fn number() -> impl Strategy<Value = f64> {
    prop_oneof![
        (-1000i64..1000).prop_map(|n| n as f64),
        (-64i32..64).prop_map(|n| f64::from(n) / 8.0),
    ]
}

fn json_leaf() -> impl Strategy<Value = JsonValue> {
    prop_oneof![
        Just(JsonValue::Null),
        any::<bool>().prop_map(JsonValue::Bool),
        number().prop_map(JsonValue::Number),
        "[a-zé ]{0,8}".prop_map(JsonValue::Text),
    ]
}

/// Text, numbers and nested objects and arrays, a couple of levels deep.
fn json_value() -> impl Strategy<Value = JsonValue> {
    json_leaf().prop_recursive(2, 8, 3, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..3).prop_map(JsonValue::Array),
            prop::collection::btree_map("[a-c]{1,2}", inner, 0..3).prop_map(JsonValue::Object),
        ]
    })
}

fn cell() -> impl Strategy<Value = CellValue> {
    json_value().prop_map(CellValue::from)
}

/// `{"+": n}` — the shape an increment travels in.
fn increment() -> impl Strategy<Value = CellValue> {
    (-5i64..=5).prop_map(|n| {
        let mut o = BTreeMap::new();
        o.insert("+".to_owned(), JsonValue::Number(n as f64));
        CellValue::Object(o)
    })
}

fn row_of(columns: Vec<(&'static str, Option<CellValue>)>) -> Row {
    columns
        .into_iter()
        .filter_map(|(c, v)| v.map(|v| (c.to_owned(), v)))
        .collect()
}

fn notes_row() -> BoxedStrategy<Row> {
    (prop::option::of(cell()), prop::option::of(cell()))
        .prop_map(|(title, meta)| row_of(vec![("title", title), ("meta", meta)]))
        .boxed()
}

fn stats_row() -> BoxedStrategy<Row> {
    (
        prop::option::of(cell()),
        prop::option::of(number().prop_map(CellValue::Number)),
        prop::option::of(number().prop_map(CellValue::Number)),
        prop::option::of(increment()),
    )
        .prop_map(|(title, high, low, views)| {
            row_of(vec![
                ("title", title),
                ("high", high),
                ("low", low),
                ("views", views),
            ])
        })
        .boxed()
}

fn op() -> impl Strategy<Value = Op> {
    (
        0..AUTHORS,
        0..TABLES.len(),
        0..KEYS.len(),
        any::<bool>(),
        0..WINDOW_MS,
    )
        .prop_flat_map(|(author, table, key, placed, at)| {
            let row = if table == 0 { notes_row() } else { stats_row() };
            let kind = prop_oneof![
                3 => row.clone().prop_map(Kind::Insert),
                4 => row.prop_map(Kind::Update),
                1 => Just(Kind::Delete),
            ];
            kind.prop_map(move |kind| Op {
                author,
                at_ms: BASE_MS + at,
                table,
                key,
                placed,
                kind,
            })
        })
}

/// Per receiving device: a permutation of every event, and where the batches split.
type Delivery = (Vec<usize>, Vec<bool>);

#[derive(Debug, Clone)]
struct Scenario {
    ops: Vec<Op>,
    deliveries: Vec<Delivery>,
}

fn scenario() -> impl Strategy<Value = Scenario> {
    prop::collection::vec(op(), 4..40).prop_flat_map(|ops| {
        let n = ops.len();
        let delivery = (
            Just((0..n).collect::<Vec<usize>>()).prop_shuffle(),
            prop::collection::vec(any::<bool>(), n),
        );
        (Just(ops), prop::collection::vec(delivery, AUTHORS))
            .prop_map(|(ops, deliveries)| Scenario { ops, deliveries })
    })
}

// --- the mesh --------------------------------------------------------------------------------

struct Device {
    engine: Engine,
    clock: Arc<AtomicI64>,
}

fn device(n: usize) -> Device {
    let clock = Arc::new(AtomicI64::new(BASE_MS));
    let reader = Arc::clone(&clock);
    let engine = Engine::open(
        Identity::from_seed(&[n as u8 + 1; 32]),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            merge: Some(merge_spec()),
            now_ms: Some(Box::new(move || reader.load(Ordering::Relaxed))),
            ..EngineOptions::default()
        },
    )
    .expect("a memory engine opens");
    Device { engine, clock }
}

fn mesh() -> Vec<Device> {
    (0..AUTHORS).map(device).collect()
}

/// Every op as its author's signed entry, in op order.
fn author(devices: &mut [Device], ops: &[Op]) -> Vec<StoredEvent> {
    ops.iter()
        .map(|op| {
            let d = &mut devices[op.author];
            d.clock.store(op.at_ms, Ordering::Relaxed);
            let (table, key) = (TABLES[op.table].to_owned(), KEYS[op.key].to_owned());
            let change = match &op.kind {
                Kind::Insert(row) => Change::Insert {
                    table,
                    key,
                    row: row.clone(),
                },
                Kind::Update(row) => Change::Update {
                    table,
                    key,
                    patch: row.clone(),
                },
                Kind::Delete => Change::Delete { table, key },
            };
            let partition = PARTITION_OF[op.key]
                .filter(|_| op.placed)
                .map(|p| PartitionKey::parse(p).expect("a fixed partition parses"));
            d.engine
                .mutate("test.write", vec![change], partition)
                .expect("a write with one change is a write")
                .entry
        })
        .collect()
}

/// The entry as the far side holds it: `[core, sig]` bytes, verified.
fn over_the_wire(entry: &StoredEvent) -> StoredEvent {
    let wire = entry
        .envelope()
        .expect("an authored entry carries its signature");
    StoredEvent::from_verified(decode_and_verify(&wire).expect("the author's bytes verify"))
}

/// Delivers `entries` in `order`, cutting a batch wherever `splits` says; each entry `copies`
/// times inside its batch. Returns how many the device folded.
fn deliver(
    device: &mut Device,
    entries: &[StoredEvent],
    (order, splits): &Delivery,
    copies: usize,
) -> usize {
    let mut batch = Vec::new();
    let mut folded = 0;
    for (i, &index) in order.iter().enumerate() {
        for _ in 0..copies {
            batch.push(over_the_wire(&entries[index]));
        }
        if splits[i] || i + 1 == order.len() {
            folded += device
                .engine
                .receive_batch(std::mem::take(&mut batch))
                .expect("a memory store never fails")
                .report
                .folded;
        }
    }
    folded
}

fn envelopes_by_id(entries: &[StoredEvent]) -> BTreeMap<String, Vec<u8>> {
    entries
        .iter()
        .map(|e| (e.id(), e.envelope().expect("signed")))
        .collect()
}

// --- the oracle ------------------------------------------------------------------------------

type At = (String, String);

#[derive(Default)]
struct History {
    cells: BTreeMap<At, BTreeMap<String, Vec<(CellValue, Stamp)>>>,
    writes: BTreeMap<At, Vec<Stamp>>,
    deletes: BTreeMap<At, Vec<Stamp>>,
}

/// Every write as the engine stamped it — not as the test scheduled it, since an HLC also jumps to
/// match stamps a device received, and the oracle measures the engine rather than re-deriving it.
fn history_of(entries: &[StoredEvent]) -> History {
    let mut h = History::default();
    for entry in entries {
        let stamp = entry.event.stamp();
        for change in &entry.event.changes {
            let at: At = (change.table().to_owned(), change.key().to_owned());
            match change {
                Change::Insert { row, .. } | Change::Update { patch: row, .. } => {
                    h.writes.entry(at.clone()).or_default().push(stamp.clone());
                    for (column, value) in row {
                        h.cells
                            .entry(at.clone())
                            .or_default()
                            .entry(column.clone())
                            .or_default()
                            .push((value.clone(), stamp.clone()));
                    }
                }
                Change::Delete { .. } => h.deletes.entry(at).or_default().push(stamp.clone()),
                Change::Unknown { .. } | Change::Doc(_) => {
                    unreachable!("the generator writes no unknown or doc changes")
                }
            }
        }
    }
    h
}

fn delta_of(value: &CellValue) -> f64 {
    match value.as_object().and_then(|o| o.get("+")) {
        Some(JsonValue::Number(n)) => *n,
        _ => 0.0,
    }
}

fn check_oracle(state: &State, entries: &[StoredEvent]) -> Result<(), TestCaseError> {
    let h = history_of(entries);
    let touched: std::collections::BTreeSet<&At> =
        h.writes.keys().chain(h.deletes.keys()).collect();
    for at in touched {
        let record = state
            .record(&at.0, &at.1)
            .ok_or_else(|| TestCaseError::fail(format!("no record for {at:?}")))?;
        let last_write = h.writes.get(at).and_then(|s| s.iter().max());
        let last_delete = h.deletes.get(at).and_then(|s| s.iter().max());
        prop_assert_eq!(record.write_stamp.as_ref(), last_write, "{:?}", at);
        prop_assert_eq!(record.delete_stamp.as_ref(), last_delete, "{:?}", at);
        let visible = match (last_write, last_delete) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some(w), Some(d)) => w > d,
        };
        prop_assert_eq!(record.is_visible(), visible, "{:?}", at);
        prop_assert_eq!(
            record.partition.as_deref(),
            PARTITION_OF[KEYS.iter().position(|k| *k == at.1).expect("a known key")].filter(|_| {
                entries.iter().any(|e| {
                    e.event.partition.is_some()
                        && e.event
                            .changes
                            .iter()
                            .any(|c| c.table() == at.0 && c.key() == at.1)
                })
            }),
            "{:?}",
            at
        );
    }
    for (at, columns) in &h.cells {
        let record = state.record(&at.0, &at.1).expect("checked above");
        for (column, writes) in columns {
            let held = record
                .cells
                .get(column)
                .ok_or_else(|| TestCaseError::fail(format!("no cell {at:?}.{column}")))?;
            match strategy_of(&at.0, column) {
                StrategyName::Lww => {
                    let (value, stamp) = writes.iter().max_by_key(|(_, s)| s).expect("written");
                    prop_assert_eq!(&held.value, value, "lww {:?}.{}", at, column);
                    prop_assert_eq!(&held.stamp, stamp, "lww {:?}.{}", at, column);
                }
                StrategyName::Max => {
                    let (value, stamp) = writes
                        .iter()
                        .max_by(|a, b| compare_value(&a.0, &b.0).then_with(|| a.1.cmp(&b.1)))
                        .expect("written");
                    prop_assert_eq!(&held.value, value, "max {:?}.{}", at, column);
                    prop_assert_eq!(&held.stamp, stamp, "max {:?}.{}", at, column);
                }
                StrategyName::Lineage => unreachable!("no generated column is a document"),
                StrategyName::Min => {
                    // the smallest value; among equal values the newer stamp
                    let (value, stamp) = writes
                        .iter()
                        .min_by(|a, b| compare_value(&a.0, &b.0).then_with(|| b.1.cmp(&a.1)))
                        .expect("written");
                    prop_assert_eq!(&held.value, value, "min {:?}.{}", at, column);
                    prop_assert_eq!(&held.stamp, stamp, "min {:?}.{}", at, column);
                }
                StrategyName::Counter => {
                    let sum: f64 = writes.iter().map(|(v, _)| delta_of(v)).sum();
                    let read = counter_value(&held.value);
                    prop_assert!(
                        (read - sum).abs() < 1e-9,
                        "counter {:?}.{} reads {} for increments summing to {}",
                        at,
                        column,
                        read,
                        sum
                    );
                    prop_assert_eq!(
                        &held.stamp,
                        writes.iter().map(|(_, s)| s).max().expect("written")
                    );
                }
            }
        }
    }
    Ok(())
}

fn check_converged(devices: &[Device], entries: &[StoredEvent]) -> Result<(), TestCaseError> {
    let reference = &devices[0];
    let mut counts: BTreeMap<PeerId, u64> = BTreeMap::new();
    for e in entries {
        *counts.entry(e.event.peer_id.clone()).or_default() += 1;
    }
    let originals = envelopes_by_id(entries);
    for (i, d) in devices.iter().enumerate() {
        prop_assert_eq!(
            d.engine.state(),
            reference.engine.state(),
            "device {} state",
            i
        );
        prop_assert_eq!(
            d.engine.cursors(),
            reference.engine.cursors(),
            "device {} cursors",
            i
        );
        prop_assert!(d.engine.ahead().is_empty(), "device {} has a gap", i);
        prop_assert!(d.engine.quarantine().is_empty());
        // every author's cursor sits at that author's count: nothing missing, nothing extra
        for (peer, n) in &counts {
            prop_assert_eq!(d.engine.cursors().get(peer).map(|s| s.get()), Some(*n));
        }
        // and every device holds every event as the exact bytes its author signed
        let held = d.engine.all_events().expect("memory");
        prop_assert_eq!(held.len(), entries.len(), "device {} log", i);
        for e in &held {
            let wire = e.envelope();
            prop_assert_eq!(wire.as_ref(), originals.get(&e.id()), "device {} bytes", i);
        }
    }
    check_oracle(reference.engine.state(), entries)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 128, ..ProptestConfig::default() })]

    #[test]
    fn every_permutation_and_batching_of_the_same_events_converges(s in scenario()) {
        let mut devices = mesh();
        let entries = author(&mut devices, &s.ops);
        for (i, delivery) in s.deliveries.iter().enumerate() {
            let foreign = entries.iter().filter(|e| e.event.peer_id != *devices[i].engine.peer_id()).count();
            let folded = deliver(&mut devices[i], &entries, delivery, 1);
            prop_assert_eq!(folded, foreign, "device {} folded", i);
        }
        check_converged(&devices, &entries)?;
    }

    #[test]
    fn duplicate_delivery_and_redelivery_change_nothing(s in scenario()) {
        let mut devices = mesh();
        let entries = author(&mut devices, &s.ops);
        // every entry twice inside its batch
        for (i, delivery) in s.deliveries.iter().enumerate() {
            deliver(&mut devices[i], &entries, delivery, 2);
        }
        check_converged(&devices, &entries)?;
        let states: Vec<State> = devices.iter().map(|d| d.engine.state().clone()).collect();
        let cursors: Vec<_> = devices.iter().map(|d| d.engine.cursors()).collect();

        // the whole log again, in another device's order, and each author's own writes back at it
        for (i, d) in devices.iter_mut().enumerate() {
            let again = &s.deliveries[(i + 1) % AUTHORS];
            prop_assert_eq!(deliver(d, &entries, again, 1), 0, "device {} refolded", i);
            let own: Vec<StoredEvent> = entries
                .iter()
                .filter(|e| e.event.peer_id == *d.engine.peer_id())
                .map(over_the_wire)
                .collect();
            let received = d.engine.receive_batch(own.clone()).expect("memory");
            prop_assert_eq!(received.report.folded, 0);
            prop_assert_eq!(received.report.skipped, own.len());
        }
        for (i, d) in devices.iter().enumerate() {
            prop_assert_eq!(d.engine.state(), &states[i], "device {} state moved", i);
            prop_assert_eq!(d.engine.cursors(), cursors[i].clone(), "device {} cursors moved", i);
            prop_assert_eq!(d.engine.all_events().expect("memory").len(), entries.len());
        }
    }
}
