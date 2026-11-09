//! The join exchange against `conformance/snapshot-vectors.json` (gap U31): a Rust holder of the
//! same events serves the TypeScript's frames byte for byte — a row whose cells were first written
//! out of column order (U34) and a holder with a `local` table (U36) included — and a Rust joiner
//! taking the TypeScript's frames under each policy sends the same acks, adopts the same coverage
//! and keeps the same floor in its log (U37).

use std::path::PathBuf;

use serde_json::{Value, json};
use syncmesh_client::Interest;
use syncmesh_client::{
    Cursors, Engine, EngineOptions, JoinExchange, JoinOptions, JoinOutcome, JoinPolicy, Manifest,
    MemoryEventStore, MemoryStateStore, StoredEvent, ValidatorOptions,
};
use syncmesh_core::doc::DocColumns;
use syncmesh_core::envelope::decode_and_verify;
use syncmesh_core::event::{Change, PartitionKey, PeerId, SeqNum};
use syncmesh_core::frames::{Frame, SnapshotFrame, decode_frame};
use syncmesh_core::hex::{from_hex, to_hex};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::{CellValue, Row};

const NOW_MS: i64 = 1_700_000_000_000;

fn vectors() -> Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "snapshot-vectors.json",
    ]
    .iter()
    .collect();
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("json")
}

/// The generator's seeds: `(start + i * 7) % 256`.
fn identity(start: u32) -> Identity {
    let seed: Vec<u8> = (0..32u32).map(|i| ((start + i * 7) % 256) as u8).collect();
    Identity::from_seed(&seed.try_into().expect("32 bytes"))
}

fn engine(identity: Identity, docs: Option<DocColumns>) -> Engine {
    Engine::open(
        identity,
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            docs,
            now_ms: Some(Box::new(|| NOW_MS)),
            ..EngineOptions::default()
        },
    )
    .expect("engine")
}

/// The joiner: its rows in a state store, so an install records its floor in the log (U37).
fn joiner(docs: Option<DocColumns>) -> Engine {
    Engine::open(
        identity(5),
        Box::new(MemoryEventStore::new()),
        Some(Box::new(MemoryStateStore::new())),
        EngineOptions {
            docs,
            now_ms: Some(Box::new(|| NOW_MS)),
            ..EngineOptions::default()
        },
    )
    .expect("engine")
}

fn bytes(hex: &Value) -> Vec<u8> {
    from_hex(hex.as_str().expect("hex")).expect("hex")
}

fn snapshot(hex: &Value) -> SnapshotFrame {
    match decode_frame(&bytes(hex)).expect("frame") {
        Frame::Snapshot(f) => f,
        other => panic!("not a snapshot frame: {}", other.kind()),
    }
}

/// The `local` holder (U36): the vectors' schema as its validator's manifest, and the draft it
/// wrote to its `local` table once it had folded the events.
fn drafting_holder(doc: &Value) -> Engine {
    let manifest = Manifest::from_json(&doc["localSchema"]).expect("the portable manifest reads");
    let mut holder = Engine::open(
        identity(3),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            now_ms: Some(Box::new(|| NOW_MS)),
            validator: Some(ValidatorOptions::new(manifest)),
            ..EngineOptions::default()
        },
    )
    .expect("engine");
    fold(&mut holder, doc, "events");
    let draft = doc["draft"].as_object().expect("draft");
    let row: Row = draft
        .iter()
        .map(|(column, value)| (column.clone(), CellValue::text(value.as_str().unwrap())))
        .collect();
    holder
        .mutate_local(
            "drafts.create",
            vec![Change::Insert {
                table: "drafts".into(),
                key: draft["id"].as_str().unwrap().into(),
                row,
            }],
            None,
        )
        .expect("a local table takes a local write");
    holder
}

fn fold(holder: &mut Engine, doc: &Value, events: &str) {
    let entries: Vec<StoredEvent> = doc[events]
        .as_array()
        .expect("events")
        .iter()
        .map(|hex| StoredEvent::from_verified(decode_and_verify(&bytes(hex)).expect("verifies")))
        .collect();
    let count = entries.len();
    let report = holder.receive_batch(entries).expect("folds");
    assert_eq!(
        report.report.folded, count,
        "{events}: the holder folds every event"
    );
}

fn holder(doc: &Value, events: &str) -> Engine {
    let mut holder = engine(identity(3), None);
    assert_eq!(holder.peer_id().as_str(), doc["holder"].as_str().unwrap());
    fold(&mut holder, doc, events);
    holder
}

fn pairs(cursors: &Cursors) -> Value {
    Value::Array(
        cursors
            .iter()
            .map(|(peer, seq)| json!([peer.as_str(), seq.get()]))
            .collect(),
    )
}

#[test]
fn a_rust_holder_serves_the_typescripts_frames_byte_for_byte() {
    let doc = vectors();
    let mut holders = [
        holder(&doc, "events"),
        // U34: a row whose cells were first written out of column order is the same bytes
        holder(&doc, "unsortedEvents"),
        // U36: a holder that wrote a `local` table serves the frames of one that never did
        drafting_holder(&doc),
    ];
    assert!(holders[2].state().read_row("drafts", "d1").is_some());
    let acme = Interest::partitions([PartitionKey::parse("org:acme").unwrap()]);
    let windowed = acme.clone().windowed(1);
    for (name, which, interest) in [
        ("everything", 0, None),
        ("acme", 0, Some(&acme)),
        ("windowed", 0, Some(&windowed)),
        ("certified", 0, None),
        ("unsorted", 1, None),
        ("local", 2, None),
    ] {
        let holder = &mut holders[which];
        let served = &doc["served"][name];
        let mut options = JoinOptions::new("holder");
        options.rows_per_chunk = doc["rowsPerChunk"].as_u64().unwrap() as usize;
        // the certificate is the authority's, relayed: take the one the TypeScript holder relayed
        if let SnapshotFrame::Manifest { certificate, .. } = snapshot(&served["frames"][0]) {
            options.certificate = certificate;
        }
        let mut exchange = JoinExchange::new(options);
        let (_, request) = JoinExchange::new(JoinOptions::new("x")).request(interest, false);
        assert_eq!(
            to_hex(&request),
            served["request"].as_str().unwrap(),
            "{name}: request"
        );
        let step = exchange
            .dispatch(holder, snapshot(&served["request"]))
            .unwrap();
        let sent: Vec<String> = step.send.iter().map(|b| to_hex(b)).collect();
        let want: Vec<&str> = served["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(sent, want, "{name}: served frames");
    }
}

#[test]
fn a_rust_joiner_reaches_the_typescripts_coverage_under_every_policy() {
    let doc = vectors();
    let docs: DocColumns = serde_json::from_value::<
        std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
    >(doc["docs"].clone())
    .unwrap();
    let issuer = PeerId::parse(doc["issuer"].as_str().unwrap()).unwrap();
    assert_eq!(identity(9).peer_id(), &issuer);
    let joins = doc["joins"].as_array().expect("joins");
    assert_eq!(joins.len(), 14);
    for case in joins {
        let what = case["description"].as_str().unwrap();
        let mut joiner = joiner((case["docs"] == json!(true)).then(|| docs.clone()));
        assert_eq!(joiner.peer_id().as_str(), doc["joiner"].as_str().unwrap());
        let mut options = JoinOptions::new("joiner");
        if case["trust"] == json!(true) {
            options.trust = Some(issuer.clone());
        }
        let mut exchange = JoinExchange::new(options);
        let mut ticket = None;
        if let Some(policy) = case.get("policy") {
            let floor = policy.get("floor").map(|f| {
                f.as_array()
                    .unwrap()
                    .iter()
                    .map(|p| {
                        (
                            PeerId::parse(p[0].as_str().unwrap()).unwrap(),
                            SeqNum::parse(p[1].as_u64().unwrap()).unwrap(),
                        )
                    })
                    .collect::<Cursors>()
            });
            let policy = JoinPolicy {
                adopt_unvouched: policy["adoptUnvouched"].as_bool().unwrap(),
                floor,
            };
            let (t, request) = exchange.request_under(None, policy);
            ticket = Some(t);
            assert_eq!(
                to_hex(&request),
                case["request"].as_str().unwrap(),
                "{what}: request"
            );
        }
        let dropped: Vec<u64> = case
            .get("drop")
            .map(|d| {
                d.as_array()
                    .unwrap()
                    .iter()
                    .map(|i| i.as_u64().unwrap())
                    .collect()
            })
            .unwrap_or_default();
        let frames = doc["served"][case["served"].as_str().unwrap()]["frames"]
            .as_array()
            .unwrap();
        let mut sent = Vec::new();
        let mut settled = Vec::new();
        let mut later = Vec::new();
        for hex in frames {
            let frame = snapshot(hex);
            if let SnapshotFrame::Chunk { index, .. } = &frame
                && dropped.contains(index)
            {
                later.push(frame);
                continue;
            }
            let step = exchange.dispatch(&mut joiner, frame).unwrap();
            sent.extend(step.send);
            settled.extend(step.settled);
        }
        for frame in later {
            let step = exchange.dispatch(&mut joiner, frame).unwrap();
            sent.extend(step.send);
            settled.extend(step.settled);
        }
        let sent: Vec<Value> = sent.iter().map(|b| json!(to_hex(b))).collect();
        assert_eq!(Value::Array(sent), case["sent"], "{what}: sent");
        let coverage = joiner.coverage();
        assert_eq!(pairs(&coverage.synced), case["synced"], "{what}: synced");
        assert_eq!(pairs(&coverage.floor), case["floor"], "{what}: floor");
        assert_eq!(
            pairs(&joiner.installed_below().unwrap()),
            case["installed"],
            "{what}: the floor the log keeps"
        );
        assert_eq!(json!(coverage.scope), case["scope"], "{what}: scope");
        let rows: Vec<Value> = joiner
            .state()
            .tables
            .get("notes")
            .map(|t| t.keys().map(|k| json!(k)).collect())
            .unwrap_or_default();
        assert_eq!(Value::Array(rows), case["rows"], "{what}: rows");
        let got = match settled.first() {
            None => Value::Null,
            Some(s) => {
                assert_eq!(Some(s.ticket), ticket, "{what}: the ticket it answered");
                match &s.outcome {
                    JoinOutcome::Installed { installed, vouched } => {
                        json!({ "kind": "installed", "rows": installed.rows, "vouched": vouched })
                    }
                    JoinOutcome::Refused(_) => json!({ "kind": "refused" }),
                }
            }
        };
        assert_eq!(got, case["settled"], "{what}: settled");
    }
}
