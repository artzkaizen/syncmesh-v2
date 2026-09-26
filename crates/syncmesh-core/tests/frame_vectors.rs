//! Session frames, length framing, relay control frames and the v2 join proof against
//! `conformance/{frame,relay,join}-vectors.json`, byte for byte (D35 slice 4).

use std::path::PathBuf;

use syncmesh_core::event::{PeerId, SeqNum};
use syncmesh_core::frames::{self, Digest, Frame, RouteAd, SnapshotFrame, class_of};
use syncmesh_core::framing::{self, FrameReader};
use syncmesh_core::identity::Identity;
use syncmesh_core::join_proof::{prove_join, verify_join_proof};
use syncmesh_core::relay_frames::{self, RELAY_PROTOCOL_VERSIONS, RelayFrame, decode_relay_frame};
use syncmesh_core::{from_hex, to_hex};

fn vectors(name: &str) -> serde_json::Value {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "..", "..", "conformance", name]
        .iter()
        .collect();
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("json")
}

fn hex(v: &serde_json::Value, key: &str) -> Vec<u8> {
    from_hex(v[key].as_str().expect(key)).expect("hex")
}

/// `seed(n)` in the TypeScript fixtures: bytes `n, n+1, …` mod 256.
fn seed(n: u8) -> [u8; 32] {
    std::array::from_fn(|i| n.wrapping_add(i as u8))
}

fn peer(s: &str) -> PeerId {
    PeerId::parse(s).expect("peer id")
}

fn seq(n: u64) -> SeqNum {
    SeqNum::parse(n).expect("seq")
}

#[test]
fn session_frames_decode_to_their_kind_and_reencode_byte_for_byte() {
    let doc = vectors("frame-vectors.json");
    let device = Identity::from_seed(&seed(200));
    let other = Identity::from_seed(&seed(121));
    assert_eq!(doc["deviceId"].as_str(), Some(device.peer_id().as_str()));
    assert_eq!(doc["otherId"].as_str(), Some(other.peer_id().as_str()));

    let list = doc["vectors"].as_array().unwrap();
    assert_eq!(list.len(), 18);
    let mut tags: Vec<u8> = Vec::new();
    for v in list {
        let what = v["description"].as_str().unwrap();
        let wire = hex(v, "wireHex");
        let tag = v["tag"].as_u64().unwrap() as u8;
        // the tag is the second byte under a one-byte array header, readable without a decode
        assert_eq!(wire[0] & 0xe0, 0x80, "{what}");
        assert_eq!(wire[1], tag, "{what}");
        assert_eq!(class_of(&wire), Some(tag), "{what}");
        let frame = frames::decode_frame(&wire).unwrap_or_else(|e| panic!("{what}: {e}"));
        assert_eq!(frame.kind(), v["kind"].as_str().unwrap(), "{what}");
        assert_eq!(
            to_hex(&frame.encode().expect("known")),
            to_hex(&wire),
            "{what}"
        );
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags.sort();
    assert_eq!(
        tags,
        frames::tag::ALL.to_vec(),
        "the tag space the vector pins"
    );
}

#[test]
fn session_frames_are_reproduced_from_the_generator_inputs() {
    let doc = vectors("frame-vectors.json");
    let wires: Vec<Vec<u8>> = doc["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| hex(v, "wireHex"))
        .collect();
    let device = Identity::from_seed(&seed(200));
    let other = Identity::from_seed(&seed(121));
    let (d, o) = (device.peer_id().clone(), other.peer_id().clone());
    let cursors = vec![(d.clone(), seq(7)), (o.clone(), seq(3))];
    let ahead = vec![(o.clone(), vec![seq(5), seq(6)])];
    let digests = vec![("notes".to_owned(), Digest::from_u64(0xdeadbeef))];
    let acme = r#"{"partitions":["org:acme"]}"#;
    let now = 1_700_000_000_000_f64;

    // the payloads other vectors froze, carried under their frame tags
    let event = &vectors("wire-vectors.json")["vectors"][0];
    let event_wire =
        syncmesh_core::envelope::envelope(&hex(event, "coreHex"), &hex(event, "sigHex"));
    let grant_wire = hex(&vectors("grant-vectors.json")["vectors"][0], "wireHex");
    let receipt_wire = hex(&vectors("receipt-vectors.json")["vectors"][0], "wireHex");

    let expected: Vec<(usize, Vec<u8>)> = vec![
        (0, frames::grant_frame(&grant_wire)),
        (1, frames::grant_request_frame(&d, None)),
        (2, frames::grant_request_frame(&d, Some("inv-7"))),
        (3, frames::cursors_frame(&d, &cursors, None)),
        (4, frames::cursors_frame(&d, &cursors, Some(&ahead))),
        (5, frames::event_frame(&event_wire)),
        (7, frames::digest_frame("", &cursors, &digests, None)),
        (
            8,
            frames::digest_frame(acme, &cursors, &digests, Some(&ahead)),
        ),
        (9, frames::snap_request_frame(None)),
        (10, frames::snap_request_frame(Some(acme))),
        (
            11,
            frames::snap_manifest_frame("snap-1", 2, 5, &cursors, None, None),
        ),
        (
            12,
            frames::snap_manifest_frame(
                "snap-1",
                2,
                5,
                &cursors,
                Some(acme),
                Some(&[0xc0, 0xc1, 0xc2, 0xc3]),
            ),
        ),
        (
            13,
            frames::snap_chunk_frame(
                "snap-1",
                0,
                &std::array::from_fn::<u8, 8, _>(|i| 0xa0 + i as u8),
            ),
        ),
        (14, frames::snap_ack_frame("snap-1", &[])),
        (15, frames::snap_ack_frame("snap-1", &[1])),
        (16, frames::receipt_frame(&receipt_wire)),
        (
            17,
            frames::routes_frame(&[RouteAd {
                to: o.as_str().to_owned(),
                hops: 2,
                expires_at_ms: now + 60_000.0,
            }]),
        ),
    ];
    for (i, bytes) in expected {
        assert_eq!(to_hex(&bytes), to_hex(&wires[i]), "vector {i}");
    }

    // the fields a receiver acts on
    match frames::decode_frame(&wires[4]).unwrap() {
        Frame::Cursors {
            from,
            cursors: c,
            ahead: a,
        } => {
            assert_eq!(from, d);
            assert_eq!(c, cursors);
            assert_eq!(a, Some(ahead.clone()));
        }
        f => panic!("expected cursors, got {}", f.kind()),
    }
    match frames::decode_frame(&wires[8]).unwrap() {
        Frame::Digest {
            scope,
            at,
            digests: ds,
            ahead: a,
        } => {
            assert_eq!(scope, acme);
            assert_eq!(at, cursors);
            assert_eq!(ds[0].1.as_u64(), Some(0xdeadbeef));
            assert_eq!(a, Some(ahead));
        }
        f => panic!("expected digest, got {}", f.kind()),
    }
    match frames::decode_frame(&wires[12]).unwrap() {
        Frame::Snapshot(SnapshotFrame::Manifest {
            id,
            chunks,
            rows,
            scope,
            certificate,
            ..
        }) => {
            assert_eq!((id.as_str(), chunks, rows), ("snap-1", 2, 5));
            assert_eq!(scope.as_deref(), Some(acme));
            assert_eq!(certificate, Some(vec![0xc0, 0xc1, 0xc2, 0xc3]));
        }
        f => panic!("expected manifest, got {}", f.kind()),
    }
    match frames::decode_frame(&wires[11]).unwrap() {
        Frame::Snapshot(SnapshotFrame::Manifest {
            scope, certificate, ..
        }) => {
            assert_eq!(scope, None);
            assert_eq!(certificate, None);
        }
        f => panic!("expected manifest, got {}", f.kind()),
    }
    // the presence wire rides unopened, exactly as signed
    match frames::decode_frame(&wires[6]).unwrap() {
        Frame::Presence { wire } => assert_eq!(frames::presence_frame(&wire), wires[6]),
        f => panic!("expected presence, got {}", f.kind()),
    }
}

#[test]
fn length_framing_is_four_big_endian_bytes_then_the_frame() {
    let doc = vectors("frame-vectors.json");
    let f = &doc["framing"];
    assert_eq!(
        f["lengthBytes"].as_u64(),
        Some(framing::LENGTH_BYTES as u64)
    );
    assert_eq!(f["byteOrder"].as_str(), Some("big-endian"));
    assert_eq!(
        f["defaultMaxFrameBytes"].as_u64(),
        Some(framing::DEFAULT_MAX_FRAME_BYTES as u64)
    );
    let frame = hex(&f["example"], "frameHex");
    let framed = hex(&f["example"], "framedHex");
    assert_eq!(
        framing::frame_with_length(&frame, framing::DEFAULT_MAX_FRAME_BYTES).unwrap(),
        framed
    );
    let device = Identity::from_seed(&seed(200));
    assert_eq!(
        frames::grant_request_frame(device.peer_id(), Some("inv-7")),
        frame
    );

    // read back one byte at a time
    let mut reader = FrameReader::default();
    let mut out = Vec::new();
    for b in &framed {
        reader.push(std::slice::from_ref(b));
        out.extend(reader.drain().0);
    }
    assert_eq!(out, vec![frame]);
}

#[test]
fn relay_control_frames_decode_to_their_kind_and_reencode_byte_for_byte() {
    let doc = vectors("relay-vectors.json");
    let spoken: Vec<u64> = doc["protocolVersions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap())
        .collect();
    assert_eq!(spoken, RELAY_PROTOCOL_VERSIONS.to_vec());

    let mut tags = Vec::new();
    for v in doc["vectors"].as_array().unwrap() {
        let what = v["description"].as_str().unwrap();
        let wire = hex(v, "wireHex");
        let tag = v["tag"].as_u64().unwrap();
        let parts = syncmesh_core::decode_cbor(&wire).unwrap();
        assert_eq!(
            parts.as_array().and_then(|p| p[0].as_int()),
            Some(tag as i64),
            "{what}"
        );
        let frame = decode_relay_frame(&wire).unwrap_or_else(|e| panic!("{what}: {e}"));
        assert_eq!(frame.kind(), v["kind"].as_str().unwrap(), "{what}");
        assert_eq!(
            to_hex(&frame.encode().expect("known")),
            to_hex(&wire),
            "{what}"
        );
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags.sort();
    assert_eq!(
        tags,
        (8..=19).collect::<Vec<u64>>(),
        "control tags 8–19, no gaps"
    );
}

#[test]
fn relay_control_frames_are_reproduced_from_the_generator_inputs() {
    let doc = vectors("relay-vectors.json");
    let wires: Vec<Vec<u8>> = doc["vectors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| hex(v, "wireHex"))
        .collect();
    let p = peer(&to_hex(&std::array::from_fn::<u8, 32, _>(|i| i as u8)));
    let cursors = vec![(p.clone(), seq(7))];
    let floor = vec![(p.clone(), seq(4))];
    let (grant, event, bytes, hash) = (
        [0xa1, 0xb2, 0xc3],
        [1, 2, 3, 4],
        [0xde, 0xad, 0xbe, 0xef],
        "b3:0102",
    );
    let nonce: [u8; 32] = std::array::from_fn(|i| i as u8);
    let expected: Vec<(usize, Vec<u8>)> = vec![
        (0, relay_frames::join_frame(&[1], &p, &cursors, None, None)),
        (
            1,
            relay_frames::join_frame(
                &[1, 2],
                &p,
                &cursors,
                Some(r#"{"partitions":["org:acme"]}"#),
                None,
            ),
        ),
        (
            4,
            relay_frames::hello_frame(1, 15_000, "epoch-1", &cursors, &[]),
        ),
        (
            5,
            relay_frames::hello_frame(1, 15_000, "epoch-1", &cursors, &floor),
        ),
        (
            6,
            relay_frames::error_frame("version", "this relay speaks 2"),
        ),
        (
            7,
            relay_frames::error_frame("unproven", "the join was not signed by the key it names"),
        ),
        (8, relay_frames::ka_frame()),
        (9, relay_frames::ack_frame("evt-1", 3)),
        (
            10,
            relay_frames::page_frame(&[grant.to_vec()], &[event.to_vec()], true, 9, None),
        ),
        (
            11,
            relay_frames::page_frame(&[], &[event.to_vec()], false, 9, None),
        ),
        (12, relay_frames::relayed_frame(&event, 4)),
        (13, relay_frames::blob_put_frame(hash, &bytes)),
        (14, relay_frames::blob_get_frame(hash)),
        (15, relay_frames::blob_frame(hash, &bytes)),
        (16, relay_frames::blob_missing_frame(hash)),
        (17, relay_frames::challenge_frame(&nonce)),
    ];
    for (i, b) in expected {
        assert_eq!(to_hex(&b), to_hex(&wires[i]), "vector {i}");
    }

    match decode_relay_frame(&wires[5]).unwrap() {
        RelayFrame::Hello {
            version,
            keepalive_ms,
            epoch,
            cursors: c,
            floor: f,
        } => {
            assert_eq!(
                (version, keepalive_ms, epoch.as_str()),
                (1, 15_000, "epoch-1")
            );
            assert_eq!(c, cursors);
            assert_eq!(f, floor);
        }
        f => panic!("expected hello, got {}", f.kind()),
    }
    match decode_relay_frame(&wires[1]).unwrap() {
        RelayFrame::Join(j) => {
            assert_eq!(j.versions, vec![1, 2]);
            assert_eq!(
                j.interest.as_deref(),
                Some(r#"{"partitions":["org:acme"]}"#)
            );
            assert_eq!(j.proof, None);
        }
        f => panic!("expected join, got {}", f.kind()),
    }
    match decode_relay_frame(&wires[10]).unwrap() {
        RelayFrame::Page {
            grants,
            events,
            more,
            offset,
            scoped,
        } => {
            assert_eq!(
                (grants, events, more, offset),
                (vec![grant.to_vec()], vec![event.to_vec()], true, 9)
            );
            assert_eq!(scoped, None);
        }
        f => panic!("expected page, got {}", f.kind()),
    }
}

#[test]
fn join_proofs_verify_under_the_device_key_and_resign_byte_for_byte() {
    let doc = vectors("join-vectors.json");
    let device = Identity::from_seed(&seed(200));
    assert_eq!(doc["deviceId"].as_str(), Some(device.peer_id().as_str()));
    let nonce = hex(&doc, "nonceHex");

    match decode_relay_frame(&hex(&doc, "challengeHex")).unwrap() {
        RelayFrame::Challenge { nonce: n } => assert_eq!(n.to_vec(), nonce),
        f => panic!("expected a challenge, got {}", f.kind()),
    }
    assert_eq!(
        relay_frames::challenge_frame(&nonce),
        hex(&doc, "challengeHex")
    );

    let list = doc["vectors"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    let inputs = [vec![], vec![(device.peer_id().clone(), seq(7))]];
    for (v, cursors) in list.iter().zip(inputs) {
        let what = v["description"].as_str().unwrap();
        let (core, proof, join) = (hex(v, "coreHex"), hex(v, "proofHex"), hex(v, "joinHex"));

        // the room recomputes the core from what it decoded and lands on the sender's bytes
        let RelayFrame::Join(decoded) = decode_relay_frame(&join).unwrap() else {
            panic!("{what}: expected a join");
        };
        assert_eq!(to_hex(&decoded.core), to_hex(&core), "{what}");
        assert_eq!(decoded.proof.as_deref(), Some(proof.as_slice()), "{what}");
        assert_eq!(&decoded.peer_id, device.peer_id(), "{what}");
        assert_eq!(decoded.versions, vec![2]);
        assert_eq!(decoded.cursors, cursors);
        assert!(
            verify_join_proof(&decoded.peer_id, &nonce, &decoded.core, &proof),
            "{what}"
        );
        // and not against a different challenge, nor a different body
        assert!(!verify_join_proof(
            &decoded.peer_id,
            &[0; 32],
            &decoded.core,
            &proof
        ));
        assert!(!verify_join_proof(
            &decoded.peer_id,
            &nonce,
            &decoded.core[1..],
            &proof
        ));

        // Ed25519 is deterministic: the same inputs sign to the same proof, and frame to the same join
        let rebuilt = relay_frames::join_core(&[2], device.peer_id(), &cursors, None);
        assert_eq!(rebuilt, core, "{what}");
        let signed = prove_join(&device, &nonce, &rebuilt);
        assert_eq!(to_hex(&signed), to_hex(&proof), "{what}");
        assert_eq!(
            relay_frames::join_frame(&[2], device.peer_id(), &cursors, None, Some(&signed)),
            join,
            "{what}"
        );
        assert_eq!(RelayFrame::Join(decoded).encode(), Some(join));
    }
}
