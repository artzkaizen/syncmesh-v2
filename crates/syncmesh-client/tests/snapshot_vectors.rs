//! The join exchange against `conformance/snapshot-vectors.json` (gap U31): a Rust holder of the
//! same events serves the TypeScript's frames byte for byte, and a Rust joiner taking the
//! TypeScript's frames under each policy sends the same acks and adopts the same coverage.

use std::path::PathBuf;

use serde_json::{Value, json};
use syncmesh_client::Interest;
use syncmesh_client::{
    Cursors, Engine, EngineOptions, JoinExchange, JoinOptions, JoinOutcome, JoinPolicy,
    MemoryEventStore, StoredEvent,
};
use syncmesh_core::doc::DocColumns;
use syncmesh_core::envelope::decode_and_verify;
use syncmesh_core::event::{PartitionKey, PeerId, SeqNum};
use syncmesh_core::frames::{Frame, SnapshotFrame, decode_frame};
use syncmesh_core::hex::{from_hex, to_hex};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::RowRecord;
use syncmesh_core::snapshot_codec::{SnapshotRow, decode_snapshot_rows, encode_snapshot_rows};

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

fn bytes(hex: &Value) -> Vec<u8> {
    from_hex(hex.as_str().expect("hex")).expect("hex")
}

fn snapshot(hex: &Value) -> SnapshotFrame {
    match decode_frame(&bytes(hex)).expect("frame") {
        Frame::Snapshot(f) => f,
        other => panic!("not a snapshot frame: {}", other.kind()),
    }
}

fn holder(doc: &Value, events: &str) -> Engine {
    let mut holder = engine(identity(3), None);
    assert_eq!(holder.peer_id().as_str(), doc["holder"].as_str().unwrap());
    let entries = doc[events]
        .as_array()
        .expect("events")
        .iter()
        .map(|hex| StoredEvent::from_verified(decode_and_verify(&bytes(hex)).expect("verifies")))
        .collect();
    holder.receive_batch(entries).expect("folds");
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
    let mut holder = holder(&doc, "events");
    let acme = Interest::partitions([PartitionKey::parse("org:acme").unwrap()]);
    for (name, interest) in [
        ("everything", None),
        ("acme", Some(&acme)),
        ("certified", None),
    ] {
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
            .dispatch(&mut holder, snapshot(&served["request"]))
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

/// Serves `served` from `holder` with the certificate the TypeScript holder relayed, as frames.
fn serve(holder: &mut Engine, doc: &Value, served: &Value) -> Vec<SnapshotFrame> {
    let mut options = JoinOptions::new("holder");
    options.rows_per_chunk = doc["rowsPerChunk"].as_u64().unwrap() as usize;
    if let SnapshotFrame::Manifest { certificate, .. } = snapshot(&served["frames"][0]) {
        options.certificate = certificate;
    }
    let step = JoinExchange::new(options)
        .dispatch(holder, snapshot(&served["request"]))
        .unwrap();
    step.send
        .iter()
        .map(|b| match decode_frame(b).expect("frame") {
            Frame::Snapshot(f) => f,
            other => panic!("not a snapshot frame: {}", other.kind()),
        })
        .collect()
}

/// The rows of every chunk, decoded.
fn chunk_rows(frames: &[SnapshotFrame]) -> Vec<SnapshotRow> {
    frames
        .iter()
        .filter_map(|frame| match frame {
            SnapshotFrame::Chunk { bytes, .. } => Some(decode_snapshot_rows(bytes).expect("rows")),
            _ => None,
        })
        .flatten()
        .collect()
}

/// U34: a Rust holder keeps a row's cells in column order, not the order they were first
/// written, so it serves the same rows as the TypeScript but not the same bytes, and a relayed
/// certificate over cells written out of column order does not vouch for its page.
#[test]
fn a_rust_holder_of_cells_written_out_of_column_order_serves_them_sorted() {
    let doc = vectors();
    let served = &doc["served"]["unsorted"];
    let mut rust = holder(&doc, "unsortedEvents");
    let frames = serve(&mut rust, &doc, served);
    let typescript: Vec<SnapshotFrame> = served["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(snapshot)
        .collect();
    let (ours, theirs) = (chunk_rows(&frames), chunk_rows(&typescript));
    let records = |rows: &[SnapshotRow]| -> Vec<(String, String, RowRecord)> {
        rows.iter()
            .map(|r| (r.table.clone(), r.key.clone(), r.record.clone()))
            .collect()
    };
    assert_eq!(records(&ours), records(&theirs), "the same rows");
    assert_eq!(
        theirs[0].columns,
        ["id", "title", "body"],
        "first-written order"
    );
    assert_eq!(
        encode_snapshot_rows(&ours),
        encode_snapshot_rows(&{
            let mut sorted = theirs.clone();
            sorted[0].columns.clear();
            sorted
        }),
        "the Rust page is the TypeScript's with its cells in column order",
    );
    // a trusting joiner of the Rust page installs it, with nothing vouched
    let issuer = PeerId::parse(doc["issuer"].as_str().unwrap()).unwrap();
    let mut options = JoinOptions::new("joiner");
    options.trust = Some(issuer);
    let mut exchange = JoinExchange::new(options);
    let mut joiner = engine(identity(5), None);
    exchange.request_under(
        None,
        JoinPolicy {
            adopt_unvouched: false,
            floor: None,
        },
    );
    let mut settled = Vec::new();
    for frame in frames {
        settled.extend(exchange.dispatch(&mut joiner, frame).unwrap().settled);
    }
    match &settled[..] {
        [s] => match &s.outcome {
            JoinOutcome::Installed { vouched, installed } => {
                assert!(
                    !vouched,
                    "the certificate hashes the cells in first-written order"
                );
                assert_eq!(installed.rows, 1);
            }
            JoinOutcome::Refused(r) => panic!("refused: {r:?}"),
        },
        other => panic!("settled {} times", other.len()),
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
    assert_eq!(joins.len(), 11);
    for case in joins {
        let what = case["description"].as_str().unwrap();
        let mut joiner = engine(
            identity(5),
            (case["docs"] == json!(true)).then(|| docs.clone()),
        );
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
