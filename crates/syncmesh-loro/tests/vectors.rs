//! `conformance/loro-vectors.json` (RFC-0023 §13). The TypeScript `loro()` adapter over
//! `loro-crdt` (wasm32) wrote the file from scripted histories; this replays every script over
//! the `loro` crate. Versions and replica ids match byte for byte on every target; snapshots and
//! updates do on 32-bit targets and import to the same document on 64-bit ones.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde_json::{Map, Value, json};
use syncmesh_client::docs::{DocumentAdapter, replica_id};
use syncmesh_core::{from_hex, to_hex};
use syncmesh_loro::loro::{ExpandType, LoroDoc, LoroValue, StyleConfig, StyleConfigMap, TextDelta};
use syncmesh_loro::{LoroAdapter, encode_version};

fn vectors() -> Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "loro-vectors.json",
    ]
    .iter()
    .collect();
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("json")
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("{key} in {v}"))
}

fn usize_of(v: &Value, key: &str) -> usize {
    v[key]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or_else(|| panic!("{key} in {v}"))
}

/// A Loro value as `toJSON()` prints it in TypeScript.
fn json_of(value: &LoroValue) -> Value {
    match value {
        LoroValue::Null => Value::Null,
        LoroValue::Bool(b) => json!(b),
        LoroValue::Double(d) => json!(d),
        LoroValue::I64(i) => json!(i),
        LoroValue::String(s) => json!(s.as_str()),
        LoroValue::List(list) => Value::Array(list.iter().map(json_of).collect()),
        LoroValue::Map(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), json_of(v)))
                .collect::<Map<_, _>>(),
        ),
        other => panic!("no JSON form in the vectors for {other:?}"),
    }
}

/// A text's delta as `LoroText.toDelta()` prints it in TypeScript.
fn delta_of(doc: &LoroDoc, text: &str) -> Value {
    let runs = doc
        .get_text(text)
        .to_delta()
        .into_iter()
        .map(|run| match run {
            TextDelta::Insert { insert, attributes } => {
                let mut out = Map::new();
                out.insert("insert".into(), json!(insert));
                if let Some(attributes) = attributes.filter(|a| !a.is_empty()) {
                    let attributes = attributes
                        .iter()
                        .map(|(k, v)| (k.clone(), json_of(v)))
                        .collect::<Map<_, _>>();
                    out.insert("attributes".into(), Value::Object(attributes));
                }
                Value::Object(out)
            }
            other => panic!("a whole text's delta holds only inserts, got {other:?}"),
        });
    Value::Array(runs.collect())
}

#[test]
fn replicas_derive_like_the_typescript() {
    let v = vectors();
    let replicas = v["replicas"].as_array().expect("replicas");
    assert_eq!(replicas.len(), 3);
    for r in replicas {
        let peer: [u8; 32] = from_hex(str_of(r, "peerId"))
            .expect("hex")
            .try_into()
            .expect("32 bytes");
        let nonce = from_hex(str_of(r, "nonce")).expect("hex");
        assert_eq!(
            replica_id(&peer, &nonce).to_string(),
            str_of(r, "replica"),
            "{r}"
        );
    }
}

#[test]
fn histories_reproduce() {
    let v = vectors();
    let adapter = LoroAdapter::default();
    assert_eq!(adapter.id(), str_of(&v, "adapter"));
    let histories = v["histories"].as_array().expect("histories");
    assert_eq!(histories.len(), 4);
    let mut mismatches = Vec::new();
    let mut same_as_documents = 0;
    for (h, history) in histories.iter().enumerate() {
        let description = str_of(history, "description");
        let steps = history["steps"].as_array().expect("steps");
        let mut docs = BTreeMap::<String, LoroDoc>::new();
        let mut outputs = BTreeMap::<String, Vec<u8>>::new();
        let mut texts = BTreeSet::new();
        let mut maps = BTreeSet::new();
        for (i, step) in steps.iter().enumerate() {
            let op = str_of(step, "op");
            let name = str_of(step, "doc");
            if let Some(t) = step["text"].as_str() {
                texts.insert(t.to_owned());
            }
            if let Some(m) = step["map"].as_str() {
                maps.insert(m.to_owned());
            }
            if op == "new" {
                let replica = str_of(step, "replica").parse().expect("u64 replica");
                docs.insert(name.to_owned(), adapter.create(replica));
                continue;
            }
            let doc = docs
                .get(name)
                .unwrap_or_else(|| panic!("{description}: no replica {name}"));
            let produced = match op {
                "style" => {
                    let mut styles = StyleConfigMap::new();
                    styles.insert(
                        str_of(step, "key").into(),
                        StyleConfig {
                            expand: ExpandType::After,
                        },
                    );
                    doc.config_text_style(styles);
                    None
                }
                "insert" => doc
                    .get_text(str_of(step, "text"))
                    .insert(usize_of(step, "pos"), str_of(step, "value"))
                    .map(|()| None)
                    .expect("insert"),
                "delete" => doc
                    .get_text(str_of(step, "text"))
                    .delete(usize_of(step, "pos"), usize_of(step, "len"))
                    .map(|()| None)
                    .expect("delete"),
                "mark" => doc
                    .get_text(str_of(step, "text"))
                    .mark(
                        usize_of(step, "start")..usize_of(step, "end"),
                        str_of(step, "key"),
                        true,
                    )
                    .map(|()| None)
                    .expect("mark"),
                "set" => doc
                    .get_map(str_of(step, "map"))
                    .insert(str_of(step, "key"), str_of(step, "value"))
                    .map(|()| None)
                    .expect("set"),
                "commit" => {
                    doc.commit();
                    None
                }
                "snapshot" => Some(adapter.snapshot(doc).expect("snapshot")),
                "version" => Some(adapter.version(doc)),
                "since" => {
                    let from = &outputs[str_of(step, "from")];
                    Some(adapter.since(doc, from).expect("since"))
                }
                "apply" => {
                    let updates: Vec<&[u8]> = step["updates"]
                        .as_array()
                        .expect("updates")
                        .iter()
                        .map(|label| outputs[label.as_str().expect("label")].as_slice())
                        .collect();
                    let changed = adapter.apply(doc, &updates).expect("apply");
                    assert_eq!(
                        Some(changed),
                        step["changed"].as_bool(),
                        "{description} / step {i}: changed"
                    );
                    None
                }
                other => panic!("{description}: unknown op {other}"),
            };
            if let Some(bytes) = produced {
                let label = str_of(step, "as");
                let frozen = from_hex(str_of(&history["outputs"], label)).expect("hex");
                let at = format!("h{h} step {i} `{label}` ({description})");
                same_as_documents += usize::from(check(
                    op == "version",
                    &texts,
                    &at,
                    &frozen,
                    &bytes,
                    &mut mismatches,
                ));
                // later steps read the frozen bytes, so one mismatch does not cascade
                outputs.insert(label.to_owned(), frozen);
            }
        }
        let finals = history["final"].as_object().expect("final");
        assert_eq!(
            finals.keys().collect::<Vec<_>>(),
            docs.keys().collect::<Vec<_>>(),
            "{description}: replicas"
        );
        for (name, doc) in &docs {
            let expected = &finals[name];
            for (label, actual) in [
                ("snapshot", adapter.snapshot(doc).expect("snapshot")),
                ("version", adapter.version(doc)),
            ] {
                let frozen = from_hex(str_of(expected, label)).expect("hex");
                let at = format!("h{h} final.{name}.{label} ({description})");
                same_as_documents += usize::from(check(
                    label == "version",
                    &texts,
                    &at,
                    &frozen,
                    &actual,
                    &mut mismatches,
                ));
            }
            let texts_now: Map<_, _> = texts
                .iter()
                .map(|t| (t.clone(), json!(doc.get_text(t.as_str()).to_string())))
                .collect();
            assert_eq!(
                Value::Object(texts_now),
                expected["texts"],
                "{description} / final.{name}.texts"
            );
            let maps_now: Map<_, _> = maps
                .iter()
                .map(|m| (m.clone(), json_of(&doc.get_map(m.as_str()).get_value())))
                .collect();
            assert_eq!(
                Value::Object(maps_now),
                expected["maps"],
                "{description} / final.{name}.maps"
            );
            let deltas_now: Map<_, _> = texts
                .iter()
                .map(|t| (t.clone(), delta_of(doc, t)))
                .collect();
            assert_eq!(
                Value::Object(deltas_now),
                expected["deltas"],
                "{description} / final.{name}.deltas"
            );
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
    eprintln!("{same_as_documents} snapshots and updates matched as documents, not bytes");
}

/// Checks one produced byte string against the frozen one. A version matches byte for byte on
/// every target; a snapshot or an update does so between builds of one word size, and otherwise
/// must import to the same document. Returns whether it matched only as a document.
fn check(
    is_version: bool,
    texts: &BTreeSet<String>,
    at: &str,
    frozen: &[u8],
    ours: &[u8],
    mismatches: &mut Vec<String>,
) -> bool {
    if frozen == ours {
        return false;
    }
    if is_version || cfg!(target_pointer_width = "32") {
        mismatches.push(format!(
            "{at}:\n  ts:   {}\n  rust: {}",
            to_hex(frozen),
            to_hex(ours)
        ));
        return false;
    }
    same_document(texts, at, frozen, ours);
    true
}

/// Imports each byte string into a fresh replica; both must land on the same version and value,
/// and carry the same changes.
fn same_document(texts: &BTreeSet<String>, at: &str, frozen: &[u8], ours: &[u8]) {
    let adapter = LoroAdapter::default();
    let [a, b] = [frozen, ours].map(|bytes| {
        let doc = LoroDoc::new();
        adapter
            .apply(&doc, &[bytes])
            .unwrap_or_else(|e| panic!("{at}: {e}"));
        doc
    });
    assert_eq!(adapter.version(&a), adapter.version(&b), "{at}: version");
    assert_eq!(a.get_deep_value(), b.get_deep_value(), "{at}: value");
    for t in texts {
        assert_eq!(delta_of(&a, t), delta_of(&b, t), "{at}: delta of {t}");
    }
    let [ma, mb] = [frozen, ours]
        .map(|bytes| LoroDoc::decode_import_blob_meta(bytes, true).expect("blob meta"));
    assert_eq!(
        (
            encode_version(&ma.partial_start_vv),
            encode_version(&ma.partial_end_vv),
            ma.change_num,
            ma.start_timestamp,
            ma.end_timestamp,
        ),
        (
            encode_version(&mb.partial_start_vv),
            encode_version(&mb.partial_end_vv),
            mb.change_num,
            mb.start_timestamp,
            mb.end_timestamp,
        ),
        "{at}: blob meta"
    );
}
