//! The link handshake against `conformance/handshake-vectors.json`: hellos from the seeds and
//! ephemeral secrets, both session keys, and the sealed frame, byte for byte (D35 slice 4).

use std::path::PathBuf;

use syncmesh_core::handshake::{
    self, HELLO_BYTES, HandshakeFailed, read_hello, seal, session_keys, unseal, write_hello,
};
use syncmesh_core::identity::Identity;
use syncmesh_core::{from_hex, to_hex};

fn vectors() -> serde_json::Value {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "..",
        "conformance",
        "handshake-vectors.json",
    ]
    .iter()
    .collect();
    serde_json::from_str(&std::fs::read_to_string(&path).expect("vectors")).expect("json")
}

fn hex(v: &serde_json::Value, key: &str) -> Vec<u8> {
    from_hex(v[key].as_str().expect(key)).expect("hex")
}

fn arr<const N: usize>(v: &serde_json::Value, key: &str) -> [u8; N] {
    hex(v, key).try_into().expect("length")
}

/// `seed(n)` in the TypeScript fixtures: bytes `n, n+1, …` mod 256.
fn seed(n: u8) -> [u8; 32] {
    std::array::from_fn(|i| n.wrapping_add(i as u8))
}

#[test]
fn hellos_are_reproduced_from_the_seeds_and_secrets() {
    let doc = vectors();
    assert_eq!(
        doc["context"]["hello"].as_str().unwrap().as_bytes(),
        handshake::CONTEXT
    );
    assert_eq!(
        doc["context"]["session"].as_str().unwrap().as_bytes(),
        handshake::INFO
    );
    let a = Identity::from_seed(&seed(200));
    let b = Identity::from_seed(&seed(121));
    let (a_secret, b_secret) = (arr::<32>(&doc, "aSecretHex"), arr::<32>(&doc, "bSecretHex"));
    assert_eq!(a_secret, std::array::from_fn(|i| 0x40 + i as u8));
    assert_eq!(b_secret, std::array::from_fn(|i| 0x80 + i as u8));

    let hello_a = write_hello(&a, &a_secret);
    let hello_b = write_hello(&b, &b_secret);
    assert_eq!(to_hex(&hello_a.frame), doc["helloAHex"].as_str().unwrap());
    assert_eq!(to_hex(&hello_b.frame), doc["helloBHex"].as_str().unwrap());

    // each hello is well-signed by the key that is its peer id
    let read_a = read_hello(&hex(&doc, "helloAHex")).unwrap();
    let read_b = read_hello(&hex(&doc, "helloBHex")).unwrap();
    assert_eq!(read_a.peer_id.as_str(), doc["aId"].as_str().unwrap());
    assert_eq!(read_b.peer_id.as_str(), doc["bId"].as_str().unwrap());
    assert_eq!(read_a, hello_a);
    assert_eq!(read_b, hello_b);
}

#[test]
fn both_ends_derive_the_same_session_keys_crossed() {
    let doc = vectors();
    let a = read_hello(&hex(&doc, "helloAHex")).unwrap();
    let b = read_hello(&hex(&doc, "helloBHex")).unwrap();
    let keys_a = session_keys(&arr(&doc, "aSecretHex"), &a, &b).unwrap();
    let keys_b = session_keys(&arr(&doc, "bSecretHex"), &b, &a).unwrap();
    assert_eq!(to_hex(&keys_a.seal), doc["aSealKeyHex"].as_str().unwrap());
    assert_eq!(to_hex(&keys_b.seal), doc["bSealKeyHex"].as_str().unwrap());
    assert_eq!(keys_a.open, keys_b.seal);
    assert_eq!(keys_b.open, keys_a.seal);

    // a machine in the middle that swapped B's ephemeral ends with a different key, or none
    let mitm = write_hello(&Identity::from_seed(&seed(121)), &[0x33; 32]);
    let swapped = session_keys(&arr(&doc, "aSecretHex"), &a, &mitm).unwrap();
    assert_ne!(swapped.seal, keys_a.seal);
}

#[test]
fn the_sealed_frame_is_reproducible_and_opens_only_at_the_far_end() {
    let doc = vectors();
    let (a_key, b_key) = (
        arr::<32>(&doc, "aSealKeyHex"),
        arr::<32>(&doc, "bSealKeyHex"),
    );
    let nonce = arr::<24>(&doc, "nonceHex");
    let plaintext = hex(&doc, "plaintextHex");
    assert_eq!(plaintext, b"hello, room");

    let sealed = seal(&a_key, &plaintext, &nonce).unwrap();
    assert_eq!(to_hex(&sealed), doc["sealedByAHex"].as_str().unwrap());
    assert_eq!(sealed.len(), plaintext.len() + handshake::SEAL_OVERHEAD);
    assert_eq!(unseal(&a_key, &sealed), Ok(plaintext));
    // not under the other direction's key
    assert_eq!(unseal(&b_key, &sealed), Err(HandshakeFailed::DidNotOpen));
    // nor with any byte flipped: nonce, ciphertext or tag
    for i in 1..sealed.len() {
        let mut tampered = sealed.clone();
        tampered[i] ^= 0x01;
        assert_eq!(
            unseal(&a_key, &tampered),
            Err(HandshakeFailed::DidNotOpen),
            "byte {i}"
        );
    }
    assert_eq!(
        unseal(&a_key, &sealed[..40]),
        Err(HandshakeFailed::NotSealed)
    );
}

#[test]
fn a_hello_with_one_byte_changed_is_not_a_hello() {
    let doc = vectors();
    let hello = hex(&doc, "helloAHex");
    assert_eq!(hello.len(), HELLO_BYTES);
    for i in 1..HELLO_BYTES {
        let mut tampered = hello.clone();
        tampered[i] ^= 0x01;
        assert_eq!(
            read_hello(&tampered),
            Err(HandshakeFailed::BadSignature),
            "byte {i}"
        );
    }
    assert_eq!(
        read_hello(&hello[..HELLO_BYTES - 1]),
        Err(HandshakeFailed::NotAHello {
            length: HELLO_BYTES - 1
        })
    );
}
