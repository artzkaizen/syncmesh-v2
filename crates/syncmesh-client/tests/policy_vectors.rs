//! The shared validator against `conformance/policy-vectors.json` (gap U3): the manifest the
//! TypeScript wrote with `portableSchema`, the grants it issued, and every batch it handed one
//! device. This runtime must fold what the TypeScript folded, park what it parked — in the same
//! bucket, under the same verdict tag, rung and operation, in the same order — end on the same
//! rows, and reach the same verdict on every probe.

use std::path::PathBuf;

use serde_json::{Value, json};
use syncmesh_client::{
    Engine, EngineOptions, GrantRegistry, Manifest, MemoryEventStore, Parked, PolicySource,
    Principal, Probe, StoredEvent, ValidationClock, ValidationError, ValidatorOptions,
};
use syncmesh_core::envelope::decode_and_verify;
use syncmesh_core::event::{PartitionKey, PeerId};
use syncmesh_core::hex::from_hex;
use syncmesh_core::identity::Identity;
use syncmesh_core::record::{CellValue, JsonValue, Row};

fn vectors() -> Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "policy-vectors.json",
    ]
    .iter()
    .collect();
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("json")
}

fn peer(v: &Value) -> PeerId {
    PeerId::parse(v.as_str().expect("peer")).expect("peer id")
}

fn bytes(v: &Value) -> Vec<u8> {
    from_hex(v.as_str().expect("hex")).expect("hex")
}

fn entry(v: &Value) -> StoredEvent {
    StoredEvent::from_verified(decode_and_verify(&bytes(v)).expect("a vector event verifies"))
}

/// The receiving device: the TypeScript's seed, clock and drift bound, and the manifest as data.
fn device(doc: &Value, mesh: &Value) -> Engine {
    let manifest = Manifest::from_json(&doc["schema"]).expect("the portable manifest reads");
    let now = doc["nowMs"].as_i64().expect("now");
    let mut registry = GrantRegistry::new(peer(&doc["issuer"]));
    for wire in doc["grants"].as_array().expect("grants") {
        registry
            .register(&bytes(wire), now)
            .expect("a vector grant verifies");
    }
    let granted = mesh["granted"].as_bool().expect("granted");
    let seed: [u8; 32] = std::array::from_fn(|i| 65 + i as u8);
    let device = Identity::from_seed(&seed);
    assert_eq!(device.peer_id(), &peer(&doc["device"]));
    Engine::open(
        device,
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            now_ms: Some(Box::new(move || now)),
            max_drift_ms: doc["maxDriftMs"].as_i64(),
            validator: Some(ValidatorOptions {
                manifest,
                grants: granted.then(|| Box::new(registry) as _),
                authority: Some(peer(&doc["authority"])),
                accounts: mesh["accounts"].as_bool().expect("accounts"),
                checks: Default::default(),
            }),
            ..EngineOptions::default()
        },
    )
    .expect("open")
}

/// A verdict as the vectors write it: its tag, and the rung or operation it names.
fn verdict(error: &ValidationError) -> Value {
    let mut out = json!({ "verdict": error.tag() });
    if let Some(rung) = error.rung() {
        out["rung"] = json!(rung);
    }
    if let ValidationError::PolicyDenied { op, .. } = error {
        out["op"] = json!(op);
    }
    out
}

fn parked(p: &Parked) -> Value {
    let mut out = verdict(&p.verdict);
    out["id"] = json!(p.entry.id());
    out["reason"] = json!(p.reason.as_str());
    out
}

#[test]
fn every_batch_folds_and_parks_as_the_typescript_did() {
    let doc = vectors();
    let meshes = doc["meshes"].as_array().expect("meshes");
    assert_eq!(meshes.len(), 2);
    for mesh in meshes {
        let name = mesh["description"].as_str().expect("description");
        let mut engine = device(&doc, mesh);
        for step in mesh["steps"].as_array().expect("steps") {
            let what = format!("{name} / {}", step["description"].as_str().expect("step"));
            let entries = step["events"]
                .as_array()
                .expect("events")
                .iter()
                .map(entry)
                .collect();
            let received = engine.receive_batch(entries).expect("receive");
            let report = json!({
                "folded": received.report.folded,
                "skipped": received.report.skipped,
                "quarantined": received.report.quarantined,
            });
            assert_eq!(report, step["report"], "{what}: report");
            let held: Vec<Value> = engine.quarantine().into_iter().map(parked).collect();
            assert_eq!(Value::Array(held), step["parked"], "{what}: parked");
        }
        let rows: serde_json::Map<String, Value> = engine
            .state()
            .tables
            .keys()
            .map(|table| {
                let keys: Vec<Value> = engine
                    .state()
                    .read_rows(table)
                    .into_keys()
                    .map(Value::String)
                    .collect();
                (table.clone(), Value::Array(keys))
            })
            .collect();
        assert_eq!(Value::Object(rows), mesh["rows"], "{name}: rows");
        let validator = engine.validator().expect("a validator");
        let clock = ValidationClock {
            now_ms: doc["nowMs"].as_i64().expect("now"),
            max_drift_ms: doc["maxDriftMs"].as_i64(),
        };
        for probe in mesh["probes"].as_array().expect("probes") {
            let what = format!(
                "{name} / probe: {}",
                probe["description"].as_str().expect("probe")
            );
            let event = entry(&probe["event"]).event;
            let judged = Probe {
                peer_id: &event.peer_id,
                partition: event.partition.as_ref(),
                changes: &event.changes,
                seq: None,
                hlc: None,
                local: probe["local"].as_bool().unwrap_or(false),
            };
            let got = match validator.validate(&judged, engine.state(), Some(clock)) {
                Ok(()) => json!({ "verdict": null }),
                Err(error) => verdict(&error),
            };
            let mut want = json!({ "verdict": probe["verdict"] });
            for field in ["rung", "op"] {
                if let Some(v) = probe.get(field) {
                    want[field] = v.clone();
                }
            }
            assert_eq!(got, want, "{what}");
        }
        for question in mesh["can"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let what = format!(
                "{name} / can: {}",
                question["description"].as_str().expect("question")
            );
            let principal = principal(&question["principal"]);
            let written = question.get("row").map(cells);
            let patch = question.get("patch").map(cells);
            let partition = question
                .get("partition")
                .map(|p| PartitionKey::parse(p.as_str().expect("partition")).expect("partition"));
            let source = partition.as_ref().map(|partition| PolicySource {
                partition,
                rows: engine.state(),
            });
            let answer = validator.can(
                principal.as_ref(),
                question["what"].as_str().expect("what"),
                written.as_ref(),
                patch.as_ref(),
                source,
            );
            assert_eq!(json!(answer), question["answer"], "{what}");
        }
    }
}

fn json_value(v: &Value) -> JsonValue {
    match v {
        Value::Null => JsonValue::Null,
        Value::Bool(b) => JsonValue::Bool(*b),
        Value::Number(n) => JsonValue::Number(n.as_f64().expect("number")),
        Value::String(s) => JsonValue::Text(s.clone()),
        Value::Array(a) => JsonValue::Array(a.iter().map(json_value).collect()),
        Value::Object(o) => {
            JsonValue::Object(o.iter().map(|(k, v)| (k.clone(), json_value(v))).collect())
        }
    }
}

fn cells(v: &Value) -> Row {
    v.as_object()
        .expect("a row")
        .iter()
        .map(|(k, v)| (k.clone(), CellValue::from(json_value(v))))
        .collect()
}

fn principal(v: &Value) -> Option<Principal> {
    let o = v.as_object()?;
    Some(Principal {
        account: o["account"].as_str().expect("account").to_owned(),
        role: o.get("role").and_then(Value::as_str).map(str::to_owned),
        claims: o
            .get("claims")
            .and_then(Value::as_object)
            .map(|c| c.iter().map(|(k, v)| (k.clone(), json_value(v))).collect())
            .unwrap_or_default(),
    })
}

#[test]
fn a_replace_rule_is_enforced_and_falls_back_to_update() {
    let doc = vectors();
    let notes = &doc["schema"]["tables"]["notes"]["allow"];
    let boards = &doc["schema"]["tables"]["boards"]["allow"];
    assert!(
        notes.get("replace").is_some(),
        "notes declares a replace rule of its own"
    );
    assert!(
        boards.get("replace").is_none(),
        "boards leaves replace to update"
    );
    let ops: Vec<(String, String)> = doc["meshes"][0]["steps"]
        .as_array()
        .expect("steps")
        .iter()
        .flat_map(|s| s["parked"].as_array().expect("parked").clone())
        .filter(|p| p["verdict"] == "PolicyDenied")
        .map(|p| {
            (
                p["id"].as_str().unwrap().to_owned(),
                p["op"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert!(
        ops.iter().filter(|(_, op)| op == "replace").count() >= 2,
        "a genesis refused as replace, under its own rule and under update's: {ops:?}"
    );
}
