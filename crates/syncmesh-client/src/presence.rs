//! The ephemeral tier (D16): a cursor, a typing flag, who-is-here. Signed like an event, so a
//! relay cannot forge one — and nothing else like an event: never appended, never folded, never
//! snapshotted, never in catch-up. The engine does not know this exists.
//!
//! Three layers, each a port: the codec (`wire/src/presence-codec.ts`, frozen by
//! `conformance/presence-vectors.json`), the store every hop keeps (`transport/src/presence.ts`)
//! and this device's own side (`client/src/presence.ts`). The TypeScript tier owns timers — a
//! heartbeat interval per topic — and this one owns none: the host asks `heartbeats_due` on its
//! tick and `next_heartbeat_ms` to know when the next tick is worth taking.

use std::collections::{BTreeMap, HashMap};

use syncmesh_core::cbor::{Key, MAX_SAFE_INTEGER, MalformedCbor, Value, decode, encode};
use syncmesh_core::envelope::{WireError, envelope, split_envelope};
use syncmesh_core::event::{PartitionKey, PeerId};
use syncmesh_core::identity::{Identity, verify};
use syncmesh_core::record::Row;
use syncmesh_core::row_codec::{row_from_cbor, row_to_cbor};
use syncmesh_core::to_hex;

/// Presence core map keys, in the same style as the event core (RFC-0002).
const KEY_V: i64 = 0;
const KEY_PEER_ID: i64 = 1;
const KEY_TOPIC: i64 = 2;
const KEY_PARTITION: i64 = 3;
const KEY_SESSION: i64 = 4;
const KEY_COUNT: i64 = 5;
const KEY_VALUE: i64 = 6;
const KEY_EXPIRES: i64 = 7;

/// One ephemeral value as it travels. The version is always 1; a core with any other is refused.
#[derive(Debug, Clone, PartialEq)]
pub struct Presence {
    pub peer_id: PeerId,
    /// The manifest topic this value belongs to.
    pub topic: String,
    pub partition: PartitionKey,
    /// Random per process start; with `count`, what makes a gossip loop terminate.
    pub session: String,
    /// Monotonic within a session: a receiver keeps the highest it has seen and drops the rest.
    pub count: u64,
    /// The value as its topic's shape; `None` is an explicit departure.
    pub value: Option<Row>,
    /// Epoch milliseconds after which this value is stale, whoever holds it.
    pub expires_ms: i64,
}

/// `encodePresenceCore`: keys 0..7 in order, the peer id as its 32 key bytes, the partition as
/// text, the value as a row map or `null`.
pub fn encode_presence_core(presence: &Presence) -> Vec<u8> {
    encode(&Value::map([
        (Key::Int(KEY_V), Value::Int(1)),
        (
            Key::Int(KEY_PEER_ID),
            Value::Bytes(presence.peer_id.key_bytes().to_vec()),
        ),
        (Key::Int(KEY_TOPIC), Value::text(&presence.topic)),
        (
            Key::Int(KEY_PARTITION),
            Value::text(presence.partition.as_str()),
        ),
        (Key::Int(KEY_SESSION), Value::text(&presence.session)),
        (Key::Int(KEY_COUNT), Value::number(presence.count as f64)),
        (
            Key::Int(KEY_VALUE),
            match &presence.value {
                Some(row) => row_to_cbor(row),
                None => Value::Null,
            },
        ),
        (Key::Int(KEY_EXPIRES), Value::Int(presence.expires_ms)),
    ]))
}

/// An ephemeral value together with the bytes it travels as; forward `wire`, never re-encode —
/// the decoder drops keys it has no name for, and the author's signature would then cover bytes
/// nobody sent.
#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedPresence {
    pub presence: Presence,
    pub wire: Vec<u8>,
}

pub fn sign_presence(presence: &Presence, identity: &Identity) -> VerifiedPresence {
    let core = encode_presence_core(presence);
    let wire = envelope(&core, &identity.sign(&core));
    VerifiedPresence {
        presence: presence.clone(),
        wire,
    }
}

/// Why some bytes are not a presence value. The TypeScript reports `MalformedPresence |
/// MalformedCbor`; here the two are one closed type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MalformedPresence {
    Cbor(MalformedCbor),
    Malformed(&'static str),
    /// The signature does not cover the received core under the peer id the core names.
    BadSignature,
}

impl std::fmt::Display for MalformedPresence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MalformedPresence::Cbor(e) => write!(f, "{e}"),
            MalformedPresence::Malformed(m) => write!(f, "malformed presence: {m}"),
            MalformedPresence::BadSignature => {
                f.write_str("signature does not cover the received core")
            }
        }
    }
}

impl std::error::Error for MalformedPresence {}

impl From<WireError> for MalformedPresence {
    fn from(e: WireError) -> Self {
        match e {
            WireError::Cbor(c) => MalformedPresence::Cbor(c),
            WireError::Envelope(m) | WireError::Event(m) => MalformedPresence::Malformed(m),
            WireError::BadSignature => MalformedPresence::BadSignature,
        }
    }
}

fn malformed<T>(message: &'static str) -> Result<T, MalformedPresence> {
    Err(MalformedPresence::Malformed(message))
}

/// `Number.isSafeInteger(v) && v >= 0` — the TypeScript's `isSafeNonNegative`.
fn safe_non_negative(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Int(n)) if (0..=MAX_SAFE_INTEGER).contains(n) => Some(*n),
        _ => None,
    }
}

/// `[core, sig]` → the value, only if the signature covers the received core bytes. Never panics.
pub fn decode_and_verify_presence(wire: &[u8]) -> Result<VerifiedPresence, MalformedPresence> {
    let (core, sig) = split_envelope(wire)?;
    let presence = decode_presence_core(&core)?;
    if !verify(&core, &sig, &presence.peer_id.key_bytes()) {
        return Err(MalformedPresence::BadSignature);
    }
    Ok(VerifiedPresence {
        presence,
        wire: wire.to_vec(),
    })
}

/// Decodes a core; refuses `v ≠ 1`; ignores unknown keys (the core is additive).
///
/// One place stricter than the TypeScript, which holds the partition as opaque text: a Rust
/// `PartitionKey` is `kind:id` by construction, so text that is not one is refused here as a
/// value. Every partition a syncmesh sender ever signs was parsed before it left, so the only
/// bytes this turns away are ones no peer wrote.
pub fn decode_presence_core(core: &[u8]) -> Result<Presence, MalformedPresence> {
    let value = decode(core).map_err(MalformedPresence::Cbor)?;
    let Value::Map(m) = value else {
        return malformed("core is not a map");
    };
    if m.get(&Key::Int(KEY_V)) != Some(&Value::Int(1)) {
        return malformed("unsupported version");
    }
    let Some(Value::Bytes(peer_bytes)) = m.get(&Key::Int(KEY_PEER_ID)) else {
        return malformed("peerId is not bytes");
    };
    let (Some(Value::Text(topic)), Some(Value::Text(partition)), Some(Value::Text(session))) = (
        m.get(&Key::Int(KEY_TOPIC)),
        m.get(&Key::Int(KEY_PARTITION)),
        m.get(&Key::Int(KEY_SESSION)),
    ) else {
        return malformed("topic, partition and session must be text");
    };
    let (Some(count), Some(expires_ms)) = (
        safe_non_negative(m.get(&Key::Int(KEY_COUNT))),
        safe_non_negative(m.get(&Key::Int(KEY_EXPIRES))),
    ) else {
        return malformed("count and expires must be non-negative integers");
    };
    let Ok(peer_id) = PeerId::parse(&to_hex(peer_bytes)) else {
        return malformed("peerId is not a 32-byte key");
    };
    let Ok(partition) = PartitionKey::parse(partition) else {
        return malformed("partition is not kind:id");
    };
    let value = match m.get(&Key::Int(KEY_VALUE)) {
        None | Some(Value::Null) => None,
        Some(raw) => {
            Some(row_from_cbor(Some(raw)).map_err(|e| MalformedPresence::Malformed(e.message))?)
        }
    };
    Ok(Presence {
        peer_id,
        topic: topic.clone(),
        partition,
        session: session.clone(),
        count: count as u64,
        value,
        expires_ms,
    })
}

/// One peer's current value for a topic, as a reader sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct PresenceEntry {
    pub peer_id: PeerId,
    pub value: Row,
    /// When this value was admitted here.
    pub at_ms: i64,
    pub expires_ms: i64,
    /// The bytes it arrived as, for a hop that forwards rather than re-signs.
    pub wire: Vec<u8>,
}

/// What an admitted value touched, so a reader knows which topic to re-read. The sans-IO form of
/// the TypeScript store's `subscribe`: `admit` records one of these per change and
/// `take_touched` hands the list over, so a host wakes exactly the readers that have news.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PresenceTouch {
    pub topic: String,
    pub partition: PartitionKey,
}

/// Sessions remembered for the loop-breaker before the oldest are forgotten.
pub const DEFAULT_SESSION_LIMIT: usize = 1000;

/// The ephemeral tier's one data structure, used at every hop (D16): last value per
/// `(topic, instance, peer)`, highest count per session, expiry on read. Nothing here queues —
/// a value that arrives while another is unread replaces it, which is what makes a stalled
/// socket receive the current cursor rather than a backlog of dead ones.
///
/// Reads take the clock and skip what has expired without mutating, so a shared `&PresenceStore`
/// answers the same as the TypeScript store answers after its prune; `prune` frees the memory
/// when the host chooses to.
#[derive(Debug)]
pub struct PresenceStore {
    held: BTreeMap<(String, PartitionKey), BTreeMap<PeerId, PresenceEntry>>,
    /// Highest count per session and when it was last refreshed, so the oldest can be forgotten.
    seen: HashMap<String, (u64, u64)>,
    /// Sessions by refresh order — the insertion order the TypeScript `Map` keeps for free.
    order: BTreeMap<u64, String>,
    tick: u64,
    session_limit: usize,
    touched: Vec<PresenceTouch>,
}

impl Default for PresenceStore {
    fn default() -> Self {
        PresenceStore::new()
    }
}

impl PresenceStore {
    pub fn new() -> PresenceStore {
        PresenceStore::with_session_limit(DEFAULT_SESSION_LIMIT)
    }

    pub fn with_session_limit(session_limit: usize) -> PresenceStore {
        PresenceStore {
            held: BTreeMap::new(),
            seen: HashMap::new(),
            order: BTreeMap::new(),
            tick: 0,
            session_limit,
            touched: Vec::new(),
        }
    }

    /// Takes a value if it is newer than what this peer's session already sent and not already
    /// stale; `false` means drop it — a gossip echo, a reordered frame, or a dead value. The
    /// conflation and the loop-breaker in one call (D16). A departure answers whether anything
    /// still live actually departed.
    pub fn admit(&mut self, verified: &VerifiedPresence, now_ms: i64) -> bool {
        let presence = &verified.presence;
        // a value already stale on arrival is not news, however new its count
        if presence.expires_ms <= now_ms {
            return false;
        }
        if let Some((last, _)) = self.seen.get(&presence.session)
            && presence.count <= *last
        {
            return false;
        }
        self.remember(&presence.session, presence.count);
        let slot = (presence.topic.clone(), presence.partition.clone());
        let touched = PresenceTouch {
            topic: presence.topic.clone(),
            partition: presence.partition.clone(),
        };
        let Some(value) = &presence.value else {
            let departed = match self.held.get_mut(&slot) {
                Some(peers) => {
                    let gone = peers
                        .remove(&presence.peer_id)
                        .is_some_and(|entry| entry.expires_ms > now_ms);
                    if peers.is_empty() {
                        self.held.remove(&slot);
                    }
                    gone
                }
                None => false,
            };
            if departed {
                self.touched.push(touched);
            }
            return departed;
        };
        self.held.entry(slot).or_default().insert(
            presence.peer_id.clone(),
            PresenceEntry {
                peer_id: presence.peer_id.clone(),
                value: value.clone(),
                at_ms: now_ms,
                expires_ms: presence.expires_ms,
                wire: verified.wire.clone(),
            },
        );
        self.touched.push(touched);
        true
    }

    fn remember(&mut self, session: &str, count: u64) {
        if let Some((_, tick)) = self.seen.remove(session) {
            self.order.remove(&tick);
        }
        self.tick += 1;
        self.seen.insert(session.to_owned(), (count, self.tick));
        self.order.insert(self.tick, session.to_owned());
        while self.seen.len() > self.session_limit {
            let Some((_, oldest)) = self.order.pop_first() else {
                break;
            };
            self.seen.remove(&oldest);
        }
    }

    /// Live values for a topic in an instance, expired ones skipped.
    pub fn peers(&self, topic: &str, partition: &PartitionKey, now_ms: i64) -> Vec<&PresenceEntry> {
        self.held
            .get(&(topic.to_owned(), partition.clone()))
            .map(|peers| {
                peers
                    .values()
                    .filter(|entry| entry.expires_ms > now_ms)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Every live value, for a hop that must hand a joiner the current state.
    pub fn all(&self, now_ms: i64) -> Vec<&PresenceEntry> {
        self.held
            .values()
            .flat_map(|peers| peers.values())
            .filter(|entry| entry.expires_ms > now_ms)
            .collect()
    }

    pub fn size(&self, now_ms: i64) -> usize {
        self.all(now_ms).len()
    }

    /// Forgets every value that has expired by `now_ms`. Reads already skip them; this is the
    /// memory, not the answer.
    pub fn prune(&mut self, now_ms: i64) {
        self.held.retain(|_, peers| {
            peers.retain(|_, entry| entry.expires_ms > now_ms);
            !peers.is_empty()
        });
    }

    /// The topic/instance pairs `admit` changed since the last call, in order, one per change.
    pub fn take_touched(&mut self) -> Vec<PresenceTouch> {
        std::mem::take(&mut self.touched)
    }
}

/// How long a departure published for an instance nothing was ever set on stays valid. A
/// departure needs only to outlive its trip; the TypeScript uses the topic's own TTL, which a
/// tier that never published there has no record of.
pub const DEFAULT_DEPARTURE_TTL_MS: i64 = 30_000;

#[derive(Debug, Clone)]
struct Published {
    value: Row,
    ttl_ms: i64,
    /// When this device last signed the value — the heartbeat clock starts here.
    last_ms: i64,
}

impl Published {
    /// A third of the TTL: two heartbeats may be lost before a live peer looks gone.
    fn interval_ms(&self) -> i64 {
        (self.ttl_ms / 3).max(1)
    }

    fn due_ms(&self) -> i64 {
        self.last_ms.saturating_add(self.interval_ms())
    }
}

/// This device's side of the ephemeral tier (D16), sans timers. Each value this device sets is
/// kept alive with a heartbeat at a third of its TTL, so a peer that stops moving stays present
/// and a peer that stops existing disappears on its own. Every signed value is admitted into the
/// tier's own store first, so `peers` includes this device once it has set a value — the
/// TypeScript does the same, and a reader should not need two paths for "me" and "them".
#[derive(Debug)]
pub struct PresenceTier {
    identity: Identity,
    session: String,
    count: u64,
    store: PresenceStore,
    /// This device's live values, so a heartbeat can re-send them and `stop` can clear them.
    mine: BTreeMap<(String, PartitionKey), Published>,
}

impl PresenceTier {
    /// `session` is random per process start (`crate::random::session_id`); the caller draws it
    /// so a test can pin one.
    pub fn new(identity: Identity, session: String) -> PresenceTier {
        PresenceTier {
            identity,
            session,
            count: 0,
            store: PresenceStore::new(),
            mine: BTreeMap::new(),
        }
    }

    pub fn peer_id(&self) -> &PeerId {
        self.identity.peer_id()
    }

    pub fn session(&self) -> &str {
        &self.session
    }

    pub fn store(&self) -> &PresenceStore {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut PresenceStore {
        &mut self.store
    }

    fn publish(
        &mut self,
        topic: &str,
        partition: &PartitionKey,
        value: Option<Row>,
        ttl_ms: i64,
        now_ms: i64,
    ) -> Vec<u8> {
        self.count += 1;
        let presence = Presence {
            peer_id: self.identity.peer_id().clone(),
            topic: topic.to_owned(),
            partition: partition.clone(),
            session: self.session.clone(),
            count: self.count,
            value,
            expires_ms: now_ms.saturating_add(ttl_ms),
        };
        let signed = sign_presence(&presence, &self.identity);
        self.store.admit(&signed, now_ms);
        signed.wire
    }

    /// Publishes this device's current value; the wire returned goes to every open session and
    /// nowhere else, because a presence value that cannot leave is dropped rather than queued.
    pub fn set(
        &mut self,
        topic: &str,
        partition: &PartitionKey,
        value: Row,
        ttl_ms: i64,
        now_ms: i64,
    ) -> Vec<u8> {
        self.mine.insert(
            (topic.to_owned(), partition.clone()),
            Published {
                value: value.clone(),
                ttl_ms,
                last_ms: now_ms,
            },
        );
        self.publish(topic, partition, Some(value), ttl_ms, now_ms)
    }

    /// Explicit departure — a closing tab vanishes now rather than at TTL.
    pub fn clear(&mut self, topic: &str, partition: &PartitionKey, now_ms: i64) -> Vec<u8> {
        let ttl_ms = self
            .mine
            .remove(&(topic.to_owned(), partition.clone()))
            .map_or(DEFAULT_DEPARTURE_TTL_MS, |held| held.ttl_ms);
        self.publish(topic, partition, None, ttl_ms, now_ms)
    }

    /// Re-signs every live value whose last publish is a third of its TTL old, and returns the
    /// wires to send. The TypeScript runs one interval per topic; a host here calls this on its
    /// own tick, at or after `next_heartbeat_ms`.
    pub fn heartbeats_due(&mut self, now_ms: i64) -> Vec<Vec<u8>> {
        self.republish(now_ms, |held| held.due_ms() <= now_ms)
    }

    /// Re-signs every live value at `now_ms` whether or not a heartbeat is due, and restarts each
    /// heartbeat clock there. For a link that just came up: the far side knows nothing about us.
    pub fn announce_all(&mut self, now_ms: i64) -> Vec<Vec<u8>> {
        self.republish(now_ms, |_| true)
    }

    fn republish(&mut self, now_ms: i64, pick: impl Fn(&Published) -> bool) -> Vec<Vec<u8>> {
        let picked: Vec<((String, PartitionKey), Row, i64)> = self
            .mine
            .iter_mut()
            .filter(|(_, held)| pick(held))
            .map(|(slot, held)| {
                held.last_ms = now_ms;
                (slot.clone(), held.value.clone(), held.ttl_ms)
            })
            .collect();
        picked
            .into_iter()
            .map(|((topic, partition), value, ttl_ms)| {
                self.publish(&topic, &partition, Some(value), ttl_ms, now_ms)
            })
            .collect()
    }

    /// When the earliest heartbeat falls due, or `None` while nothing is published.
    pub fn next_heartbeat_ms(&self) -> Option<i64> {
        self.mine.values().map(Published::due_ms).min()
    }

    /// A frame arrived: admit it if it is news, and say so, so a gossiping hop knows to forward.
    pub fn receive(&mut self, wire: &[u8], now_ms: i64) -> bool {
        match decode_and_verify_presence(wire) {
            Ok(verified) => self.store.admit(&verified, now_ms),
            Err(_) => false,
        }
    }

    /// Everyone currently here, this device included once it has set a value.
    pub fn peers(&self, topic: &str, partition: &PartitionKey, now_ms: i64) -> Vec<&PresenceEntry> {
        self.store.peers(topic, partition, now_ms)
    }

    /// The topic/instance pairs changed since the last call — see `PresenceStore::take_touched`.
    pub fn take_touched(&mut self) -> Vec<PresenceTouch> {
        self.store.take_touched()
    }

    /// Departures for every value this device published, then nothing is left to heartbeat.
    pub fn stop(&mut self, now_ms: i64) -> Vec<Vec<u8>> {
        let mine = std::mem::take(&mut self.mine);
        mine.into_iter()
            .map(|((topic, partition), held)| {
                self.publish(&topic, &partition, None, held.ttl_ms, now_ms)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use syncmesh_core::from_hex;
    use syncmesh_core::record::CellValue;

    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    fn seed(start: u8) -> Identity {
        Identity::from_seed(&std::array::from_fn(|i| start + i as u8))
    }

    fn acme() -> PartitionKey {
        PartitionKey::parse("org:acme").unwrap()
    }

    fn cursor(x: f64, y: f64) -> Row {
        let mut row = Row::new();
        row.insert("x".to_owned(), CellValue::Number(x));
        row.insert("y".to_owned(), CellValue::Number(y));
        row
    }

    fn presence(identity: &Identity, session: &str, count: u64, value: Option<Row>) -> Presence {
        Presence {
            peer_id: identity.peer_id().clone(),
            topic: "cursor".to_owned(),
            partition: acme(),
            session: session.to_owned(),
            count,
            value,
            expires_ms: NOW + 60_000,
        }
    }

    fn vectors() -> serde_json::Value {
        let path: PathBuf = [
            env!("CARGO_MANIFEST_DIR"),
            "..",
            "..",
            "conformance",
            "presence-vectors.json",
        ]
        .iter()
        .collect();
        serde_json::from_str(
            &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
        )
        .expect("json")
    }

    #[test]
    fn core_round_trips_with_and_without_a_value() {
        let id = seed(9);
        for value in [Some(cursor(1.0, 2.5)), None] {
            let p = presence(&id, "s-x", 7, value);
            let core = encode_presence_core(&p);
            assert_eq!(decode_presence_core(&core).unwrap(), p);
            let signed = sign_presence(&p, &id);
            let back = decode_and_verify_presence(&signed.wire).unwrap();
            assert_eq!(back.presence, p);
            assert_eq!(back.wire, signed.wire);
        }
    }

    #[test]
    fn frozen_vectors_decode_verify_reencode_and_remint() {
        let doc = vectors();
        // `Uint8Array.from({ length: 32 }, (_, i) => 200 + i)`, the generator's seed
        let device = seed(200);
        assert_eq!(device.peer_id().as_str(), doc["peerId"].as_str().unwrap());
        let list = doc["vectors"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        for (i, v) in list.iter().enumerate() {
            let description = v["description"].as_str().unwrap();
            let wire = from_hex(v["wireHex"].as_str().unwrap()).unwrap();
            let core = from_hex(v["coreHex"].as_str().unwrap()).unwrap();
            let verified =
                decode_and_verify_presence(&wire).unwrap_or_else(|e| panic!("{description}: {e}"));
            let p = &verified.presence;
            assert_eq!(p.peer_id, *device.peer_id(), "{description}");
            assert_eq!(p.topic, v["topic"].as_str().unwrap(), "{description}");
            assert_eq!(p.partition.as_str(), v["partition"].as_str().unwrap());
            assert_eq!(p.session, v["session"].as_str().unwrap());
            assert_eq!(p.count, v["count"].as_u64().unwrap());
            assert_eq!(p.expires_ms, v["expires"].as_i64().unwrap());
            let expected = if i == 0 {
                Some(cursor(12.0, 34.0))
            } else {
                None
            };
            assert_eq!(p.value, expected, "{description}");
            assert_eq!(
                to_hex(&encode_presence_core(p)),
                to_hex(&core),
                "{description}: re-encode"
            );
            assert_eq!(
                to_hex(&sign_presence(p, &device).wire),
                to_hex(&wire),
                "{description}: Rust mints the frozen bytes"
            );
        }
    }

    #[test]
    fn foreign_bytes_are_values_not_panics() {
        let id = seed(9);
        let signed = sign_presence(&presence(&id, "s", 1, Some(cursor(1.0, 1.0))), &id);
        let mut tampered = signed.wire.clone();
        // the last byte of the signature
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(
            decode_and_verify_presence(&tampered),
            Err(MalformedPresence::BadSignature)
        );
        assert!(matches!(
            decode_and_verify_presence(&[0xff]),
            Err(MalformedPresence::Cbor(_))
        ));
        assert!(matches!(
            decode_and_verify_presence(&[0x80]),
            Err(MalformedPresence::Malformed(_))
        ));
        let mut wrong_version = presence(&id, "s", 1, None);
        wrong_version.expires_ms = NOW;
        let mut core = encode_presence_core(&wrong_version);
        // key 0 is first; its value byte follows: 0x01 → 0x02
        assert_eq!(core[1..3], [0x00, 0x01]);
        core[2] = 0x02;
        assert_eq!(
            decode_presence_core(&core),
            Err(MalformedPresence::Malformed("unsupported version"))
        );
        // an unknown key is ignored, a missing topic is not
        let extra = encode(&Value::map([
            (Key::Int(0), Value::Int(1)),
            (Key::Int(1), Value::Bytes(id.peer_id().key_bytes().to_vec())),
            (Key::Int(2), Value::text("t")),
            (Key::Int(3), Value::text("org:acme")),
            (Key::Int(4), Value::text("s")),
            (Key::Int(5), Value::Int(1)),
            (Key::Int(7), Value::Int(NOW)),
            (Key::Int(99), Value::text("from the future")),
        ]));
        assert!(decode_presence_core(&extra).is_ok());
        let missing = encode(&Value::map([
            (Key::Int(0), Value::Int(1)),
            (Key::Int(1), Value::Bytes(id.peer_id().key_bytes().to_vec())),
        ]));
        assert_eq!(
            decode_presence_core(&missing),
            Err(MalformedPresence::Malformed(
                "topic, partition and session must be text"
            ))
        );
    }

    #[test]
    fn store_conflates_by_session_count_and_departs_on_null() {
        let a = seed(11);
        let mut store = PresenceStore::new();
        let first = sign_presence(&presence(&a, "s-a", 2, Some(cursor(1.0, 1.0))), &a);
        let older = sign_presence(&presence(&a, "s-a", 1, Some(cursor(0.0, 0.0))), &a);
        assert!(store.admit(&first, NOW));
        assert!(!store.admit(&first, NOW), "an echo is not news");
        assert!(
            !store.admit(&older, NOW),
            "a reordered older count is dropped"
        );
        let peers = store.peers("cursor", &acme(), NOW);
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].value, cursor(1.0, 1.0));
        assert_eq!(peers[0].at_ms, NOW);
        assert_eq!(peers[0].wire, first.wire);
        assert_eq!(
            store.take_touched(),
            vec![PresenceTouch {
                topic: "cursor".into(),
                partition: acme()
            }]
        );

        let leave = sign_presence(&presence(&a, "s-a", 3, None), &a);
        assert!(store.admit(&leave, NOW), "something departed");
        assert!(store.peers("cursor", &acme(), NOW).is_empty());
        assert_eq!(store.take_touched().len(), 1);
        let leave_again = sign_presence(&presence(&a, "s-a", 4, None), &a);
        assert!(!store.admit(&leave_again, NOW), "nothing left to depart");
        assert!(store.take_touched().is_empty());
        assert_eq!(store.size(NOW), 0);
    }

    #[test]
    fn store_drops_stale_on_arrival_and_skips_expired_on_read() {
        let a = seed(11);
        let mut store = PresenceStore::new();
        let live = sign_presence(&presence(&a, "s-a", 1, Some(cursor(1.0, 1.0))), &a);
        assert!(
            !store.admit(&live, NOW + 60_000),
            "expired at arrival is not news"
        );
        assert!(store.admit(&live, NOW));
        assert_eq!(store.size(NOW + 59_999), 1);
        assert_eq!(store.size(NOW + 60_000), 0);
        assert!(store.peers("cursor", &acme(), NOW + 60_000).is_empty());
        assert!(store.all(NOW + 60_000).is_empty());
        store.prune(NOW + 60_000);
        assert!(store.held.is_empty());
        // a departure for a value that already expired departs nothing
        let leave = sign_presence(&presence(&a, "s-a", 2, None), &a);
        assert!(!store.admit(&leave, NOW + 60_000 - 1));
    }

    #[test]
    fn store_forgets_the_oldest_sessions_past_the_limit() {
        let a = seed(11);
        let mut store = PresenceStore::with_session_limit(2);
        let wire = |session: &str, count: u64| {
            sign_presence(&presence(&a, session, count, Some(cursor(1.0, 1.0))), &a)
        };
        assert!(store.admit(&wire("s-1", 5), NOW));
        assert!(store.admit(&wire("s-2", 5), NOW));
        // refreshing s-1 makes s-2 the oldest
        assert!(store.admit(&wire("s-1", 6), NOW));
        assert!(store.admit(&wire("s-3", 5), NOW));
        assert_eq!(store.seen.len(), 2);
        assert!(
            !store.admit(&wire("s-1", 6), NOW),
            "s-1 is still remembered"
        );
        assert!(
            store.admit(&wire("s-2", 1), NOW),
            "s-2 was forgotten, so an old count is news again"
        );
    }

    #[test]
    fn tier_publishes_admits_itself_and_receives_others() {
        let mut me = PresenceTier::new(seed(21), "s-me".to_owned());
        let mut you = PresenceTier::new(seed(22), "s-you".to_owned());
        let wire = me.set("cursor", &acme(), cursor(1.0, 2.0), 30_000, NOW);
        let verified = decode_and_verify_presence(&wire).unwrap();
        assert_eq!(verified.presence.peer_id, *me.peer_id());
        assert_eq!(verified.presence.session, "s-me");
        assert_eq!(verified.presence.count, 1);
        assert_eq!(verified.presence.expires_ms, NOW + 30_000);
        assert_eq!(
            me.peers("cursor", &acme(), NOW).len(),
            1,
            "peers include this device"
        );
        assert!(you.receive(&wire, NOW), "news for the other side");
        assert!(!you.receive(&wire, NOW), "an echo is not forwarded");
        assert!(!you.receive(b"junk", NOW));
        assert_eq!(you.peers("cursor", &acme(), NOW)[0].peer_id, *me.peer_id());
        assert_eq!(you.take_touched().len(), 1);

        let bye = me.clear("cursor", &acme(), NOW + 1);
        assert!(you.receive(&bye, NOW + 1));
        assert!(you.peers("cursor", &acme(), NOW + 1).is_empty());
        assert!(me.peers("cursor", &acme(), NOW + 1).is_empty());
        assert_eq!(me.next_heartbeat_ms(), None);
    }

    #[test]
    fn tier_heartbeats_at_a_third_of_the_ttl_and_stops_with_departures() {
        let mut me = PresenceTier::new(seed(21), "s-me".to_owned());
        let other = PartitionKey::parse("org:globex").unwrap();
        me.set("cursor", &acme(), cursor(1.0, 2.0), 30_000, NOW);
        me.set("typing", &other, cursor(0.0, 0.0), 9_000, NOW + 500);
        assert_eq!(me.next_heartbeat_ms(), Some(NOW + 3_500));
        assert!(me.heartbeats_due(NOW + 3_499).is_empty());
        let beats = me.heartbeats_due(NOW + 3_500);
        assert_eq!(beats.len(), 1);
        let beat = decode_and_verify_presence(&beats[0]).unwrap().presence;
        assert_eq!((beat.topic.as_str(), beat.count), ("typing", 3));
        assert_eq!(beat.expires_ms, NOW + 3_500 + 9_000);
        assert_eq!(
            me.next_heartbeat_ms(),
            Some(NOW + 6_500),
            "the typing beat is rescheduled"
        );
        let beats = me.heartbeats_due(NOW + 10_000);
        assert_eq!(beats.len(), 2, "both fall due");
        assert_eq!(me.store().size(NOW + 10_000), 2);

        let departures = me.stop(NOW + 10_001);
        assert_eq!(departures.len(), 2);
        for wire in &departures {
            assert_eq!(
                decode_and_verify_presence(wire).unwrap().presence.value,
                None
            );
        }
        assert_eq!(me.store().size(NOW + 10_001), 0);
        assert_eq!(me.next_heartbeat_ms(), None);
        assert!(me.heartbeats_due(NOW + 100_000).is_empty());
        assert!(me.stop(NOW + 100_000).is_empty());
    }

    #[test]
    fn a_sentinel_clock_saturates_instead_of_overflowing() {
        let mut me = PresenceTier::new(seed(21), "s-me".to_owned());
        me.set("cursor", &acme(), cursor(1.0, 2.0), 30_000, NOW);
        // before the fix this panicked in debug and wrapped to a negative expiry in release
        assert_eq!(me.heartbeats_due(i64::MAX).len(), 1);
        assert_eq!(
            me.next_heartbeat_ms(),
            Some(i64::MAX),
            "saturated, not wrapped"
        );
        assert_eq!(me.heartbeats_due(i64::MAX).len(), 1, "nor on the next tick");
    }
}
