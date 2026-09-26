//! A grant: this device belongs to this account, with these rights, until then (D08).
//!
//! Core map keys, frozen by `conformance/grant-vectors.json`: `v`0 `account`1 `device`2 `role`3
//! `partitions`4 `issuedAt`5 `expiresAt`6 `claims`7 `keys`8. Signed by the issuing server, whose
//! key the verifier is configured with — the core does not name its own verifier.

use std::collections::BTreeMap;

use crate::cbor::{Key, MalformedCbor, Value, decode};
use crate::event::{PartitionKey, PeerId};
use crate::identity::{Identity, verify};
use crate::record::JsonValue;
use crate::signed::{Signed, SplitError, peer_from_bytes, safe_non_negative, sign_core, split};

const KEY_V: i64 = 0;
const KEY_ACCOUNT: i64 = 1;
const KEY_DEVICE: i64 = 2;
const KEY_ROLE: i64 = 3;
const KEY_PARTITIONS: i64 = 4;
const KEY_ISSUED_AT: i64 = 5;
const KEY_EXPIRES_AT: i64 = 6;
const KEY_CLAIMS: i64 = 7;
/// Additive: a build with no name for this key ignores it and holds no key, which is custody.
const KEY_KEYS: i64 = 8;

/// One partition's content key for one epoch, sealed to the grant's device. A list of these,
/// because after a rotation a device needs the newest epoch to write and the older ones to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WrappedKey {
    pub partition: PartitionKey,
    pub epoch: u64,
    pub wrapped: Vec<u8>,
}

/// What a grant says. The version is always 1; a core with any other is refused, not held.
#[derive(Debug, Clone, PartialEq)]
pub struct Grant {
    pub account: String,
    pub device: PeerId,
    pub role: Option<String>,
    pub partitions: Vec<PartitionKey>,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    /// Free-form facts the issuing server vouches for; `allow` rules read them.
    pub claims: BTreeMap<String, JsonValue>,
    /// Content keys for the sealed partitions this grant admits; empty for most grants, and an
    /// empty list is written as no key at all.
    pub keys: Vec<WrappedKey>,
}

impl Grant {
    pub const VERSION: i64 = 1;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantError {
    Cbor(MalformedCbor),
    Malformed(&'static str),
    /// The signature does not cover the received core, or is not the issuer's.
    BadSignature,
    /// Well-signed, but the caller's clock is past `expires_at_ms`.
    Expired {
        expires_at_ms: i64,
    },
}

impl std::fmt::Display for GrantError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GrantError::Cbor(e) => write!(f, "{e}"),
            GrantError::Malformed(m) => write!(f, "malformed grant: {m}"),
            GrantError::BadSignature => {
                f.write_str("signature does not cover the received core, or is not the issuer's")
            }
            GrantError::Expired { expires_at_ms } => {
                write!(f, "grant expired at epoch ms {expires_at_ms}")
            }
        }
    }
}

impl std::error::Error for GrantError {}

impl From<SplitError> for GrantError {
    fn from(e: SplitError) -> Self {
        match e {
            SplitError::Cbor(c) => GrantError::Cbor(c),
            SplitError::Malformed(m) => GrantError::Malformed(m),
        }
    }
}

fn malformed<T>(m: &'static str) -> Result<T, GrantError> {
    Err(GrantError::Malformed(m))
}

fn json_to_cbor(v: &JsonValue) -> Value {
    match v {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(b) => Value::Bool(*b),
        JsonValue::Number(n) => Value::number(*n),
        JsonValue::Text(s) => Value::Text(s.clone()),
        JsonValue::Array(items) => Value::Array(items.iter().map(json_to_cbor).collect()),
        JsonValue::Object(o) => claims_to_cbor(o),
    }
}

fn claims_to_cbor(o: &BTreeMap<String, JsonValue>) -> Value {
    Value::Map(
        o.iter()
            .map(|(k, v)| (Key::Text(k.clone()), json_to_cbor(v)))
            .collect(),
    )
}

/// Claims are JSON all the way down: bytes anywhere, or a non-text key, refuse the grant.
fn json_from_cbor(v: &Value) -> Result<JsonValue, GrantError> {
    Ok(match v {
        Value::Null => JsonValue::Null,
        Value::Bool(b) => JsonValue::Bool(*b),
        Value::Int(n) => JsonValue::Number(*n as f64),
        Value::Float(f) => JsonValue::Number(*f),
        Value::Text(s) => JsonValue::Text(s.clone()),
        Value::Bytes(_) => return malformed("claims cannot carry bytes"),
        Value::Array(items) => {
            JsonValue::Array(items.iter().map(json_from_cbor).collect::<Result<_, _>>()?)
        }
        Value::Map(m) => {
            let mut o = BTreeMap::new();
            for (k, v) in m {
                let Key::Text(k) = k else {
                    return malformed("claim keys must be text");
                };
                o.insert(k.clone(), json_from_cbor(v)?);
            }
            JsonValue::Object(o)
        }
    })
}

fn core_value(grant: &Grant) -> Value {
    let mut core = vec![
        (Key::Int(KEY_V), Value::Int(Grant::VERSION)),
        (Key::Int(KEY_ACCOUNT), Value::Text(grant.account.clone())),
        (
            Key::Int(KEY_DEVICE),
            Value::Bytes(grant.device.key_bytes().to_vec()),
        ),
        (
            Key::Int(KEY_PARTITIONS),
            Value::Array(
                grant
                    .partitions
                    .iter()
                    .map(|p| Value::Text(p.as_str().to_owned()))
                    .collect(),
            ),
        ),
        (Key::Int(KEY_ISSUED_AT), Value::Int(grant.issued_at_ms)),
        (Key::Int(KEY_EXPIRES_AT), Value::Int(grant.expires_at_ms)),
        (Key::Int(KEY_CLAIMS), claims_to_cbor(&grant.claims)),
    ];
    if let Some(role) = &grant.role {
        core.push((Key::Int(KEY_ROLE), Value::Text(role.clone())));
    }
    if !grant.keys.is_empty() {
        core.push((
            Key::Int(KEY_KEYS),
            Value::Array(
                grant
                    .keys
                    .iter()
                    .map(|k| {
                        Value::Array(vec![
                            Value::Text(k.partition.as_str().to_owned()),
                            Value::Int(k.epoch as i64),
                            Value::Bytes(k.wrapped.clone()),
                        ])
                    })
                    .collect(),
            ),
        ));
    }
    Value::map(core)
}

/// The core bytes a grant signature covers.
pub fn encode_grant(grant: &Grant) -> Vec<u8> {
    crate::cbor::encode(&core_value(grant))
}

/// What an issuer is asked for; `issue_grant` turns it into a signed grant.
#[derive(Debug, Clone, PartialEq)]
pub struct GrantRequest {
    pub account: String,
    pub device: PeerId,
    pub role: Option<String>,
    pub partitions: Vec<PartitionKey>,
    pub claims: BTreeMap<String, JsonValue>,
    /// Already wrapped to `device`; the issuer holds the partition keys, the grant carries copies.
    pub keys: Vec<WrappedKey>,
    /// How long the grant holds. The TypeScript takes a `Temporal.Duration` and reads days as UTC
    /// calendar days, which in UTC are always exactly 86 400 000 ms — so milliseconds lose nothing.
    pub valid_for_ms: i64,
    pub now_ms: i64,
}

/// Mints a signed grant as wire bytes: `[core, sig]`, the envelope events use.
pub fn issue_grant(issuer: &Identity, request: &GrantRequest) -> Vec<u8> {
    let grant = Grant {
        account: request.account.clone(),
        device: request.device.clone(),
        role: request.role.clone(),
        partitions: request.partitions.clone(),
        issued_at_ms: request.now_ms,
        expires_at_ms: request.now_ms.saturating_add(request.valid_for_ms),
        claims: request.claims.clone(),
        keys: request.keys.clone(),
    };
    sign_core(issuer, &core_value(&grant))
}

/// Verifies the signature over the received core bytes under `issuer`, then decodes, then judges
/// expiry against the caller's `now_ms` (a grant is expired only once `now` is past
/// `expires_at_ms`). Never panics.
pub fn verify_grant(
    wire: &[u8],
    issuer: &PeerId,
    now_ms: i64,
) -> Result<Signed<Grant>, GrantError> {
    let (core, sig) = split(wire)?;
    if !verify(&core, &sig, &issuer.key_bytes()) {
        return Err(GrantError::BadSignature);
    }
    let grant = decode_grant_core(&core)?;
    if now_ms > grant.expires_at_ms {
        return Err(GrantError::Expired {
            expires_at_ms: grant.expires_at_ms,
        });
    }
    Ok(Signed {
        value: grant,
        wire: wire.to_vec(),
        core,
        sig,
    })
}

/// Which device a grant is for and when it was minted — enough to order two of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantOrigin {
    pub device: PeerId,
    pub issued_at_ms: i64,
}

/// Reads a grant's device and mint time *without* checking its signature, for a hop that routes
/// grants but holds no issuer key (the relay, D09/D14): it keys its cache by device so a re-issued
/// grant supersedes the one it replaces. No right may follow from this; anything that decides what
/// a device may do calls `verify_grant`.
pub fn read_grant_origin(wire: &[u8]) -> Result<GrantOrigin, GrantError> {
    let (core, _) = split(wire)?;
    let Value::Map(m) = decode(&core).map_err(GrantError::Cbor)? else {
        return malformed("core is not a map");
    };
    let Some(Value::Bytes(device)) = m.get(&Key::Int(KEY_DEVICE)) else {
        return malformed("device is not bytes");
    };
    let Some(issued_at_ms) = safe_non_negative(m.get(&Key::Int(KEY_ISSUED_AT))) else {
        return malformed("issuedAt is not epoch ms");
    };
    Ok(GrantOrigin {
        device: peer_from_bytes(device).map_err(GrantError::Malformed)?,
        issued_at_ms,
    })
}

/// Decodes a grant core without judging its signature or expiry; refuses `v ≠ 1`, ignores keys it
/// has no name for. The checks run in the TypeScript's order, so the same bytes fail with the
/// same message.
pub fn decode_grant_core(core: &[u8]) -> Result<Grant, GrantError> {
    let Value::Map(m) = decode(core).map_err(GrantError::Cbor)? else {
        return malformed("core is not a map");
    };
    let get = |k: i64| m.get(&Key::Int(k));
    if get(KEY_V) != Some(&Value::Int(Grant::VERSION)) {
        return malformed("unsupported version");
    }
    let account = match get(KEY_ACCOUNT) {
        Some(Value::Text(a)) if !a.is_empty() => a.clone(),
        _ => return malformed("account is not text"),
    };
    let Some(Value::Bytes(device)) = get(KEY_DEVICE) else {
        return malformed("device is not bytes");
    };
    let role = match get(KEY_ROLE) {
        None => None,
        Some(Value::Text(r)) => Some(r.clone()),
        Some(_) => return malformed("role is not text"),
    };
    let Some(Value::Array(partitions)) = get(KEY_PARTITIONS) else {
        return malformed("partitions is not a list");
    };
    let (Some(issued_at_ms), Some(expires_at_ms)) = (
        safe_non_negative(get(KEY_ISSUED_AT)),
        safe_non_negative(get(KEY_EXPIRES_AT)),
    ) else {
        return malformed("validity window is not two ordered epoch ms");
    };
    if issued_at_ms > expires_at_ms {
        return malformed("validity window is not two ordered epoch ms");
    }
    let device = peer_from_bytes(device).map_err(GrantError::Malformed)?;
    let partitions = partitions
        .iter()
        .map(|p| match p {
            Value::Text(p) => PartitionKey::parse(p).map_err(|e| GrantError::Malformed(e.message)),
            _ => malformed("partition is not text"),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let keys = decode_keys(get(KEY_KEYS))?;
    let claims = match json_from_cbor(get(KEY_CLAIMS).unwrap_or(&Value::Map(BTreeMap::new())))? {
        JsonValue::Object(o) => o,
        _ => return malformed("claims is not an object"),
    };
    Ok(Grant {
        account,
        device,
        role,
        partitions,
        issued_at_ms,
        expires_at_ms,
        claims,
        keys,
    })
}

/// `[[partition, epoch, wrapped], …]`, or nothing. Entries longer than three are read by their
/// first three, as the TypeScript destructures them.
fn decode_keys(value: Option<&Value>) -> Result<Vec<WrappedKey>, GrantError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Value::Array(entries) = value else {
        return malformed("keys is not a list");
    };
    entries
        .iter()
        .map(|entry| {
            let Some([partition, epoch, wrapped, ..]) = entry.as_array() else {
                return malformed("a key is not a triple");
            };
            let Value::Text(partition) = partition else {
                return malformed("a key's partition is not text");
            };
            let Some(epoch) = safe_non_negative(Some(epoch)) else {
                return malformed("a key's epoch is not a count");
            };
            let Value::Bytes(wrapped) = wrapped else {
                return malformed("a wrapped key is not bytes");
            };
            Ok(WrappedKey {
                partition: PartitionKey::parse(partition)
                    .map_err(|e| GrantError::Malformed(e.message))?,
                epoch: epoch as u64,
                wrapped: wrapped.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cbor::encode;
    use crate::envelope::envelope;

    const NOW: i64 = 1_700_000_000_000;
    const HOUR: i64 = 3_600_000;

    fn issuer() -> Identity {
        Identity::from_seed(&[1; 32])
    }

    fn device() -> PeerId {
        Identity::from_seed(&[2; 32]).peer_id().clone()
    }

    fn request() -> GrantRequest {
        GrantRequest {
            account: "acct_a".into(),
            device: device(),
            role: Some("member".into()),
            partitions: vec![PartitionKey::parse("org:acme").unwrap()],
            claims: BTreeMap::new(),
            keys: Vec::new(),
            valid_for_ms: HOUR,
            now_ms: NOW,
        }
    }

    fn signed(core: &Value) -> Vec<u8> {
        let bytes = encode(core);
        envelope(&bytes, &issuer().sign(&bytes))
    }

    #[test]
    fn round_trips_every_field_including_keys() {
        let mut req = request();
        req.claims.insert(
            "permissions".into(),
            JsonValue::Array(vec![JsonValue::Text("read".into()), JsonValue::Number(1.5)]),
        );
        req.keys = vec![WrappedKey {
            partition: PartitionKey::parse("org:acme").unwrap(),
            epoch: 3,
            wrapped: vec![9; 48],
        }];
        let wire = issue_grant(&issuer(), &req);
        let got = verify_grant(&wire, issuer().peer_id(), NOW).unwrap();
        assert_eq!(got.value.expires_at_ms, NOW + HOUR);
        assert_eq!(got.value.keys, req.keys);
        assert_eq!(got.value.claims, req.claims);
        assert_eq!(encode_grant(&got.value), got.core);
        assert_eq!(got.wire, wire);
    }

    #[test]
    fn expiry_is_judged_against_the_callers_clock() {
        let wire = issue_grant(&issuer(), &request());
        assert!(verify_grant(&wire, issuer().peer_id(), NOW + HOUR).is_ok());
        assert_eq!(
            verify_grant(&wire, issuer().peer_id(), NOW + HOUR + 1),
            Err(GrantError::Expired {
                expires_at_ms: NOW + HOUR
            })
        );
    }

    #[test]
    fn a_wrong_issuer_or_flipped_byte_is_a_bad_signature_and_garbage_is_a_value() {
        let wire = issue_grant(&issuer(), &request());
        assert_eq!(
            verify_grant(&wire, &device(), NOW),
            Err(GrantError::BadSignature)
        );
        let mut flipped = wire.clone();
        flipped[10] ^= 1;
        assert!(verify_grant(&flipped, issuer().peer_id(), NOW).is_err());
        for bad in [&[][..], &[0x80], &[0x82], &[0x82, 0x40, 0x41]] {
            assert!(verify_grant(bad, issuer().peer_id(), NOW).is_err());
        }
    }

    #[test]
    fn a_well_signed_core_with_the_wrong_shape_is_malformed() {
        let base = |extra: Vec<(Key, Value)>| {
            let mut m = vec![
                (Key::Int(0), Value::Int(1)),
                (Key::Int(1), Value::text("acct")),
                (Key::Int(2), Value::Bytes(device().key_bytes().to_vec())),
                (Key::Int(4), Value::Array(vec![])),
                (Key::Int(5), Value::Int(1)),
                (Key::Int(6), Value::Int(2)),
                (Key::Int(7), Value::map([])),
            ];
            m.extend(extra);
            Value::map(m)
        };
        let cases = [
            (
                vec![(Key::Int(4), Value::Array(vec![Value::text("acme")]))],
                "expected kind:id",
            ),
            (vec![(Key::Int(0), Value::Int(2))], "unsupported version"),
            (vec![(Key::Int(1), Value::text(""))], "account is not text"),
            (
                vec![(Key::Int(5), Value::Int(3))],
                "validity window is not two ordered epoch ms",
            ),
            (vec![(Key::Int(3), Value::Int(1))], "role is not text"),
            (
                vec![(Key::Int(7), Value::Bytes(vec![1]))],
                "claims cannot carry bytes",
            ),
            (
                vec![(Key::Int(7), Value::Array(vec![]))],
                "claims is not an object",
            ),
            (
                vec![(Key::Int(7), Value::map([(Key::Int(1), Value::Null)]))],
                "claim keys must be text",
            ),
            (vec![(Key::Int(8), Value::Int(1))], "keys is not a list"),
            (
                vec![(
                    Key::Int(8),
                    Value::Array(vec![Value::Array(vec![Value::text("org:a")])]),
                )],
                "a key is not a triple",
            ),
            (
                vec![(Key::Int(2), Value::Bytes(vec![0; 31]))],
                crate::event::HEX_ID_EXPECTED,
            ),
        ];
        for (extra, says) in cases {
            assert_eq!(
                verify_grant(&signed(&base(extra)), issuer().peer_id(), 0),
                Err(GrantError::Malformed(says)),
                "{says}"
            );
        }
        // absent claims read as an empty object; unknown keys are ignored
        let mut ok = base(vec![(Key::Int(99), Value::text("from a newer build"))]);
        if let Value::Map(m) = &mut ok {
            m.remove(&Key::Int(7));
        }
        let got = verify_grant(&signed(&ok), issuer().peer_id(), 0).unwrap();
        assert!(got.value.claims.is_empty());
        assert_ne!(encode_grant(&got.value), got.core);
    }

    #[test]
    fn origin_is_read_without_a_key() {
        let wire = issue_grant(&issuer(), &request());
        assert_eq!(
            read_grant_origin(&wire).unwrap(),
            GrantOrigin {
                device: device(),
                issued_at_ms: NOW
            }
        );
        assert!(read_grant_origin(&[0x82, 0x40, 0x40]).is_err());
    }
}
