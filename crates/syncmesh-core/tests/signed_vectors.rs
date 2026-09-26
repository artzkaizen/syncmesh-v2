//! Grants, custody receipts, account links and checkpoint certificates, byte for byte against the
//! frozen vectors (D35 slice 3): each decodes into its Rust type, carries the fields the TypeScript
//! suites check, verifies under the key its document names, and re-encodes to the signed core.
//!
//! Ed25519 is deterministic, so the same seeds the generators use must also make Rust *mint* the
//! exact `wireHex` — the strongest form of the check, since it covers encode and sign together.

use std::collections::BTreeMap;
use std::path::PathBuf;

use syncmesh_core::account::{self, AccountCore, LinkError, LinkOp};
use syncmesh_core::checkpoint::{self, CheckpointError, CheckpointRequest, CheckpointRow};
use syncmesh_core::envelope::envelope;
use syncmesh_core::event::{AccountId, PartitionKey, PeerId, SeqNum};
use syncmesh_core::grant::{self, GrantError, GrantRequest};
use syncmesh_core::receipt::{self, ReceiptRequest};
use syncmesh_core::record::JsonValue;
use syncmesh_core::{Identity, from_hex, to_hex};

const NOW: i64 = 1_700_000_000_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;

fn vectors(name: &str) -> serde_json::Value {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "..", "..", "conformance", name]
        .iter()
        .collect();
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("json")
}

fn text<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_else(|| panic!("{key} is text"))
}

fn peer(v: &serde_json::Value, key: &str) -> PeerId {
    PeerId::parse(text(v, key)).expect("peer id")
}

fn wires(doc: &serde_json::Value) -> Vec<(String, Vec<u8>)> {
    doc["vectors"]
        .as_array()
        .expect("vectors")
        .iter()
        .map(|v| {
            (
                text(v, "description").to_owned(),
                from_hex(text(v, "wireHex")).expect("hex"),
            )
        })
        .collect()
}

/// `Uint8Array.from({ length: 32 }, (_, i) => start + i)`, the generators' seeds.
fn seed(start: u8) -> Identity {
    Identity::from_seed(&std::array::from_fn(|i| start + i as u8))
}

fn pk(s: &str) -> PartitionKey {
    PartitionKey::parse(s).unwrap()
}

fn json_text(s: &str) -> JsonValue {
    JsonValue::Text(s.to_owned())
}

#[test]
fn grant_vectors_verify_decode_reencode_and_remint() {
    let doc = vectors("grant-vectors.json");
    let issuer_id = peer(&doc, "issuerId");
    let device_id = peer(&doc, "deviceId");
    let (issuer, device) = (seed(1), seed(101));
    assert_eq!(issuer.peer_id(), &issuer_id);
    assert_eq!(device.peer_id(), &device_id);

    let mut claims = BTreeMap::new();
    claims.insert("member".to_owned(), json_text("m_9001"));
    let mut permissions = BTreeMap::new();
    permissions.insert(
        "controls".to_owned(),
        JsonValue::Array(vec![json_text("read"), json_text("update")]),
    );
    claims.insert("permissions".to_owned(), JsonValue::Object(permissions));
    claims.insert(
        "entities".to_owned(),
        JsonValue::Array(vec![json_text("e_root"), json_text("e_berlin")]),
    );
    let request =
        |account: &str, role: Option<&str>, partitions: &[&str], valid_for_ms: i64| GrantRequest {
            account: account.to_owned(),
            device: device_id.clone(),
            role: role.map(str::to_owned),
            partitions: partitions.iter().map(|p| pk(p)).collect(),
            claims: BTreeMap::new(),
            keys: Vec::new(),
            valid_for_ms,
            now_ms: NOW,
        };
    let requests = [
        request("acct_a", Some("member"), &["org:acme"], HOUR),
        GrantRequest {
            claims: claims.clone(),
            ..request("u_42", None, &["org:acme", "shelf:s1"], 4 * HOUR)
        },
        request("acct_a", None, &[], 30 * DAY),
    ];

    let list = wires(&doc);
    assert_eq!(list.len(), requests.len());
    for ((description, wire), request) in list.iter().zip(&requests) {
        let signed = grant::verify_grant(wire, &issuer_id, NOW)
            .unwrap_or_else(|e| panic!("{description}: {e}"));
        let g = &signed.value;
        assert_eq!(g.device, device_id, "{description}");
        assert_eq!(g.account, request.account, "{description}");
        assert_eq!(g.role, request.role, "{description}");
        assert_eq!(g.partitions, request.partitions, "{description}");
        assert_eq!(g.claims, request.claims, "{description}");
        assert!(g.keys.is_empty(), "{description}");
        assert_eq!(g.issued_at_ms, NOW, "{description}");
        assert_eq!(g.expires_at_ms, NOW + request.valid_for_ms, "{description}");
        assert_eq!(
            to_hex(&grant::encode_grant(g)),
            to_hex(&signed.core),
            "{description}: re-encode"
        );
        assert_eq!(envelope(&signed.core, &signed.sig), *wire, "{description}");
        assert_eq!(
            to_hex(&grant::issue_grant(&issuer, request)),
            to_hex(wire),
            "{description}: Rust mints the frozen bytes"
        );
        let origin = grant::read_grant_origin(wire).unwrap();
        assert_eq!(
            (origin.device, origin.issued_at_ms),
            (device_id.clone(), NOW)
        );

        // expired one millisecond past the window, and never under another key
        assert_eq!(
            grant::verify_grant(wire, &issuer_id, g.expires_at_ms + 1),
            Err(GrantError::Expired {
                expires_at_ms: g.expires_at_ms
            })
        );
        assert_eq!(
            grant::verify_grant(wire, &device_id, NOW),
            Err(GrantError::BadSignature)
        );
    }
}

#[test]
fn receipt_vectors_verify_under_the_named_holder_and_remint() {
    let doc = vectors("receipt-vectors.json");
    let holder_id = peer(&doc, "holderId");
    let author_id = peer(&doc, "authorId");
    let (holder, author) = (seed(21), seed(121));
    assert_eq!(holder.peer_id(), &holder_id);
    assert_eq!(author.peer_id(), &author_id);

    let expected = [(1, "store-1"), (4096, "store-1"), (4096, "store-2")];
    let list = wires(&doc);
    assert_eq!(list.len(), expected.len());
    for ((description, wire), (through, incarnation)) in list.iter().zip(expected) {
        let signed = receipt::verify_receipt(wire).unwrap_or_else(|e| panic!("{description}: {e}"));
        let r = &signed.value;
        assert_eq!(r.holder, holder_id, "{description}");
        assert_eq!(r.author, author_id, "{description}");
        assert_eq!(r.through_seq.get(), through, "{description}");
        assert_eq!(r.incarnation, incarnation, "{description}");
        assert_eq!(r.issued_at_ms, NOW, "{description}");
        // the incarnation is inside the signature, not beside it
        assert_eq!(
            to_hex(&receipt::encode_receipt(r)),
            to_hex(&signed.core),
            "{description}: re-encode"
        );
        let request = ReceiptRequest {
            author: author_id.clone(),
            through_seq: SeqNum::parse(through).unwrap(),
            incarnation: incarnation.to_owned(),
            now_ms: NOW,
        };
        assert_eq!(
            to_hex(&receipt::issue_receipt(&holder, &request)),
            to_hex(wire),
            "{description}: Rust mints the frozen bytes"
        );
        // the author re-signing the holder's core is refused: the core names its verifier
        let forged = envelope(&signed.core, &author.sign(&signed.core));
        assert_eq!(
            receipt::verify_receipt(&forged),
            Err(receipt::ReceiptError::BadSignature)
        );
    }
}

#[test]
fn account_vectors_verify_under_the_named_account_and_remint() {
    let doc = vectors("account-vectors.json");
    let account_id = AccountId::parse(text(&doc, "accountId")).unwrap();
    let device_id = peer(&doc, "deviceId");
    let (account, device) = (seed(11), seed(101));
    assert_eq!(account.peer_id().as_str(), account_id.as_str());
    assert_eq!(device.peer_id(), &device_id);

    let expected = [
        (LinkOp::Link, "org:acme", NOW),
        (LinkOp::Link, "shelf:s1", NOW),
        (LinkOp::Unlink, "org:acme", NOW + HOUR),
    ];
    let list = wires(&doc);
    assert_eq!(list.len(), expected.len());
    for ((description, wire), (op, partition, at_ms)) in list.iter().zip(expected) {
        let signed = account::verify_link(wire).unwrap_or_else(|e| panic!("{description}: {e}"));
        let want = AccountCore {
            op,
            account: account_id.clone(),
            device: device_id.clone(),
            partition: pk(partition),
            at_ms,
        };
        assert_eq!(signed.value, want, "{description}");
        assert_eq!(
            to_hex(&account::encode_account_core(&signed.value)),
            to_hex(&signed.core),
            "{description}: re-encode"
        );
        assert_eq!(
            to_hex(&account::sign_link(&account, &want)),
            to_hex(wire),
            "{description}: Rust mints the frozen bytes"
        );
        // the device signing the account's core is not the account's half of the claim
        let forged = envelope(&signed.core, &device.sign(&signed.core));
        assert_eq!(account::verify_link(&forged), Err(LinkError::BadSignature));
    }
}

#[test]
fn checkpoint_vectors_hash_the_rows_verify_and_remint() {
    let doc = vectors("checkpoint-vectors.json");
    let issuer_id = peer(&doc, "issuerId");
    let author_id = peer(&doc, "authorId");
    let (issuer, author) = (seed(1), seed(200));
    assert_eq!(issuer.peer_id(), &issuer_id);
    assert_eq!(author.peer_id(), &author_id);

    let rows: Vec<CheckpointRow> = doc["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| CheckpointRow {
            table: text(r, "table").to_owned(),
            key: text(r, "key").to_owned(),
            record: from_hex(text(r, "recordHex")).unwrap(),
        })
        .collect();
    let state_hash = text(&doc, "stateHashHex");
    assert_eq!(to_hex(&checkpoint::checkpoint_hash(&rows)), state_hash);
    let reversed: Vec<_> = rows.iter().rev().cloned().collect();
    assert_eq!(to_hex(&checkpoint::checkpoint_hash(&reversed)), state_hash);

    let mut coverage = BTreeMap::new();
    coverage.insert(author_id.clone(), 42);
    let partitions = [None, Some(pk("org:acme"))];
    let list = wires(&doc);
    assert_eq!(list.len(), partitions.len());
    for ((description, wire), partition) in list.iter().zip(partitions) {
        let signed = checkpoint::verify_checkpoint(wire, &issuer_id, Some(&rows))
            .unwrap_or_else(|e| panic!("{description}: {e}"));
        let c = &signed.value;
        assert_eq!(c.issuer, issuer_id, "{description}");
        assert_eq!(to_hex(&c.state_hash), state_hash, "{description}");
        assert_eq!(c.coverage.get(&author_id), Some(&42), "{description}");
        assert_eq!(c.partition, partition, "{description}");
        assert_eq!(c.issued_at_ms, NOW, "{description}");
        assert_eq!(
            to_hex(&checkpoint::encode_checkpoint(c)),
            to_hex(&signed.core),
            "{description}: re-encode"
        );
        let request = CheckpointRequest {
            partition,
            state_hash: from_hex(state_hash).unwrap(),
            coverage: coverage.clone(),
            now_ms: NOW,
        };
        assert_eq!(
            to_hex(&checkpoint::issue_checkpoint(&issuer, &request)),
            to_hex(wire),
            "{description}: Rust mints the frozen bytes"
        );

        // a row altered is a mismatch; a certificate under another issuer is not a certificate
        let mut altered = rows.clone();
        altered[0].record = vec![0xa0];
        assert!(matches!(
            checkpoint::verify_checkpoint(wire, &issuer_id, Some(&altered)),
            Err(CheckpointError::Mismatch { .. })
        ));
        assert_eq!(
            checkpoint::verify_checkpoint(wire, &author_id, Some(&rows)),
            Err(CheckpointError::BadSignature)
        );
    }
}

/// What Rust signs from a seed of its own, Rust reads back with every field intact.
#[test]
fn rust_minted_cores_round_trip() {
    let server = Identity::from_seed(&[42; 32]);
    let phone = Identity::from_seed(&[43; 32]);

    let mut claims = BTreeMap::new();
    claims.insert("n".to_owned(), JsonValue::Number(0.25));
    claims.insert("big".to_owned(), JsonValue::Number(1e300));
    let request = GrantRequest {
        account: "acct_\u{1F600}".to_owned(),
        device: phone.peer_id().clone(),
        role: Some("owner".to_owned()),
        partitions: vec![pk("org:acme")],
        claims,
        keys: vec![grant::WrappedKey {
            partition: pk("org:acme"),
            epoch: 2,
            wrapped: vec![7; 72],
        }],
        valid_for_ms: 7 * DAY,
        now_ms: NOW,
    };
    let wire = grant::issue_grant(&server, &request);
    let g = grant::verify_grant(&wire, server.peer_id(), NOW).unwrap();
    assert_eq!(g.value.claims, request.claims);
    assert_eq!(g.value.keys, request.keys);
    assert_eq!(g.wire, wire);
    assert_eq!(grant::encode_grant(&g.value), g.core);

    let r = receipt::verify_receipt(&receipt::issue_receipt(
        &phone,
        &ReceiptRequest {
            author: server.peer_id().clone(),
            through_seq: SeqNum::parse(9_007_199_254_740_991).unwrap(),
            incarnation: "store-\u{e9}".to_owned(),
            now_ms: NOW,
        },
    ))
    .unwrap();
    assert_eq!(r.value.through_seq.get(), 9_007_199_254_740_991);

    let link = AccountCore {
        op: LinkOp::Unlink,
        account: AccountId::parse(server.peer_id().as_str()).unwrap(),
        device: phone.peer_id().clone(),
        partition: pk("shelf:s9"),
        at_ms: NOW,
    };
    assert_eq!(
        account::verify_link(&account::sign_link(&server, &link))
            .unwrap()
            .value,
        link
    );

    let rows = vec![CheckpointRow {
        table: "t\"ab\\le".to_owned(),
        key: "k\n\u{1F600}".to_owned(),
        record: syncmesh_core::encode_record(&Default::default()),
    }];
    let mut coverage = BTreeMap::new();
    coverage.insert(phone.peer_id().clone(), 0);
    coverage.insert(server.peer_id().clone(), 17);
    let wire = checkpoint::issue_checkpoint(
        &server,
        &CheckpointRequest {
            partition: Some(pk("org:acme")),
            state_hash: checkpoint::checkpoint_hash(&rows).to_vec(),
            coverage: coverage.clone(),
            now_ms: NOW,
        },
    );
    let c = checkpoint::verify_checkpoint(&wire, server.peer_id(), Some(&rows)).unwrap();
    assert_eq!(c.value.coverage, coverage);
}
