//! The validator inside the engine (gap U3): this device's own writes judged as probes before
//! they are numbered, `allow.replace` enforced on a `replace()` and falling back to `update`
//! (RFC-0023 §16.2), a revert that leaves a retired column out, a grant naming another device,
//! and a manifest that does not read said as a value. `policy_vectors.rs` holds the receive path
//! to the TypeScript's verdicts; these hold what only an engine's own writes reach.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;
use syncmesh_client::{
    Engine, EngineOptions, GrantRegistry, GrantSource, Manifest, MemoryEventStore, MutateError,
    ValidationError, ValidatorOptions,
};
use syncmesh_core::doc::{DocChange, DocUpdate};
use syncmesh_core::event::{Change, PartitionKey, PeerId};
use syncmesh_core::grant::Grant;
use syncmesh_core::hex::from_hex;
use syncmesh_core::identity::Identity;
use syncmesh_core::record::{CellValue, Row};

/// The vectors' file: its manifest and grants are the fixtures, declared once there.
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
    serde_json::from_str(&std::fs::read_to_string(&path).expect("vectors")).expect("json")
}

/// The vectors' identities by seed start: the member is 129, the admin 97.
fn identity(start: u8) -> Identity {
    Identity::from_seed(&std::array::from_fn(|i| start.wrapping_add(i as u8)))
}

const MEMBER: u8 = 129;
const ADMIN: u8 = 97;

fn engine_as(who: u8, grants: Option<Box<dyn GrantSource + Send>>, undo_depth: usize) -> Engine {
    let doc = vectors();
    let now = doc["nowMs"].as_i64().expect("now");
    Engine::open(
        identity(who),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            now_ms: Some(Box::new(move || now)),
            undo_depth,
            validator: Some(ValidatorOptions {
                manifest: Manifest::from_json(&doc["schema"]).expect("manifest"),
                grants,
                authority: None,
                accounts: false,
            }),
            ..EngineOptions::default()
        },
    )
    .expect("open")
}

fn registry() -> GrantRegistry {
    let doc = vectors();
    let now = doc["nowMs"].as_i64().expect("now");
    let issuer = PeerId::parse(doc["issuer"].as_str().expect("issuer")).expect("issuer");
    let mut registry = GrantRegistry::new(issuer);
    for wire in doc["grants"].as_array().expect("grants") {
        let bytes = from_hex(wire.as_str().expect("hex")).expect("hex");
        registry.register(&bytes, now).expect("grant");
    }
    registry
}

fn granted(who: u8) -> Engine {
    engine_as(who, Some(Box::new(registry())), 0)
}

fn acme() -> Option<PartitionKey> {
    Some(PartitionKey::parse("org:acme").expect("partition"))
}

fn row(pairs: &[(&str, CellValue)]) -> Row {
    pairs
        .iter()
        .map(|(c, v)| ((*c).to_owned(), v.clone()))
        .collect()
}

fn note(key: &str, owner: &str) -> Change {
    Change::Insert {
        table: "notes".into(),
        key: key.into(),
        row: row(&[
            ("id", CellValue::text(key)),
            ("title", CellValue::text("t")),
            ("ownerId", CellValue::text(owner)),
        ]),
    }
}

fn content(key: &str, genesis: bool) -> Change {
    Change::Doc(DocChange {
        table: "notes".into(),
        key: key.into(),
        column: "content".into(),
        adapter: "loro@1".into(),
        lineage: None,
        update: DocUpdate::Bytes(vec![1, 2, 3]),
        genesis,
        legacy: false,
        parent: None,
    })
}

fn refused(result: Result<syncmesh_client::Mutated, MutateError>) -> ValidationError {
    match result {
        Err(MutateError::Refused { verdict, .. }) => verdict,
        other => panic!("expected the ladder to refuse the write, got {other:?}"),
    }
}

#[test]
fn an_owner_edits_a_document_and_only_a_replace_rule_may_set_it_aside() {
    let mut member = granted(MEMBER);
    member
        .mutate("notes.create", vec![note("n1", "acct_member")], acme())
        .expect("a member inserts");
    member
        .mutate("notes.edit", vec![content("n1", false)], acme())
        .expect("the owner edits: update is any(owner, admin)");
    // notes.allow.replace is role("admin"): the owner's update right does not stretch to it
    let verdict = refused(member.mutate("notes.replace", vec![content("n1", true)], acme()));
    assert_eq!(verdict.tag(), "PolicyDenied");
    assert!(matches!(&verdict, ValidationError::PolicyDenied { op, .. } if op == "replace"));
    // refused as a probe: nothing was numbered, so the next write takes the next number
    let next = member
        .mutate("notes.edit", vec![content("n1", false)], acme())
        .expect("edit");
    assert_eq!(next.entry.event.seq_num.get(), 3);

    let mut admin = granted(ADMIN);
    admin
        .mutate("notes.create", vec![note("n2", "acct_member")], acme())
        .expect("an admin inserts");
    admin
        .mutate("notes.replace", vec![content("n2", true)], acme())
        .expect("an admin replaces");
}

#[test]
fn a_table_with_no_replace_rule_judges_a_replace_as_its_update() {
    let mut member = granted(MEMBER);
    let board = |key: &str| Change::Insert {
        table: "boards".into(),
        key: key.into(),
        row: row(&[
            ("id", CellValue::text(key)),
            ("title", CellValue::text("b")),
        ]),
    };
    let genesis = |key: &str| match content(key, true) {
        Change::Doc(d) => Change::Doc(DocChange {
            table: "boards".into(),
            ..d
        }),
        other => other,
    };
    member
        .mutate("boards.create", vec![board("b1")], acme())
        .expect("insert");
    // boards: update is role("member"), and replace falls back to it
    member
        .mutate("boards.replace", vec![genesis("b1")], acme())
        .expect("replace as update");
}

#[test]
fn own_writes_meet_the_rungs_a_peer_would_park_them_on() {
    let mut member = granted(MEMBER);
    let archive = Change::Insert {
        table: "archive".into(),
        key: "a1".into(),
        row: row(&[
            ("id", CellValue::text("a1")),
            ("title", CellValue::text("x")),
        ]),
    };
    assert_eq!(
        refused(member.mutate("archive.create", vec![archive], acme())).tag(),
        "RetiredWrite"
    );
    let ghost = Change::Delete {
        table: "ghost".into(),
        key: "g".into(),
    };
    assert_eq!(
        refused(member.mutate("ghost.delete", vec![ghost], acme())).tag(),
        "UnknownTable"
    );
    let elsewhere = Some(PartitionKey::parse("org:beta").expect("partition"));
    assert_eq!(
        refused(member.mutate("notes.create", vec![note("n9", "acct_member")], elsewhere)).tag(),
        "PartitionNotGranted"
    );
    assert!(
        member.quarantine().is_empty(),
        "a refused own write parks nothing"
    );
}

#[test]
fn a_revert_brings_a_row_back_without_its_retired_column() {
    let mut member = engine_as(MEMBER, None, 4);
    let with_legacy = Change::Insert {
        table: "notes".into(),
        key: "n1".into(),
        row: row(&[
            ("id", CellValue::text("n1")),
            ("title", CellValue::text("t")),
            ("ownerId", CellValue::text("acct_member")),
        ]),
    };
    member
        .mutate("notes.create", vec![with_legacy], acme())
        .expect("insert");
    // the retired column, as an older build still writes it: a numbered event, so it folds
    let older = Change::Update {
        table: "notes".into(),
        key: "n1".into(),
        patch: row(&[("legacy", CellValue::text("older"))]),
    };
    // write `legacy` through an engine with no validator, as an older build would
    let now = vectors()["nowMs"].as_i64().expect("now");
    let mut older_build = Engine::open(
        identity(ADMIN),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            now_ms: Some(Box::new(move || now + 1)),
            ..EngineOptions::default()
        },
    )
    .expect("open");
    let wrote = older_build
        .mutate("notes.legacy", vec![older], acme())
        .expect("older build");
    let folded = member.receive(wrote.entry).expect("receive older");
    assert_eq!(folded.report.folded, 1, "{:?}", member.quarantine());
    assert_eq!(
        member.state().read_row("notes", "n1").expect("row")["legacy"],
        CellValue::text("older")
    );
    let deleted = member
        .mutate(
            "notes.delete",
            vec![Change::Delete {
                table: "notes".into(),
                key: "n1".into(),
            }],
            acme(),
        )
        .expect("delete");
    let reverted = member
        .revert(&deleted.entry.id())
        .expect("a revert the ladder admits");
    let back = reverted.mutated.expect("the row comes back");
    let Change::Insert { row, .. } = &back.entry.event.changes[0] else {
        panic!("a delete is undone by an insert");
    };
    assert!(
        !row.contains_key("legacy"),
        "the retired column is left out: {row:?}"
    );
    assert!(member.state().read_row("notes", "n1").is_some());
}

/// A grant source that answers for an author with a grant minted for someone else.
struct Borrowed(Grant);

impl GrantSource for Borrowed {
    fn grant_for(&self, _: &PeerId, _: i64) -> Option<Grant> {
        Some(self.0.clone())
    }
}

#[test]
fn a_grant_naming_another_device_is_no_grant_for_this_one() {
    let registry = registry();
    let now = vectors()["nowMs"].as_i64().expect("now");
    let admins = registry
        .grant_for(identity(ADMIN).peer_id(), now)
        .expect("the admin's grant")
        .clone();
    let mut member = engine_as(MEMBER, Some(Box::new(Borrowed(admins))), 0);
    let verdict = refused(member.mutate("notes.create", vec![note("n1", "acct_admin")], acme()));
    assert_eq!(verdict.tag(), "GrantDeviceMismatch");
}

#[test]
fn a_manifest_that_does_not_read_is_a_value() {
    assert!(Manifest::parse("not json").is_err());
    assert_eq!(
        Manifest::parse(r#"{"v":2}"#).expect_err("v2").path,
        "v".to_owned()
    );
    let mut doc = vectors()["schema"].clone();
    doc["tables"]["notes"]["allow"] = serde_json::json!({ "insert": { "kind": "allow" } });
    let unreadable = Manifest::from_json(&doc).expect_err("an allow block without $default");
    assert_eq!(unreadable.path, "tables.notes.allow");
    let manifest = Manifest::from_json(&vectors()["schema"]).expect("manifest");
    assert_eq!(
        manifest.doc_columns()["notes"],
        BTreeMap::from([("content".to_owned(), "loro@1".to_owned())])
    );
    assert!(manifest.checked_columns().is_empty());
}
