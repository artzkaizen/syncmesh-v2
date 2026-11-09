//! The validator inside the engine (gap U3): this device's own writes judged as probes before
//! they are numbered, `allow.replace` enforced on a `replace()` and falling back to `update`
//! (RFC-0023 §16.2), a revert that leaves a retired column out, a grant naming another device,
//! and a manifest that does not read said as a value. `policy_vectors.rs` holds the receive path
//! to the TypeScript's verdicts; these hold what only an engine's own writes reach.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;
use sha2::{Digest, Sha256};
use syncmesh_client::{
    Engine, EngineOptions, GrantRegistry, GrantSource, Manifest, MemoryEventStore, MutateError,
    ValidationError, ValidatorOptions,
};
use syncmesh_core::account::{AccountCore, LinkOp, encode_account_core, sign_link};
use syncmesh_core::doc::{DocChange, DocUpdate};
use syncmesh_core::event::{AccountId, Change, PartitionKey, PeerId};
use syncmesh_core::grant::Grant;
use syncmesh_core::hex::{from_hex, to_hex};
use syncmesh_core::identity::Identity;
use syncmesh_core::record::{CellValue, JsonValue, Row};

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
                checks: Default::default(),
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
        settles: None,
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
    assert_eq!(manifest.checked_columns().len(), 9);
    // a check schema that is not an object is a manifest that does not read
    let mut doc = vectors()["schema"].clone();
    doc["tables"]["checked"]["columns"]["qty"]["checkSchema"] = serde_json::json!("integer");
    let unreadable = Manifest::from_json(&doc).expect_err("a schema that is not an object");
    assert_eq!(unreadable.path, "tables.checked.columns.qty.checkSchema");
}

#[test]
fn doc_columns_the_engine_is_handed_are_the_ones_the_ladder_judges_by() {
    let doc = vectors();
    let now = doc["nowMs"].as_i64().expect("now");
    // the engine declares no doc columns, though the manifest gives notes.content one
    let mut member = Engine::open(
        identity(MEMBER),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            now_ms: Some(Box::new(move || now)),
            docs: Some(BTreeMap::new()),
            validator: Some(ValidatorOptions {
                manifest: Manifest::from_json(&doc["schema"]).expect("manifest"),
                grants: Some(Box::new(registry())),
                authority: None,
                accounts: false,
                checks: Default::default(),
            }),
            ..EngineOptions::default()
        },
    )
    .expect("open");
    assert!(
        member
            .validator()
            .expect("validator")
            .doc_columns()
            .is_empty()
    );
    member
        .mutate("notes.create", vec![note("n1", "acct_member")], acme())
        .expect("a member inserts");
    let verdict = refused(member.mutate("notes.edit", vec![content("n1", false)], acme()));
    assert_eq!(verdict.tag(), "DocChangeRefused");
}

fn drafts(key: &str) -> Change {
    Change::Insert {
        table: "drafts".into(),
        key: key.into(),
        row: Row::from([
            ("id".to_owned(), CellValue::text(key)),
            ("body".to_owned(), CellValue::text("x")),
        ]),
    }
}

#[test]
fn a_local_table_takes_local_only_writes_numbered_apart_and_never_sent() {
    let mut e = granted(MEMBER);
    // through the synced path a local table refuses, as a peer's event does
    let refused = e.mutate("drafts.new", vec![drafts("d1")], None);
    assert!(matches!(
        refused,
        Err(MutateError::Refused {
            verdict: ValidationError::LocalOnly { .. },
            ..
        })
    ));
    let first = e
        .mutate_local("drafts.new", vec![drafts("d1")], None)
        .unwrap();
    let second = e
        .mutate_local("drafts.new", vec![drafts("d2")], None)
        .unwrap();
    assert!(first.entry.local && first.entry.envelope().is_none());
    assert_eq!(first.entry.id(), format!("{}-L1", e.peer_id()));
    assert_eq!(second.entry.event.seq_num.get(), 2);
    assert!(e.state().read_row("drafts", "d2").is_some());
    // its own run: the synced one starts at 1, and nothing local is offered to a peer
    let acme = Some(PartitionKey::parse("org:acme").unwrap());
    let note = Change::Insert {
        table: "notes".into(),
        key: "n1".into(),
        row: Row::from([
            ("id".to_owned(), CellValue::text("n1")),
            ("title".to_owned(), CellValue::text("t")),
            ("ownerId".to_owned(), CellValue::text("acct_member")),
        ]),
    };
    let synced = e.mutate("notes.create", vec![note], acme).unwrap();
    assert_eq!(synced.entry.event.seq_num.get(), 1);
    let offered = e.events_since(&Default::default(), None).unwrap();
    assert_eq!(offered.len(), 1);
    assert!(!offered[0].local);
    assert_eq!(e.coverage().local[e.peer_id()].get(), 2);
    assert_eq!(e.cursors()[e.peer_id()].get(), 1);
}

#[test]
fn a_document_never_rides_a_local_only_write() {
    let mut e = granted(MEMBER);
    let doc = Change::Doc(DocChange {
        table: "notes".into(),
        key: "n1".into(),
        column: "content".into(),
        adapter: "loro@1".into(),
        lineage: None,
        update: DocUpdate::Bytes(vec![1]),
        genesis: false,
        legacy: false,
        parent: None,
        settles: None,
    });
    let acme = Some(PartitionKey::parse("org:acme").unwrap());
    let refused = e.mutate_local("notes.edit", vec![doc.clone()], acme);
    assert!(matches!(
        refused,
        Err(MutateError::Refused {
            verdict: ValidationError::DocChangeRefused { .. },
            ..
        })
    ));
    // with no validator the doc rungs still say so
    let mut bare = Engine::open(
        identity(MEMBER),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions::default(),
    )
    .unwrap();
    assert!(matches!(
        bare.mutate_local("notes.edit", vec![doc], None),
        Err(MutateError::DocRefused { .. })
    ));
}

#[test]
fn a_local_only_write_is_replayed_at_open_and_reverted_locally() {
    use syncmesh_client::EventStore;
    let mut e = engine_as(MEMBER, Some(Box::new(registry())), 2);
    let written = e
        .mutate_local("drafts.new", vec![drafts("d1")], None)
        .unwrap();
    let id = written.entry.id();
    assert!(e.can_revert(&id));
    let reverted = e.revert(&id).unwrap().mutated.expect("a compensation");
    assert!(
        reverted.entry.local,
        "a local write is compensated by a local write"
    );
    assert_eq!(reverted.entry.event.seq_num.get(), 2);
    assert!(e.state().read_row("drafts", "d1").is_none());

    let mut log = MemoryEventStore::new();
    for entry in e.all_events().unwrap() {
        log.append(&entry).unwrap();
    }
    let reopened = Engine::open(
        identity(MEMBER),
        Box::new(log),
        None,
        EngineOptions::default(),
    )
    .unwrap();
    assert_eq!(reopened.coverage().local[reopened.peer_id()].get(), 2);
    assert!(reopened.state().record("drafts", "d1").is_some());
    assert!(reopened.state().read_row("drafts", "d1").is_none());
}

#[test]
fn a_host_check_runs_where_the_manifest_carries_no_schema_and_wins_where_it_does() {
    let doc = vectors();
    let now = doc["nowMs"].as_i64().expect("now");
    let mut manifest = Manifest::from_json(&doc["schema"]).expect("manifest");
    assert!(
        manifest.unported_checks().is_empty(),
        "every vector check said itself as JSON Schema"
    );
    // as a `.refine()` leaves it: the column flagged, its schema weaker than the function
    let code = manifest
        .tables
        .get_mut("checked")
        .and_then(|t| t.columns.get_mut("code"))
        .expect("checked.code");
    code.check_schema = None;
    assert_eq!(manifest.unported_checks(), vec![("checked", "code")]);
    let mut checks = syncmesh_client::ColumnChecks::new();
    checks.insert(
        ("checked".to_owned(), "qty".to_owned()),
        Box::new(|v: &CellValue| matches!(v, CellValue::Number(n) if *n != 7.0)),
    );
    let mut e = Engine::open(
        identity(MEMBER),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            now_ms: Some(Box::new(move || now)),
            validator: Some(ValidatorOptions {
                checks,
                grants: Some(Box::new(registry())),
                ..ValidatorOptions::new(manifest)
            }),
            ..EngineOptions::default()
        },
    )
    .unwrap();
    let acme = Some(PartitionKey::parse("org:acme").unwrap());
    let row = |code: &str, qty: f64| Change::Insert {
        table: "checked".into(),
        key: format!("{code}{qty}"),
        row: Row::from([
            ("id".to_owned(), CellValue::text(&format!("{code}{qty}"))),
            ("code".to_owned(), CellValue::text(code)),
            ("qty".to_owned(), CellValue::Number(qty)),
        ]),
    };
    // no schema and no host check for `code`: nothing to run
    assert!(e.mutate("c", vec![row("lower", 3.0)], acme.clone()).is_ok());
    // the host's check replaces the manifest's schema for `qty`: 12 passes it, 7 does not
    assert!(e.mutate("c", vec![row("ABC", 12.0)], acme.clone()).is_ok());
    assert!(matches!(
        e.mutate("c", vec![row("ABC", 7.0)], acme),
        Err(MutateError::Refused {
            verdict: ValidationError::SchemaViolation { .. },
            ..
        })
    ));
}

#[test]
fn a_check_schema_this_build_cannot_compile_leaves_its_column_flagged_and_the_manifest_read() {
    let doc = vectors();
    let mut schema = doc["schema"].clone();
    // valid JavaScript zod runs, and patterns this build's regex engine does not compile
    for (column, pattern) in [
        ("code", r"^(?<x>a)\k<x>$"),
        ("folded", r"^\uD83D\uDE00$"),
        ("word", r"^[\p{L}--a]$"),
    ] {
        schema["tables"]["checked"]["columns"][column]["checkSchema"] =
            serde_json::json!({ "type": "string", "pattern": pattern });
    }
    let manifest = Manifest::from_json(&schema).expect("one JavaScript-only regex is no lock-out");
    assert_eq!(
        manifest.unported_checks(),
        vec![
            ("checked", "code"),
            ("checked", "folded"),
            ("checked", "word")
        ]
    );
    let dotted = &manifest.tables["checked"].columns["dotted"];
    assert!(
        dotted.check_schema.is_some(),
        "a schema that compiles still travels"
    );
    let now = doc["nowMs"].as_i64().expect("now");
    let mut e = Engine::open(
        identity(MEMBER),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            now_ms: Some(Box::new(move || now)),
            validator: Some(ValidatorOptions {
                grants: Some(Box::new(registry())),
                ..ValidatorOptions::new(manifest)
            }),
            ..EngineOptions::default()
        },
    )
    .unwrap();
    // the column's check is the flag alone: nothing to run, as for a `.refine()`
    let insert = Change::Insert {
        table: "checked".into(),
        key: "u1".into(),
        row: Row::from([
            ("id".to_owned(), CellValue::text("u1")),
            ("code".to_owned(), CellValue::text("lower")),
            ("qty".to_owned(), CellValue::Number(3.0)),
        ]),
    };
    let acme = Some(PartitionKey::parse("org:acme").unwrap());
    assert!(e.mutate("c", vec![insert], acme).is_ok());
}

#[test]
fn can_answers_for_this_device_by_its_own_grant_and_the_rows_it_holds() {
    let member = granted(MEMBER);
    assert!(member.can("notes.insert", None, Some("org:acme")));
    assert!(!member.can("notes.replace", None, Some("org:acme")));
    let mine = Row::from([("ownerId".to_owned(), CellValue::text("acct_member"))]);
    assert!(member.can("notes.update", Some(&mine), Some("org:acme")));
    // a user table is asked in the account's own instance
    assert!(member.can("profiles.insert", None, None));
    // an instance that does not parse is no instance: the manifest's rules
    assert!(member.can("notes.insert", None, Some("not an instance")));
    // no grant, no principal: no
    let stranger = engine_as(1, Some(Box::new(registry())), 0);
    assert!(!stranger.can("notes.read", None, None));
    // no validator: nothing could say yes
    let bare = Engine::open(
        identity(MEMBER),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions::default(),
    )
    .unwrap();
    assert!(!bare.can("notes.read", None, None));
}

/// An ungranted accounts mesh, with `authority` the one peer that may publish `_policy`.
fn linked_device(who: u8, authority: &Identity) -> Engine {
    let doc = vectors();
    let now = doc["nowMs"].as_i64().expect("now");
    let mut options = ValidatorOptions::new(Manifest::from_json(&doc["schema"]).expect("manifest"));
    options.accounts = true;
    options.authority = Some(authority.peer_id().clone());
    Engine::open(
        identity(who),
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            now_ms: Some(Box::new(move || now)),
            validator: Some(options),
            ..EngineOptions::default()
        },
    )
    .expect("open")
}

/// The `_links` row `account` signs for `device` in `instance`, as `linkDevice` writes it.
fn link(account: &Identity, device: &PeerId, instance: &str) -> Change {
    let partition = PartitionKey::parse(instance).expect("partition");
    let core = AccountCore {
        op: LinkOp::Link,
        account: AccountId::parse(account.peer_id().as_str()).expect("account"),
        device: device.clone(),
        partition: partition.clone(),
        at_ms: vectors()["nowMs"].as_i64().expect("now") - 1,
    };
    let wire = sign_link(account, &core);
    let key = format!(
        "{}:{}:{}",
        partition.as_str(),
        device.as_str(),
        to_hex(&Sha256::digest(encode_account_core(&core)))
    );
    Change::Insert {
        table: "_links".into(),
        key: key.clone(),
        row: row(&[
            ("id", CellValue::Text(key)),
            ("account", CellValue::text(account.peer_id().as_str())),
            ("kind", CellValue::Number(0.0)),
            ("at", CellValue::Number(core.at_ms as f64)),
            ("wire", CellValue::Bytes(wire)),
        ]),
    }
}

#[test]
fn can_with_no_instance_named_asks_as_the_account_every_link_agrees_on() {
    let (account, authority) = (identity(7), identity(11));
    let mut device = linked_device(MEMBER, &authority);
    let peer = device.peer_id().clone();
    let profile = row(&[
        ("id", CellValue::text("me")),
        ("name", CellValue::text("m")),
    ]);
    // nobody yet: no link, no principal
    assert!(!device.can("settings.read", None, None));
    device
        .mutate("link", vec![link(&account, &peer, "org:acme")], acme())
        .expect("the device carries its own link");
    // the account a link names answers for any instance, and a user table is the account's own
    assert!(device.can("settings.read", None, None));
    assert!(device.can("profiles.insert", Some(&profile), None));

    // the authority's rules for the account's own instance answer, not the manifest's
    let mine = format!("user:{}", account.peer_id().as_str());
    let now = vectors()["nowMs"].as_i64().expect("now");
    let mut publisher = Engine::open(
        authority,
        Box::new(MemoryEventStore::new()),
        None,
        EngineOptions {
            now_ms: Some(Box::new(move || now)),
            ..EngineOptions::default()
        },
    )
    .expect("open");
    let object = |pairs: Vec<(&str, JsonValue)>| {
        JsonValue::Object(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    };
    let lead = object(vec![
        ("kind", JsonValue::Text("role".into())),
        ("role", JsonValue::Text("lead".into())),
    ]);
    let rules = CellValue::from(object(vec![("profiles", object(vec![("$default", lead)]))]));
    let published = publisher
        .mutate(
            "policy",
            vec![Change::Insert {
                table: "_policy".into(),
                key: mine.clone(),
                row: row(&[
                    ("id", CellValue::text(&mine)),
                    ("rules", rules),
                    ("version", CellValue::Number(1.0)),
                    ("grace", CellValue::Null),
                ]),
            }],
            Some(PartitionKey::parse(&mine).expect("partition")),
        )
        .expect("publish");
    let folded = device.receive(published.entry).expect("receive");
    assert_eq!(folded.report.folded, 1, "{:?}", device.quarantine());
    assert!(!device.can("profiles.insert", Some(&profile), None));

    // a second account in another instance: with no instance named, there is no one answer
    let other = identity(13);
    device
        .mutate(
            "link",
            vec![link(&other, &peer, "org:beta")],
            Some(PartitionKey::parse("org:beta").unwrap()),
        )
        .expect("a second link");
    assert!(!device.can("settings.read", None, None));
    assert!(device.can("settings.read", None, Some("org:beta")));
}

#[test]
fn a_regex_match_past_the_backtrack_limit_is_no_refusal() {
    // JavaScript backtracks to the end and takes this; fancy-regex stops at its limit first
    let check = syncmesh_client::CheckSchema::compile(serde_json::json!({
        "type": "string",
        "pattern": "^(?:(?!x)a|a)*$|!$",
    }))
    .expect("compiles");
    let costly = format!("{}!", "a".repeat(20));
    assert!(check.accepts(&Value::String(costly)));
    assert!(!check.accepts(&serde_json::json!(3)));
}
