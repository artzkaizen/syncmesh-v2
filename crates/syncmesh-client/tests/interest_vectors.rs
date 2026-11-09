//! What an interest is on the wire and what it may keep, against
//! `conformance/interest-vectors.json` (D23, O13): the TypeScript's `interestText`,
//! `interestFrom`, `scopeText`, `scopeFrom`, `narrows`, `sameInterest` and `windowRows`, answer
//! for answer.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;
use syncmesh_client::interest::{
    InterestWindow, interest_from, interest_text, narrows, same_interest, scope_from, scope_text,
    window_rows,
};
use syncmesh_core::event::PeerId;
use syncmesh_core::hlc::Hlc;
use syncmesh_core::record::{Cell, CellValue, RowRecord};
use syncmesh_core::snapshot_codec::SnapshotRow;
use syncmesh_core::stamp::Stamp;

fn vectors() -> Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "interest-vectors.json",
    ]
    .iter()
    .collect();
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("json")
}

fn text(v: &Value) -> &str {
    v.as_str().expect("text")
}

/// An interest as the vectors spell it: `""` is none.
fn interest(v: &Value) -> Option<syncmesh_client::Interest> {
    interest_from(Some(text(v)))
}

fn stamp(v: &Value) -> Option<Stamp> {
    let at = v.as_array()?;
    let ms = at[0].as_i64().expect("ms");
    let logical = u32::try_from(at[1].as_u64().expect("logical")).expect("logical fits");
    let peer = PeerId::parse(at[2].as_str().expect("peer")).expect("peer id");
    Some(Stamp::new(Hlc::new(ms, logical), peer))
}

fn row(v: &Value) -> SnapshotRow {
    let mut cells = BTreeMap::new();
    if let Some(at) = stamp(&v["cell"]) {
        cells.insert(
            "body".to_owned(),
            Cell {
                value: CellValue::Text("x".to_owned()),
                stamp: at,
            },
        );
    }
    let record = RowRecord {
        cells,
        write_stamp: stamp(&v["write"]),
        delete_stamp: stamp(&v["delete"]),
        partition: None,
    };
    SnapshotRow::new(text(&v["table"]), text(&v["key"]), record)
}

#[test]
fn an_interest_is_written_as_the_typescript_writes_it() {
    let doc = vectors();
    for v in doc["texts"].as_array().expect("texts") {
        let what = text(&v["description"]);
        let spelled = (!v["interest"].is_null()).then(|| v["interest"].to_string());
        let parsed = spelled.as_deref().and_then(|t| interest_from(Some(t)));
        assert_eq!(interest_text(parsed.as_ref()), text(&v["text"]), "{what}");
    }
}

#[test]
fn a_text_this_build_cannot_fully_read_falls_back_the_same_way() {
    let doc = vectors();
    for v in doc["read"].as_array().expect("read") {
        let what = text(&v["description"]);
        let read = interest_from(Some(text(&v["text"])));
        assert_eq!(interest_text(read.as_ref()), text(&v["reads"]), "{what}");
    }
}

#[test]
fn a_scope_is_written_and_read_as_the_typescript_does() {
    let doc = vectors();
    for v in doc["scopes"].as_array().expect("scopes") {
        let what = text(&v["description"]);
        let entitlement = v["entitlement"].as_str();
        let written = scope_text(interest(&v["interest"]).as_ref(), entitlement);
        assert_eq!(written, text(&v["text"]), "{what}");
        let back = scope_from(Some(&written));
        assert_eq!(
            interest_text(back.interest.as_ref()),
            text(&v["reads"]["interest"]),
            "{what}"
        );
        assert_eq!(
            back.entitlement.as_deref(),
            v["reads"]["entitlement"].as_str(),
            "{what}"
        );
    }
}

#[test]
fn narrowing_and_sameness_answer_as_the_typescript_does() {
    let doc = vectors();
    for v in doc["narrows"].as_array().expect("narrows") {
        let what = text(&v["description"]);
        let (next, previous) = (interest(&v["next"]), interest(&v["previous"]));
        let want = v["narrows"].as_bool().expect("narrows");
        assert_eq!(narrows(next.as_ref(), previous.as_ref()), want, "{what}");
        let same = v["same"].as_bool().expect("same");
        assert_eq!(
            same_interest(next.as_ref(), previous.as_ref()),
            same,
            "{what}"
        );
    }
}

#[test]
fn a_window_keeps_the_rows_the_typescript_keeps() {
    let doc = vectors();
    let rows: Vec<SnapshotRow> = doc["windows"]["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(row)
        .collect();
    let cases = doc["windows"]["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 8);
    for v in cases {
        let newest = v["newest"].as_u64().expect("newest");
        let kept: Vec<(String, String)> = window_rows(rows.clone(), InterestWindow { newest })
            .into_iter()
            .map(|r| (r.table, r.key))
            .collect();
        let want: Vec<(String, String)> = v["kept"]
            .as_array()
            .expect("kept")
            .iter()
            .map(|p| (text(&p[0]).to_owned(), text(&p[1]).to_owned()))
            .collect();
        assert_eq!(kept, want, "newest {newest}");
    }
}
