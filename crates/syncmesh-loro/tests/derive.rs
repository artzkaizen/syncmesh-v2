//! Derived columns in Rust (RFC-0023 §16.4, §16.8): a Rust app declares its own closures over the
//! names the TypeScript manifest carries, and computes the same values from the same document the
//! TypeScript `from()` functions do (`adapters/loro/src/__tests__/derive.test.ts`).

use syncmesh_client::docs::{Derive, DocColumnEntry, DocumentAdapter};
use syncmesh_core::record::CellValue;
use syncmesh_loro::LoroAdapter;
use syncmesh_loro::loro::LoroDoc;

/// What `JSON.stringify(schema.docs.get("notes"))` writes for RFC-0023 §4.1's schema.
const MANIFEST: &str = r#"[{"column":"content","doc":"loro@1","derive":["title","wordCount"]}]"#;

fn title(doc: &LoroDoc) -> CellValue {
    CellValue::Text(doc.get_text("title").to_string())
}

fn word_count(doc: &LoroDoc) -> CellValue {
    CellValue::Number(doc.get_text("body").to_string().split_whitespace().count() as f64)
}

fn entry() -> DocColumnEntry {
    DocColumnEntry::parse_list(MANIFEST)
        .expect("the manifest reads")
        .remove(0)
}

fn note() -> LoroDoc {
    let doc = LoroAdapter::default().create(7);
    doc.get_text("title")
        .insert(0, "Board pack")
        .expect("insert");
    doc.get_text("body")
        .insert(0, "five words in this body")
        .expect("insert");
    doc.commit();
    doc
}

#[test]
fn a_rust_app_derives_the_manifests_columns_with_its_own_closures() {
    let entry = entry();
    assert_eq!(entry.doc, "loro@1");
    let derive = Derive::<LoroDoc>::new("notes", "content")
        .with("title", title)
        .with("wordCount", word_count);
    derive.check(&entry).expect("matches the manifest");
    let row = derive.compute(&note()).expect("computes");
    // the values the TypeScript `from()` functions compute for the same document
    assert_eq!(row.get("title"), Some(&CellValue::text("Board pack")));
    assert_eq!(row.get("wordCount"), Some(&CellValue::Number(5.0)));
    assert_eq!(derive.columns().collect::<Vec<_>>(), ["title", "wordCount"]);
}

#[test]
fn a_declaration_that_strays_from_the_manifest_is_refused() {
    let entry = entry();
    let missing = Derive::<LoroDoc>::new("notes", "content").with("title", title);
    assert_eq!(
        missing.check(&entry).unwrap_err().message,
        "notes.wordCount: the manifest derives it, and no closure computes it"
    );
    let extra = Derive::<LoroDoc>::new("notes", "content")
        .with("title", title)
        .with("wordCount", word_count)
        .with("summary", title);
    assert_eq!(
        extra.check(&entry).unwrap_err().message,
        "notes.summary: the manifest does not derive it from content"
    );
    let twice = Derive::<LoroDoc>::new("notes", "content")
        .with("title", title)
        .with("title", title)
        .with("wordCount", word_count);
    assert!(
        twice
            .check(&entry)
            .unwrap_err()
            .message
            .ends_with("derived twice")
    );
    let elsewhere = Derive::<LoroDoc>::new("notes", "body").with("title", title);
    assert!(elsewhere.check(&entry).is_err());
}

#[test]
fn a_closure_that_panics_is_a_value() {
    let derive = Derive::<LoroDoc>::new("notes", "content")
        .with("title", title)
        .with("wordCount", |_: &LoroDoc| panic!("the app's bug"));
    let failed = derive.compute(&note()).unwrap_err();
    assert_eq!(failed.column, "notes.wordCount");
}

#[test]
fn a_manifest_that_is_not_one_is_refused() {
    assert!(DocColumnEntry::parse_list("{}").is_err());
    assert!(DocColumnEntry::parse_list(r#"[{"column":"c","doc":"loro@1"}]"#).is_err());
    assert!(DocColumnEntry::parse_list(r#"[{"column":"c","doc":"loro@1","derive":[1]}]"#).is_err());
}
