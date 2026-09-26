//! The session frames every transport carries (`transport/src/frame.ts`, `frame-parts.ts`,
//! `snap-frame.ts`): `[tag, …]` in canonical CBOR, tags 0–8.
//!
//! Signed payloads — grants, events, presence, receipts — ride as the bytes they arrived in and
//! are never opened here: the frame is a carrier, and whoever acts on the payload verifies it
//! with the codec that owns it. A tag this build does not know is [`Frame::Unknown`], never an
//! error (D14's additive rule); a known tag with the wrong shape is a [`MalformedFrame`].
//!
//! Positions keep the order they travelled in. The TypeScript holds cursors in a `Map`, which
//! encodes in insertion order, so a Rust port that sorted them would write different bytes.

use std::collections::HashMap;
use std::hash::Hash;

use crate::cbor::{MAX_SAFE_INTEGER, MalformedCbor, Value, decode, encode};
use crate::event::{InvalidId, PeerId, SeqNum};
use crate::hex::to_hex;

/// Wire tags; the tag is also the traffic class (grants and cursors ahead of events).
pub mod tag {
    pub const GRANT: u8 = 0;
    pub const GRANT_REQUEST: u8 = 1;
    pub const CURSORS: u8 = 2;
    pub const EVENT: u8 = 3;
    pub const PRESENCE: u8 = 4;
    pub const DIGEST: u8 = 5;
    pub const SNAPSHOT: u8 = 6;
    /// A signed acknowledgement of durable custody; additive, so an older peer ignores it.
    pub const RECEIPT: u8 = 7;
    /// What this peer can reach, and how far away it is; additive like the rest.
    pub const ROUTES: u8 = 8;

    pub const ALL: [u8; 9] = [
        GRANT,
        GRANT_REQUEST,
        CURSORS,
        EVENT,
        PRESENCE,
        DIGEST,
        SNAPSHOT,
        RECEIPT,
        ROUTES,
    ];
}

/// The sub-kinds of the join exchange (RFC-0019), all under [`tag::SNAPSHOT`].
pub mod snap {
    pub const REQ: i64 = 0;
    pub const MANIFEST: i64 = 1;
    pub const CHUNK: i64 = 2;
    pub const ACK: i64 = 3;
}

/// Why some bytes are not a frame. The one refusal every frame decoder shares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MalformedFrame {
    Cbor(MalformedCbor),
    Shape(&'static str),
    Id(InvalidId),
}

impl std::fmt::Display for MalformedFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MalformedFrame::Cbor(e) => write!(f, "{e}"),
            MalformedFrame::Shape(m) => f.write_str(m),
            MalformedFrame::Id(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for MalformedFrame {}

pub(crate) fn shape<T>(message: &'static str) -> Result<T, MalformedFrame> {
    Err(MalformedFrame::Shape(message))
}

/// Per author, the highest sequence held — in the order it travelled.
pub type Cursors = Vec<(PeerId, SeqNum)>;

/// Per author, what is held above the cursor (D13) — in the order it travelled.
pub type Ahead = Vec<(PeerId, Vec<SeqNum>)>;

/// A table's fingerprint as the TypeScript holds it: a `bigint`, travelling as its hex.
///
/// Kept as the value's own hex (lowercase, no leading zeros) rather than as a `u64`, because the
/// decoder accepts any length the way `BigInt("0x…")` does, and a fingerprint this build could
/// not hold must still compare unequal to one it can rather than be refused or truncated.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Digest(String);

impl Digest {
    pub fn from_u64(n: u64) -> Digest {
        Digest(format!("{n:x}"))
    }

    /// `BigInt(\`0x${hex}\`)`: hex digits of either case, then optional trailing whitespace.
    /// `None` for anything that would throw there.
    pub fn parse(hex: &str) -> Option<Digest> {
        let digits = hex.trim_end_matches(char::is_whitespace);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let trimmed = digits.trim_start_matches('0');
        Some(Digest(if trimmed.is_empty() {
            "0".to_owned()
        } else {
            trimmed.to_ascii_lowercase()
        }))
    }

    /// What `digest.toString(16)` prints: the form it goes back on the wire in.
    pub fn as_hex(&self) -> &str {
        &self.0
    }

    /// The value, when it fits in 64 bits — which every digest this build computes does.
    pub fn as_u64(&self) -> Option<u64> {
        u64::from_str_radix(&self.0, 16).ok()
    }
}

/// What a route advertisement carries: where to, how far, and until when. The next hop is not on
/// the wire; it is whoever sent the frame, which the receiver already knows.
#[derive(Debug, Clone, PartialEq)]
pub struct RouteAd {
    pub to: String,
    pub hops: u64,
    /// Any JavaScript number: the TypeScript checks only that it is one.
    pub expires_at_ms: f64,
}

/// The join exchange (RFC-0019): `snap-req → snap-manifest → snap-chunk* → snap-ack`.
///
/// Interests travel as the JSON text they were written in. The TypeScript parses that text and
/// stringifies it again, which for anything it wrote itself is the identity; keeping the text
/// keeps the bytes without a JSON parser in this crate. Empty text is no interest.
#[derive(Debug, Clone, PartialEq)]
pub enum SnapshotFrame {
    /// "Send me state, not history" — narrowed to what this device wants.
    Request { interest: Option<String> },
    /// What is about to arrive, and the coverage it will stand for once all of it has.
    Manifest {
        id: String,
        chunks: u64,
        rows: u64,
        at: Cursors,
        /// The slice these rows are complete for; absent means the sender's whole state.
        scope: Option<String>,
        /// The authority's signed checkpoint over these rows, relayed unchanged.
        certificate: Option<Vec<u8>>,
    },
    /// One page of rows in the compact encoding, numbered so a lost one can be named.
    Chunk {
        id: String,
        index: u64,
        bytes: Vec<u8>,
    },
    /// Installed, or the chunks that never arrived — an empty list is the completion.
    Ack { id: String, missing: Vec<u64> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Grant {
        wire: Vec<u8>,
    },
    GrantRequest {
        peer_id: PeerId,
        invite: Option<String>,
    },
    Cursors {
        from: PeerId,
        cursors: Cursors,
        /// What they hold above those cursors; absent from an older build, which says nothing.
        ahead: Option<Ahead>,
    },
    Event {
        wire: Vec<u8>,
    },
    /// The ephemeral tier (D16): signed, never stored, dropped rather than queued.
    Presence {
        wire: Vec<u8>,
    },
    /// One fingerprint per table, with the slice and the position it was counted at.
    Digest {
        scope: String,
        at: Cursors,
        digests: Vec<(String, Digest)>,
        ahead: Option<Ahead>,
    },
    /// A signed acknowledgement of durable custody: held, not accepted.
    Receipt {
        wire: Vec<u8>,
    },
    Routes {
        ads: Vec<RouteAd>,
    },
    Snapshot(SnapshotFrame),
    /// A tag this build does not know; ignored, never an error.
    Unknown,
}

impl Frame {
    /// The TypeScript's `kind` discriminant, so logs and vectors name frames the same way.
    pub fn kind(&self) -> &'static str {
        match self {
            Frame::Grant { .. } => "grant",
            Frame::GrantRequest { .. } => "grant-request",
            Frame::Cursors { .. } => "cursors",
            Frame::Event { .. } => "event",
            Frame::Presence { .. } => "presence",
            Frame::Digest { .. } => "digest",
            Frame::Receipt { .. } => "receipt",
            Frame::Routes { .. } => "routes",
            Frame::Snapshot(SnapshotFrame::Request { .. }) => "snap-req",
            Frame::Snapshot(SnapshotFrame::Manifest { .. }) => "snap-manifest",
            Frame::Snapshot(SnapshotFrame::Chunk { .. }) => "snap-chunk",
            Frame::Snapshot(SnapshotFrame::Ack { .. }) => "snap-ack",
            Frame::Unknown => "unknown",
        }
    }

    /// The frame's bytes. `None` for [`Frame::Unknown`]: nothing of it was kept to write back.
    pub fn encode(&self) -> Option<Vec<u8>> {
        Some(match self {
            Frame::Grant { wire } => bytes_frame(tag::GRANT, wire),
            Frame::GrantRequest { peer_id, invite } => {
                grant_request_frame(peer_id, invite.as_deref())
            }
            Frame::Cursors {
                from,
                cursors,
                ahead,
            } => cursors_frame(from, cursors, ahead.as_deref()),
            Frame::Event { wire } => bytes_frame(tag::EVENT, wire),
            Frame::Presence { wire } => bytes_frame(tag::PRESENCE, wire),
            Frame::Digest {
                scope,
                at,
                digests,
                ahead,
            } => digest_frame(scope, at, digests, ahead.as_deref()),
            Frame::Receipt { wire } => bytes_frame(tag::RECEIPT, wire),
            Frame::Routes { ads } => routes_frame(ads),
            Frame::Snapshot(SnapshotFrame::Request { interest }) => {
                snap_request_frame(interest.as_deref())
            }
            Frame::Snapshot(SnapshotFrame::Manifest {
                id,
                chunks,
                rows,
                at,
                scope,
                certificate,
            }) => snap_manifest_frame(
                id,
                *chunks,
                *rows,
                at,
                scope.as_deref(),
                certificate.as_deref(),
            ),
            Frame::Snapshot(SnapshotFrame::Chunk { id, index, bytes }) => {
                snap_chunk_frame(id, *index, bytes)
            }
            Frame::Snapshot(SnapshotFrame::Ack { id, missing }) => snap_ack_frame(id, missing),
            Frame::Unknown => return None,
        })
    }
}

/// A count as a JavaScript number: an integer while it is safe, a float past that.
pub(crate) fn uint(n: u64) -> Value {
    if n <= MAX_SAFE_INTEGER as u64 {
        Value::Int(n as i64)
    } else {
        Value::Float(n as f64)
    }
}

fn tag_value(t: u8) -> Value {
    Value::Int(t as i64)
}

pub(crate) fn peer_value(peer: &PeerId) -> Value {
    Value::Bytes(peer.key_bytes().to_vec())
}

/// `[[peer, seq], …]` — the shape cursors take wherever a position travels.
pub fn cursor_pairs(cursors: &[(PeerId, SeqNum)]) -> Value {
    Value::Array(
        cursors
            .iter()
            .map(|(peer, seq)| Value::Array(vec![peer_value(peer), uint(seq.get())]))
            .collect(),
    )
}

/// `[[peer, [seq, …]], …]` — the other half of D13's pair. Additive: an older build reads the
/// element before it and stops, which is how it goes on meaning "I did not say".
pub fn ahead_pairs(ahead: &[(PeerId, Vec<SeqNum>)]) -> Value {
    Value::Array(
        ahead
            .iter()
            .map(|(peer, seqs)| {
                Value::Array(vec![
                    peer_value(peer),
                    Value::Array(seqs.iter().map(|s| uint(s.get())).collect()),
                ])
            })
            .collect(),
    )
}

fn bytes_frame(t: u8, wire: &[u8]) -> Vec<u8> {
    encode(&Value::Array(vec![
        tag_value(t),
        Value::Bytes(wire.to_vec()),
    ]))
}

pub fn grant_frame(wire: &[u8]) -> Vec<u8> {
    bytes_frame(tag::GRANT, wire)
}

pub fn event_frame(wire: &[u8]) -> Vec<u8> {
    bytes_frame(tag::EVENT, wire)
}

pub fn presence_frame(wire: &[u8]) -> Vec<u8> {
    bytes_frame(tag::PRESENCE, wire)
}

/// One signed custody receipt, on its way back to the author whose events it covers.
pub fn receipt_frame(wire: &[u8]) -> Vec<u8> {
    bytes_frame(tag::RECEIPT, wire)
}

pub fn grant_request_frame(peer_id: &PeerId, invite: Option<&str>) -> Vec<u8> {
    let mut items = vec![tag_value(tag::GRANT_REQUEST), peer_value(peer_id)];
    if let Some(invite) = invite {
        items.push(Value::text(invite));
    }
    encode(&Value::Array(items))
}

pub fn cursors_frame(
    from: &PeerId,
    cursors: &[(PeerId, SeqNum)],
    ahead: Option<&[(PeerId, Vec<SeqNum>)]>,
) -> Vec<u8> {
    let mut items = vec![
        tag_value(tag::CURSORS),
        peer_value(from),
        cursor_pairs(cursors),
    ];
    if let Some(ahead) = ahead {
        items.push(ahead_pairs(ahead));
    }
    encode(&Value::Array(items))
}

/// What the sender holds, and the two facts that make it comparable: the slice it counted and
/// the events it had folded when it counted them.
pub fn digest_frame(
    scope: &str,
    at: &[(PeerId, SeqNum)],
    digests: &[(String, Digest)],
    ahead: Option<&[(PeerId, Vec<SeqNum>)]>,
) -> Vec<u8> {
    let mut items = vec![
        tag_value(tag::DIGEST),
        Value::text(scope),
        cursor_pairs(at),
        Value::Array(
            digests
                .iter()
                .map(|(table, d)| Value::Array(vec![Value::text(table), Value::text(d.as_hex())]))
                .collect(),
        ),
    ];
    if let Some(ahead) = ahead {
        items.push(ahead_pairs(ahead));
    }
    encode(&Value::Array(items))
}

/// The sender's reachable destinations.
pub fn routes_frame(ads: &[RouteAd]) -> Vec<u8> {
    encode(&Value::Array(vec![
        tag_value(tag::ROUTES),
        Value::Array(
            ads.iter()
                .map(|ad| {
                    Value::Array(vec![
                        Value::text(&ad.to),
                        uint(ad.hops),
                        Value::number(ad.expires_at_ms),
                    ])
                })
                .collect(),
        ),
    ]))
}

pub fn snap_request_frame(interest: Option<&str>) -> Vec<u8> {
    encode(&Value::Array(vec![
        tag_value(tag::SNAPSHOT),
        Value::Int(snap::REQ),
        Value::text(interest.unwrap_or("")),
    ]))
}

pub fn snap_manifest_frame(
    id: &str,
    chunks: u64,
    rows: u64,
    at: &[(PeerId, SeqNum)],
    scope: Option<&str>,
    certificate: Option<&[u8]>,
) -> Vec<u8> {
    encode(&Value::Array(vec![
        tag_value(tag::SNAPSHOT),
        Value::Int(snap::MANIFEST),
        Value::text(id),
        uint(chunks),
        uint(rows),
        cursor_pairs(at),
        Value::text(scope.unwrap_or("")),
        // appended: a reader that predates certificates reads the first five and ignores this
        certificate.map_or(Value::Null, |c| Value::Bytes(c.to_vec())),
    ]))
}

pub fn snap_chunk_frame(id: &str, index: u64, bytes: &[u8]) -> Vec<u8> {
    encode(&Value::Array(vec![
        tag_value(tag::SNAPSHOT),
        Value::Int(snap::CHUNK),
        Value::text(id),
        uint(index),
        Value::Bytes(bytes.to_vec()),
    ]))
}

pub fn snap_ack_frame(id: &str, missing: &[u64]) -> Vec<u8> {
    encode(&Value::Array(vec![
        tag_value(tag::SNAPSHOT),
        Value::Int(snap::ACK),
        Value::text(id),
        Value::Array(missing.iter().map(|&m| uint(m)).collect()),
    ]))
}

/// The class of an encoded frame, without decoding it.
///
/// Every frame is `[kind, …]` and every session kind is a small integer, so the array header is
/// one byte and the tag is the next. Reading those two lets a session score a frame it is only
/// forwarding without paying for the payload twice. `None` for anything that is not one of ours,
/// which the caller treats as the ordinary class rather than as a refusal.
pub fn class_of(frame: &[u8]) -> Option<u8> {
    let (&header, &t) = (frame.first()?, frame.get(1)?);
    // 0x80 is CBOR's array major type; a tag above 23 would not be one byte, and none of ours is
    if header & 0xe0 != 0x80 || t > 23 {
        return None;
    }
    tag::ALL.contains(&t).then_some(t)
}

/// `isSafeNonNegative`: what the TypeScript accepts as a count. Decoded CBOR already holds any
/// integral float as an integer, so an integer is the only thing that can pass.
pub(crate) fn safe_count(v: Option<&Value>) -> Option<u64> {
    match v {
        Some(Value::Int(n)) if (0..=MAX_SAFE_INTEGER).contains(n) => Some(*n as u64),
        _ => None,
    }
}

pub(crate) fn as_text(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_text)
}

pub(crate) fn as_peer(v: Option<&Value>) -> Result<PeerId, MalformedFrame> {
    match v {
        Some(Value::Bytes(b)) => PeerId::parse(&to_hex(b)).map_err(MalformedFrame::Id),
        _ => shape("peer id is not bytes"),
    }
}

fn seq(v: Option<&Value>, not_integer: &'static str) -> Result<SeqNum, MalformedFrame> {
    let n = safe_count(v).ok_or(MalformedFrame::Shape(not_integer))?;
    SeqNum::parse(n).ok_or(MalformedFrame::Shape("expected a positive sequence number"))
}

/// `Map.set` as the TypeScript does it: a repeated key keeps its first position, takes the last value.
pub(crate) struct Ordered<K, V> {
    entries: Vec<(K, V)>,
    index: HashMap<K, usize>,
}

impl<K: Eq + Hash + Clone, V> Ordered<K, V> {
    pub(crate) fn new() -> Self {
        Ordered {
            entries: Vec::new(),
            index: HashMap::new(),
        }
    }

    pub(crate) fn set(&mut self, k: K, v: V) {
        match self.index.get(&k) {
            Some(&i) => self.entries[i].1 = v,
            None => {
                self.index.insert(k.clone(), self.entries.len());
                self.entries.push((k, v));
            }
        }
    }

    pub(crate) fn into_vec(self) -> Vec<(K, V)> {
        self.entries
    }
}

pub fn decode_cursor_pairs(v: Option<&Value>) -> Result<Cursors, MalformedFrame> {
    let Some(Value::Array(pairs)) = v else {
        return shape("cursors are not an array");
    };
    let mut cursors = Ordered::new();
    for pair in pairs {
        let Value::Array(pair) = pair else {
            return shape("cursor is not a pair");
        };
        if pair.len() != 2 {
            return shape("cursor is not a pair");
        }
        let peer = as_peer(pair.first())?;
        cursors.set(peer, seq(pair.get(1), "cursor seq is not an integer")?);
    }
    Ok(cursors.into_vec())
}

pub fn decode_ahead_pairs(v: Option<&Value>) -> Result<Ahead, MalformedFrame> {
    let Some(Value::Array(pairs)) = v else {
        return shape("ahead is not an array");
    };
    let mut ahead = Ordered::new();
    for pair in pairs {
        let Value::Array(pair) = pair else {
            return shape("ahead is not a pair");
        };
        if pair.len() != 2 {
            return shape("ahead is not a pair");
        }
        let peer = as_peer(pair.first())?;
        let Some(Value::Array(seqs)) = pair.get(1) else {
            return shape("ahead sequences are not an array");
        };
        let held = seqs
            .iter()
            .map(|s| seq(Some(s), "ahead seq is not an integer"))
            .collect::<Result<Vec<_>, _>>()?;
        ahead.set(peer, held);
    }
    Ok(ahead.into_vec())
}

/// Bytes → a session frame. Never panics; a tag this build does not know is `Ok(Frame::Unknown)`.
pub fn decode_frame(frame: &[u8]) -> Result<Frame, MalformedFrame> {
    let outer = decode(frame).map_err(MalformedFrame::Cbor)?;
    let Value::Array(outer) = outer else {
        return shape("expected [kind, …]");
    };
    if outer.len() < 2 {
        return shape("expected [kind, …]");
    }
    let payload = outer.get(1);
    let extra = outer.get(2);
    let Some(t) = outer[0].as_int().filter(|t| (0..=255).contains(t)) else {
        return Ok(Frame::Unknown);
    };
    let t = t as u8;
    if matches!(t, tag::GRANT | tag::EVENT | tag::PRESENCE | tag::RECEIPT) {
        let Some(Value::Bytes(wire)) = payload else {
            return shape("payload is not bytes");
        };
        let wire = wire.clone();
        return Ok(match t {
            tag::GRANT => Frame::Grant { wire },
            tag::EVENT => Frame::Event { wire },
            tag::RECEIPT => Frame::Receipt { wire },
            _ => Frame::Presence { wire },
        });
    }
    match t {
        tag::GRANT_REQUEST => {
            let peer_id = as_peer(payload)?;
            let invite = match extra {
                None => None,
                Some(Value::Text(s)) => Some(s.clone()),
                Some(_) => return shape("invite is not text"),
            };
            Ok(Frame::GrantRequest { peer_id, invite })
        }
        tag::CURSORS => {
            let from = as_peer(payload)?;
            let cursors = decode_cursor_pairs(extra)?;
            let ahead = outer
                .get(3)
                .map(|a| decode_ahead_pairs(Some(a)))
                .transpose()?;
            Ok(Frame::Cursors {
                from,
                cursors,
                ahead,
            })
        }
        tag::DIGEST => decode_digest(&outer),
        tag::ROUTES => decode_routes(payload),
        tag::SNAPSHOT => decode_snapshot(&outer),
        _ => Ok(Frame::Unknown),
    }
}

fn decode_digest(outer: &[Value]) -> Result<Frame, MalformedFrame> {
    let Some(scope) = as_text(outer.get(1)) else {
        return shape("digest scope is not text");
    };
    let Some(Value::Array(list)) = outer.get(3) else {
        return shape("digests are not an array");
    };
    let at = decode_cursor_pairs(outer.get(2))?;
    let mut digests = Ordered::new();
    for pair in list {
        let Value::Array(pair) = pair else {
            return shape("digest is not a pair");
        };
        if pair.len() != 2 {
            return shape("digest is not a pair");
        }
        let (Some(table), Some(hex)) = (as_text(pair.first()), as_text(pair.get(1))) else {
            return shape("digest is not [table, hex]");
        };
        // a fingerprint that does not parse is one this build cannot compare; refusing the whole
        // frame is right, because a partial comparison would look like agreement it never checked
        let digest =
            Digest::parse(hex).ok_or(MalformedFrame::Shape("digest is not hexadecimal"))?;
        digests.set(table.to_owned(), digest);
    }
    let ahead = outer
        .get(4)
        .map(|a| decode_ahead_pairs(Some(a)))
        .transpose()?;
    Ok(Frame::Digest {
        scope: scope.to_owned(),
        at,
        digests: digests.into_vec(),
        ahead,
    })
}

fn decode_routes(payload: Option<&Value>) -> Result<Frame, MalformedFrame> {
    let Some(Value::Array(entries)) = payload else {
        return shape("routes payload is not a list");
    };
    let mut ads = Vec::with_capacity(entries.len());
    for entry in entries {
        let Value::Array(entry) = entry else {
            return shape("route ad is not a triple");
        };
        if entry.len() < 3 {
            return shape("route ad is not a triple");
        }
        let Some(to) = as_text(entry.first()) else {
            return shape("route destination is not text");
        };
        let Some(hops) = safe_count(entry.get(1)) else {
            return shape("route hops is not a count");
        };
        let expires_at_ms = match &entry[2] {
            Value::Int(n) => *n as f64,
            Value::Float(f) => *f,
            _ => return shape("route expiry is not a timestamp"),
        };
        ads.push(RouteAd {
            to: to.to_owned(),
            hops,
            expires_at_ms,
        });
    }
    Ok(Frame::Routes { ads })
}

/// Empty text names no interest; anything else is kept as it travelled.
pub(crate) fn interest_text(v: Option<&Value>) -> Option<String> {
    as_text(v).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// `[6, sub, …]` — the sub-kind decides the rest; one this build does not know is ignored.
fn decode_snapshot(outer: &[Value]) -> Result<Frame, MalformedFrame> {
    let rest = |i: usize| outer.get(2 + i);
    let snapshot = match outer.get(1).and_then(Value::as_int) {
        Some(snap::REQ) => SnapshotFrame::Request {
            interest: interest_text(rest(0)),
        },
        Some(snap::MANIFEST) => {
            let Some(id) = as_text(rest(0)) else {
                return shape("snapshot id is not text");
            };
            let (Some(chunks), Some(rows)) = (safe_count(rest(1)), safe_count(rest(2))) else {
                return shape("manifest counts are not integers");
            };
            let at = decode_cursor_pairs(rest(3))?;
            SnapshotFrame::Manifest {
                id: id.to_owned(),
                chunks,
                rows,
                at,
                scope: interest_text(rest(4)),
                certificate: rest(5).and_then(Value::as_bytes).map(<[u8]>::to_vec),
            }
        }
        Some(snap::CHUNK) => {
            let Some(id) = as_text(rest(0)) else {
                return shape("snapshot id is not text");
            };
            let Some(index) = safe_count(rest(1)) else {
                return shape("chunk index is not an integer");
            };
            let Some(Value::Bytes(bytes)) = rest(2) else {
                return shape("chunk payload is not bytes");
            };
            SnapshotFrame::Chunk {
                id: id.to_owned(),
                index,
                bytes: bytes.clone(),
            }
        }
        Some(snap::ACK) => {
            let Some(id) = as_text(rest(0)) else {
                return shape("snapshot id is not text");
            };
            let Some(Value::Array(missing)) = rest(1) else {
                return shape("missing chunks are not an array");
            };
            let missing = missing
                .iter()
                .map(|m| {
                    safe_count(Some(m))
                        .ok_or(MalformedFrame::Shape("missing chunk is not an integer"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            SnapshotFrame::Ack {
                id: id.to_owned(),
                missing,
            }
        }
        _ => return Ok(Frame::Unknown),
    };
    Ok(Frame::Snapshot(snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex::from_hex;

    fn peer(n: u8) -> PeerId {
        PeerId::parse(&to_hex(&[n; 32])).unwrap()
    }

    fn seq(n: u64) -> SeqNum {
        SeqNum::parse(n).unwrap()
    }

    #[test]
    fn frames_round_trip_and_keep_their_order() {
        let cursors = vec![(peer(9), seq(7)), (peer(1), seq(3))];
        let ahead = vec![(peer(1), vec![seq(5), seq(6)])];
        let frame = Frame::Cursors {
            from: peer(9),
            cursors: cursors.clone(),
            ahead: Some(ahead),
        };
        let bytes = frame.encode().unwrap();
        assert_eq!(decode_frame(&bytes).unwrap(), frame);
        assert_eq!(class_of(&bytes), Some(tag::CURSORS));
    }

    #[test]
    fn an_unknown_tag_is_ignored_and_a_bad_shape_refused() {
        // [99, h'00']
        assert_eq!(
            decode_frame(&from_hex("8218634100").unwrap()).unwrap(),
            Frame::Unknown
        );
        // ["x", 1] — a kind that is not a number is not ours
        assert_eq!(
            decode_frame(&[0x82, 0x61, b'x', 0x01]).unwrap(),
            Frame::Unknown
        );
        // [3, "text"]: an event whose payload is not bytes
        assert_eq!(
            decode_frame(&[0x82, 0x03, 0x61, b'x']),
            Err(MalformedFrame::Shape("payload is not bytes"))
        );
        // [3]: nothing after the tag
        assert!(matches!(
            decode_frame(&[0x81, 0x03]),
            Err(MalformedFrame::Shape(_))
        ));
        // a frame cut short is the codec's refusal, not a panic
        let whole = event_frame(&[1, 2, 3, 4]);
        for cut in 0..whole.len() {
            assert!(matches!(
                decode_frame(&whole[..cut]),
                Err(MalformedFrame::Cbor(_))
            ));
        }
        // a cursor at sequence 0 is not a position
        let zero = encode(&Value::Array(vec![
            Value::Int(2),
            peer_value(&peer(1)),
            Value::Array(vec![Value::Array(vec![
                peer_value(&peer(1)),
                Value::Int(0),
            ])]),
        ]));
        assert!(decode_frame(&zero).is_err());
        // a peer id that is not 32 bytes
        let short = encode(&Value::Array(vec![Value::Int(1), Value::Bytes(vec![1, 2])]));
        assert!(matches!(decode_frame(&short), Err(MalformedFrame::Id(_))));
    }

    #[test]
    fn a_repeated_author_keeps_its_first_place_and_last_value() {
        let pair = |p: u8, s: i64| Value::Array(vec![peer_value(&peer(p)), Value::Int(s)]);
        let bytes = encode(&Value::Array(vec![
            Value::Int(2),
            peer_value(&peer(1)),
            Value::Array(vec![pair(1, 1), pair(2, 2), pair(1, 9)]),
        ]));
        let Frame::Cursors { cursors, .. } = decode_frame(&bytes).unwrap() else {
            panic!("expected cursors");
        };
        assert_eq!(cursors, vec![(peer(1), seq(9)), (peer(2), seq(2))]);
    }

    #[test]
    fn digests_read_as_bigint_does() {
        assert_eq!(Digest::parse("DEADbeef").unwrap().as_hex(), "deadbeef");
        assert_eq!(Digest::parse("000f").unwrap().as_hex(), "f");
        assert_eq!(Digest::parse("0").unwrap().as_hex(), "0");
        assert!(Digest::parse("").is_none());
        assert!(Digest::parse("0x1").is_none());
        assert!(Digest::parse("g").is_none());
        assert_eq!(Digest::from_u64(0xdeadbeef).as_u64(), Some(0xdeadbeef));
        assert_eq!(Digest::parse(&"f".repeat(40)).unwrap().as_u64(), None);
    }

    #[test]
    fn class_of_reads_two_bytes_and_nothing_else() {
        assert_eq!(class_of(&[0x82, 0x06]), Some(tag::SNAPSHOT));
        assert_eq!(class_of(&[0x82, 0x13]), None); // 19 is the relay's, not a session class
        assert_eq!(class_of(&[0xa2, 0x00]), None);
        assert_eq!(class_of(&[0x82]), None);
        assert_eq!(class_of(&[]), None);
    }
}
