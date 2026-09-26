//! An account link: this account claims this device, in this instance, from then (D21).
//!
//! Core map keys, frozen by `conformance/account-vectors.json`: `v`0 `account`1 `device`2 `op`3
//! `partition`4 `at`5; `6` is reserved for a future `label`. Every link is exactly these six pairs.
//! The account signs the core; the device's half of the mutual claim is the signature on the event
//! that carries it (`event.peer_id == core.device`), which is not this module's to check.
//!
//! No issuer and no clock: the account id *is* the public key the core is verified under, and a
//! link is a label, which does not lapse — `unlink` is the only thing that ends one.

use crate::cbor::{Key, MalformedCbor, Value, decode};
use crate::event::{AccountId, HEX_ID_EXPECTED, PartitionKey, PeerId};
use crate::hex::{from_hex, to_hex};
use crate::identity::{Identity, verify};
use crate::signed::{Signed, SplitError, peer_from_bytes, safe_non_negative, sign_core, split};

const KEY_V: i64 = 0;
const KEY_ACCOUNT: i64 = 1;
const KEY_DEVICE: i64 = 2;
const KEY_OP: i64 = 3;
const KEY_PARTITION: i64 = 4;
const KEY_AT: i64 = 5;

/// The verb, as the small integer it travels as: one byte rather than the seven `unlink` costs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LinkOp {
    Link,
    Unlink,
}

impl LinkOp {
    fn tag(self) -> i64 {
        match self {
            LinkOp::Link => 0,
            LinkOp::Unlink => 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountCore {
    pub op: LinkOp,
    /// The account's Ed25519 public key as hex — the verifier this core names.
    pub account: AccountId,
    pub device: PeerId,
    /// Which instance the claim holds in; inside the signed bytes, or a link replays elsewhere.
    pub partition: PartitionKey,
    pub at_ms: i64,
}

impl AccountCore {
    pub const VERSION: i64 = 1;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkError {
    Cbor(MalformedCbor),
    Malformed(&'static str),
    /// The signature does not cover the received core, or is not the account's.
    BadSignature,
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinkError::Cbor(e) => write!(f, "{e}"),
            LinkError::Malformed(m) => write!(f, "malformed link: {m}"),
            LinkError::BadSignature => {
                f.write_str("signature does not cover the received core, or is not the account's")
            }
        }
    }
}

impl std::error::Error for LinkError {}

impl From<SplitError> for LinkError {
    fn from(e: SplitError) -> Self {
        match e {
            SplitError::Cbor(c) => LinkError::Cbor(c),
            SplitError::Malformed(m) => LinkError::Malformed(m),
        }
    }
}

fn malformed<T>(m: &'static str) -> Result<T, LinkError> {
    Err(LinkError::Malformed(m))
}

/// The 32 key bytes an account id spells. An `AccountId` is 64 lowercase hex by construction.
pub fn account_key_bytes(account: &AccountId) -> [u8; 32] {
    from_hex(account.as_str())
        .ok()
        .and_then(|b| b.try_into().ok())
        .expect("an account id is 64 lowercase hex characters by construction")
}

fn core_value(core: &AccountCore) -> Value {
    Value::map([
        (Key::Int(KEY_V), Value::Int(AccountCore::VERSION)),
        (
            Key::Int(KEY_ACCOUNT),
            Value::Bytes(account_key_bytes(&core.account).to_vec()),
        ),
        (
            Key::Int(KEY_DEVICE),
            Value::Bytes(core.device.key_bytes().to_vec()),
        ),
        (Key::Int(KEY_OP), Value::Int(core.op.tag())),
        (
            Key::Int(KEY_PARTITION),
            Value::Text(core.partition.as_str().to_owned()),
        ),
        (Key::Int(KEY_AT), Value::Int(core.at_ms)),
    ])
}

/// The signed bytes of a link core: canonical, six pairs, no optional keys.
pub fn encode_account_core(core: &AccountCore) -> Vec<u8> {
    crate::cbor::encode(&core_value(core))
}

/// Signs a link core as wire bytes `[core, sig]`. `account` must be the keypair `core.account`
/// names — that hex is the key `verify_link` checks under, so any other key mints bytes nobody
/// will accept.
pub fn sign_link(account: &Identity, core: &AccountCore) -> Vec<u8> {
    sign_core(account, &core_value(core))
}

/// Decodes, then verifies the received core bytes under the account the core names. Never panics.
pub fn verify_link(wire: &[u8]) -> Result<Signed<AccountCore>, LinkError> {
    let (core, sig) = split(wire)?;
    let link = decode_account_core(&core)?;
    if !verify(&core, &sig, &account_key_bytes(&link.account)) {
        return Err(LinkError::BadSignature);
    }
    Ok(Signed {
        value: link,
        wire: wire.to_vec(),
        core,
        sig,
    })
}

/// Decodes a link core without judging its signature; refuses `v ≠ 1`, ignores unknown keys, and
/// checks in the TypeScript's order so the same bytes fail with the same message.
pub fn decode_account_core(core: &[u8]) -> Result<AccountCore, LinkError> {
    let Value::Map(m) = decode(core).map_err(LinkError::Cbor)? else {
        return malformed("core is not a map");
    };
    let get = |k: i64| m.get(&Key::Int(k));
    if get(KEY_V) != Some(&Value::Int(AccountCore::VERSION)) {
        return malformed("unsupported version");
    }
    let Some(Value::Bytes(account)) = get(KEY_ACCOUNT) else {
        return malformed("account is not bytes");
    };
    let Some(Value::Bytes(device)) = get(KEY_DEVICE) else {
        return malformed("device is not bytes");
    };
    let op = match get(KEY_OP) {
        Some(Value::Int(0)) => LinkOp::Link,
        Some(Value::Int(1)) => LinkOp::Unlink,
        _ => return malformed("op is not link or unlink"),
    };
    let Some(Value::Text(partition)) = get(KEY_PARTITION) else {
        return malformed("partition is not text");
    };
    let Some(at_ms) = safe_non_negative(get(KEY_AT)) else {
        return malformed("at is not epoch ms");
    };
    Ok(AccountCore {
        op,
        account: AccountId::parse(&to_hex(account))
            .map_err(|_| LinkError::Malformed(HEX_ID_EXPECTED))?,
        device: peer_from_bytes(device).map_err(LinkError::Malformed)?,
        partition: PartitionKey::parse(partition).map_err(|e| LinkError::Malformed(e.message))?,
        at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cbor::encode;
    use crate::envelope::envelope;

    fn alice() -> Identity {
        Identity::from_seed(&[11; 32])
    }

    fn core(op: LinkOp) -> AccountCore {
        AccountCore {
            op,
            account: AccountId::parse(alice().peer_id().as_str()).unwrap(),
            device: Identity::from_seed(&[12; 32]).peer_id().clone(),
            partition: PartitionKey::parse("org:acme").unwrap(),
            at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn round_trips_both_verbs_on_different_bytes() {
        let link = verify_link(&sign_link(&alice(), &core(LinkOp::Link))).unwrap();
        let unlink = verify_link(&sign_link(&alice(), &core(LinkOp::Unlink))).unwrap();
        assert_eq!(link.value, core(LinkOp::Link));
        assert_eq!(unlink.value.op, LinkOp::Unlink);
        assert_ne!(link.core, unlink.core);
        assert_eq!(encode_account_core(&link.value), link.core);
    }

    #[test]
    fn a_link_does_not_lapse() {
        let far = AccountCore {
            at_ms: 1_700_000_000_000 + 100 * 365 * 86_400_000,
            ..core(LinkOp::Link)
        };
        assert!(verify_link(&sign_link(&alice(), &far)).is_ok());
    }

    #[test]
    fn another_accounts_signature_is_refused_both_ways_round() {
        let bob = Identity::from_seed(&[13; 32]);
        let bytes = encode_account_core(&core(LinkOp::Link));
        assert_eq!(
            verify_link(&envelope(&bytes, &bob.sign(&bytes))),
            Err(LinkError::BadSignature)
        );
        let named_bob = AccountCore {
            account: AccountId::parse(bob.peer_id().as_str()).unwrap(),
            ..core(LinkOp::Link)
        };
        assert_eq!(
            verify_link(&sign_link(&alice(), &named_bob)),
            Err(LinkError::BadSignature)
        );
        // no flipped byte anywhere is a panic
        let wire = sign_link(&alice(), &core(LinkOp::Link));
        for i in 0..wire.len() {
            let mut bad = wire.clone();
            bad[i] ^= 0x40;
            assert!(verify_link(&bad).is_err());
        }
    }

    #[test]
    fn a_well_signed_core_with_the_wrong_shape_is_malformed_one_message_per_rung() {
        let alice_key = alice().public_key().to_vec();
        let with = |pairs: Vec<(i64, Value)>| {
            let mut m = vec![
                (Key::Int(0), Value::Int(1)),
                (Key::Int(1), Value::Bytes(alice_key.clone())),
                (Key::Int(2), Value::Bytes(vec![7; 32])),
                (Key::Int(3), Value::Int(0)),
                (Key::Int(4), Value::text("org:acme")),
                (Key::Int(5), Value::Int(0)),
            ];
            m.extend(pairs.into_iter().map(|(k, v)| (Key::Int(k), v)));
            let bytes = encode(&Value::map(m));
            envelope(&bytes, &alice().sign(&bytes))
        };
        let cases = [
            (vec![(0, Value::Int(2))], "unsupported version"),
            (vec![(1, Value::text("a"))], "account is not bytes"),
            (vec![(2, Value::Null)], "device is not bytes"),
            (vec![(3, Value::Int(7))], "op is not link or unlink"),
            (vec![(4, Value::Int(1))], "partition is not text"),
            (vec![(4, Value::text("acme"))], "expected kind:id"),
            (vec![(5, Value::Int(-1))], "at is not epoch ms"),
            (vec![(1, Value::Bytes(vec![1; 31]))], HEX_ID_EXPECTED),
        ];
        for (pairs, says) in cases {
            assert_eq!(verify_link(&with(pairs)), Err(LinkError::Malformed(says)));
        }
        assert!(verify_link(&with(vec![(6, Value::text("label"))])).is_ok());
    }
}
