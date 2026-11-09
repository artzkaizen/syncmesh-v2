//! The relay's control vocabulary (`relay/src/frames.ts`, D14, D33): its own additive tag space,
//! 8–23, above the session frames, so grants and events pass through a relay byte-identical
//! under their existing tags and a later version adds tags without renumbering these.
//!
//! Tag 8 is `routes` among the session frames and `join` here. The relay decoder asks its own
//! tags first, as the TypeScript does, so on a relay socket 8 is always a join: routes are a
//! peer-to-peer frame and never cross a relay.

use crate::cbor::{Value, decode, encode};
use crate::event::{PartitionKey, PeerId, SeqNum};
use crate::frames::{
    Cursors, Frame, MalformedFrame, as_peer, as_text, cursor_pairs, decode_cursor_pairs,
    decode_frame, interest_text, peer_value, safe_count, shape, uint,
};

pub mod tag {
    pub const JOIN: u8 = 8;
    pub const HELLO: u8 = 9;
    pub const ERROR: u8 = 10;
    pub const KA: u8 = 11;
    pub const ACK: u8 = 12;
    pub const PAGE: u8 = 13;
    pub const RELAYED: u8 = 14;
    pub const BLOB_PUT: u8 = 15;
    pub const BLOB_GET: u8 = 16;
    pub const BLOB: u8 = 17;
    pub const BLOB_MISSING: u8 = 18;
    pub const CHALLENGE: u8 = 19;
    pub const BLOB_STORED: u8 = 20;
    pub const BLOB_REFUSED: u8 = 21;
    /// A signed refusal receipt on its way to its author (D32): the session tag for it, 9, is
    /// `hello` here.
    pub const REFUSAL: u8 = 22;
    /// A joiner took its seat (U38): each holder says once more what of its writes it refused.
    pub const SEATED: u8 = 23;
}

/// The protocol this build speaks; `join` offers, `hello` picks the highest in common.
///
/// **3** — the socket runs the link handshake: both ends send a signed hello first, everything
/// after travels sealed, and the join names the key the hello proved (D36). **2** — the room
/// challenges first and the join proves the key it names (D33). **1** — the bare join, believed on
/// its word. Neither 1 nor 2 is offered by this build; a room admits them only when its operator
/// lists them.
pub const RELAY_PROTOCOL_VERSIONS: [u64; 1] = [3];

/// The version from which a relay socket is a sealed link (D36).
pub const HANDSHAKE_VERSION: u64 = 3;

/// What a challenge is: this many bytes, fresh per socket, and nothing else.
pub const CHALLENGE_BYTES: usize = 32;

/// D14's whole negotiation: the highest version both sides speak, or `None` for no overlap — a
/// refusal the relay can explain, never a guess it decodes into.
pub fn select_version(offered: &[u64], spoken: &[u64]) -> Option<u64> {
    offered.iter().copied().filter(|v| spoken.contains(v)).max()
}

/// A join as the room read it.
#[derive(Debug, Clone, PartialEq)]
pub struct Join {
    pub versions: Vec<u64>,
    pub peer_id: PeerId,
    pub cursors: Cursors,
    /// What this device wants, as the JSON text it sent; `None` asks for everything its policy
    /// already allows.
    pub interest: Option<String>,
    /// The join's body as the proof covers it: versions, peer, cursors and interest, re-encoded
    /// canonically from what was decoded.
    pub core: Vec<u8>,
    /// The named key's signature over the room's challenge and `core` (D33); absent on a v1 join.
    pub proof: Option<Vec<u8>>,
}

/// On the last page of a filtered catch-up: how far the relay's unfiltered run reached, and the
/// interest it filtered by (D23).
#[derive(Debug, Clone, PartialEq)]
pub struct PageScope {
    pub synced: Cursors,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RelayFrame {
    /// A session frame carried unchanged.
    Session(Frame),
    Join(Join),
    /// The room's first frame on every socket: what a v2 join has to sign (D33).
    Challenge {
        nonce: [u8; CHALLENGE_BYTES],
    },
    Hello {
        version: u64,
        keepalive_ms: u64,
        epoch: String,
        cursors: Cursors,
        /// Per author, the highest sequence this room has trimmed; empty from a room that keeps
        /// everything and from one built before retention, which say the same thing.
        floor: Cursors,
    },
    Error {
        code: String,
        message: String,
        /// On a `retention` refusal, the room's floor as the refusal read it (gaps U30); `None`
        /// on every other refusal and from a relay built before it.
        floor: Option<Cursors>,
    },
    Ka,
    Ack {
        id: String,
        offset: u64,
    },
    Page {
        grants: Vec<Vec<u8>>,
        events: Vec<Vec<u8>>,
        more: bool,
        offset: u64,
        scoped: Option<PageScope>,
    },
    Relayed {
        wire: Vec<u8>,
        offset: u64,
    },
    /// Bytes offered under their own hash; the relay verifies before it stores (D18).
    /// `partition` is whose byte budget they are billed to — an additive element, absent for the
    /// budget of puts that named none.
    BlobPut {
        hash: String,
        bytes: Vec<u8>,
        partition: Option<PartitionKey>,
    },
    BlobGet {
        hash: String,
    },
    Blob {
        hash: String,
        bytes: Vec<u8>,
    },
    /// Nobody here holds them — a value, and recoverable.
    BlobMissing {
        hash: String,
    },
    /// The relay kept the bytes put under this name.
    BlobStored {
        hash: String,
    },
    /// The relay would not keep them, and stored nothing; `quota` carries the partition's budget
    /// and spend. A code this build does not know is still a refusal.
    BlobRefused {
        hash: String,
        code: String,
        limit: u64,
        used: u64,
        partition: Option<PartitionKey>,
    },
    /// A refusal receipt (D32), the signed wire unchanged, from the refuser to the room and from
    /// the room to the author it names. A custody receipt needs no tag of its own: its session
    /// tag, 7, is below the relay's, so it passes as a session frame.
    Refusal {
        wire: Vec<u8>,
    },
    /// The room's word that `peer` took its seat, on this instance or another (U38): a new
    /// seating, so every holder says once more what of that peer's writes it refused.
    Seated {
        peer: PeerId,
    },
    /// A tag this build does not know; ignored, never an error (D14).
    Unknown,
}

impl RelayFrame {
    /// The TypeScript's `kind` discriminant.
    pub fn kind(&self) -> &'static str {
        match self {
            RelayFrame::Session(_) => "session",
            RelayFrame::Join(_) => "join",
            RelayFrame::Challenge { .. } => "challenge",
            RelayFrame::Hello { .. } => "hello",
            RelayFrame::Error { .. } => "error",
            RelayFrame::Ka => "ka",
            RelayFrame::Ack { .. } => "ack",
            RelayFrame::Page { .. } => "page",
            RelayFrame::Relayed { .. } => "relayed",
            RelayFrame::BlobPut { .. } => "blob-put",
            RelayFrame::BlobGet { .. } => "blob-get",
            RelayFrame::Blob { .. } => "blob",
            RelayFrame::BlobMissing { .. } => "blob-missing",
            RelayFrame::BlobStored { .. } => "blob-stored",
            RelayFrame::BlobRefused { .. } => "blob-refused",
            RelayFrame::Refusal { .. } => "refusal",
            RelayFrame::Seated { .. } => "seated",
            RelayFrame::Unknown => "unknown",
        }
    }

    /// The frame's bytes; `None` where nothing was kept to write back (an unknown frame).
    /// A join goes out as its fields, re-encoded, exactly as the TypeScript writes one.
    pub fn encode(&self) -> Option<Vec<u8>> {
        Some(match self {
            RelayFrame::Session(frame) => return frame.encode(),
            RelayFrame::Join(j) => join_frame(
                &j.versions,
                &j.peer_id,
                &j.cursors,
                j.interest.as_deref(),
                j.proof.as_deref(),
            ),
            RelayFrame::Challenge { nonce } => challenge_frame(nonce),
            RelayFrame::Hello {
                version,
                keepalive_ms,
                epoch,
                cursors,
                floor,
            } => hello_frame(*version, *keepalive_ms, epoch, cursors, floor),
            RelayFrame::Error {
                code,
                message,
                floor: None,
            } => error_frame(code, message),
            RelayFrame::Error {
                code,
                message,
                floor: Some(floor),
            } => retention_error_frame(code, message, floor),
            RelayFrame::Ka => ka_frame(),
            RelayFrame::Ack { id, offset } => ack_frame(id, *offset),
            RelayFrame::Page {
                grants,
                events,
                more,
                offset,
                scoped,
            } => page_frame(grants, events, *more, *offset, scoped.as_ref()),
            RelayFrame::Relayed { wire, offset } => relayed_frame(wire, *offset),
            RelayFrame::BlobPut {
                hash,
                bytes,
                partition,
            } => blob_put_frame(hash, bytes, partition.as_ref()),
            RelayFrame::BlobGet { hash } => blob_get_frame(hash),
            RelayFrame::Blob { hash, bytes } => blob_frame(hash, bytes),
            RelayFrame::BlobMissing { hash } => blob_missing_frame(hash),
            RelayFrame::BlobStored { hash } => blob_stored_frame(hash),
            RelayFrame::BlobRefused {
                hash,
                code,
                limit,
                used,
                partition,
            } => blob_refused_frame(hash, code, *limit, *used, partition.as_ref()),
            RelayFrame::Refusal { wire } => room_refusal_frame(wire),
            RelayFrame::Seated { peer } => seated_frame(peer),
            RelayFrame::Unknown => return None,
        })
    }
}

fn tagged(t: u8, rest: Vec<Value>) -> Vec<u8> {
    let mut items = Vec::with_capacity(rest.len() + 1);
    items.push(Value::Int(t as i64));
    items.extend(rest);
    encode(&Value::Array(items))
}

/// The four elements a join is made of; the frame and the proof both read them.
fn join_parts(
    versions: &[u64],
    peer_id: &PeerId,
    cursors: &[(PeerId, SeqNum)],
    interest: Option<&str>,
) -> Vec<Value> {
    vec![
        Value::Array(versions.iter().map(|&v| uint(v)).collect()),
        peer_value(peer_id),
        cursor_pairs(cursors),
        Value::text(interest.unwrap_or("")),
    ]
}

/// The bytes a join proof signs: the join's own body, canonically encoded, with the tag and the
/// proof left out. A room recomputes this from what it decoded — canonical CBOR is what makes the
/// re-encode land on the same bytes — so a join altered in flight fails its own proof.
pub fn join_core(
    versions: &[u64],
    peer_id: &PeerId,
    cursors: &[(PeerId, SeqNum)],
    interest: Option<&str>,
) -> Vec<u8> {
    encode(&Value::Array(join_parts(
        versions, peer_id, cursors, interest,
    )))
}

/// A join; with `proof`, a v2 join (see [`join_core`] for what the proof is over).
pub fn join_frame(
    versions: &[u64],
    peer_id: &PeerId,
    cursors: &[(PeerId, SeqNum)],
    interest: Option<&str>,
    proof: Option<&[u8]>,
) -> Vec<u8> {
    let mut parts = join_parts(versions, peer_id, cursors, interest);
    if let Some(proof) = proof {
        parts.push(Value::Bytes(proof.to_vec()));
    }
    tagged(tag::JOIN, parts)
}

pub fn challenge_frame(nonce: &[u8]) -> Vec<u8> {
    tagged(tag::CHALLENGE, vec![Value::Bytes(nonce.to_vec())])
}

pub fn hello_frame(
    version: u64,
    keepalive_ms: u64,
    epoch: &str,
    cursors: &[(PeerId, SeqNum)],
    floor: &[(PeerId, SeqNum)],
) -> Vec<u8> {
    tagged(
        tag::HELLO,
        vec![
            uint(version),
            uint(keepalive_ms),
            Value::text(epoch),
            cursor_pairs(cursors),
            cursor_pairs(floor),
        ],
    )
}

pub fn error_frame(code: &str, message: &str) -> Vec<u8> {
    tagged(tag::ERROR, vec![Value::text(code), Value::text(message)])
}

/// A refusal naming a floor: what a `retention` refusal carries as one additive element, so the
/// device can say what it is below (gaps U30). An older client reads the two before it and stops.
pub fn retention_error_frame(code: &str, message: &str, floor: &[(PeerId, SeqNum)]) -> Vec<u8> {
    tagged(
        tag::ERROR,
        vec![Value::text(code), Value::text(message), cursor_pairs(floor)],
    )
}

pub fn ka_frame() -> Vec<u8> {
    tagged(tag::KA, vec![])
}

pub fn ack_frame(id: &str, offset: u64) -> Vec<u8> {
    tagged(tag::ACK, vec![Value::text(id), uint(offset)])
}

fn wires(list: &[Vec<u8>]) -> Value {
    Value::Array(list.iter().map(|w| Value::Bytes(w.clone())).collect())
}

/// The `scoped` tail rides only the last page of a filtered catch-up (D23); one additive element,
/// so an older build reads the element before it and stops.
pub fn page_frame(
    grants: &[Vec<u8>],
    events: &[Vec<u8>],
    more: bool,
    offset: u64,
    scoped: Option<&PageScope>,
) -> Vec<u8> {
    let mut parts = vec![
        wires(grants),
        wires(events),
        Value::Int(more as i64),
        uint(offset),
    ];
    if let Some(scoped) = scoped {
        parts.push(Value::Array(vec![
            cursor_pairs(&scoped.synced),
            Value::text(&scoped.scope),
        ]));
    }
    tagged(tag::PAGE, parts)
}

pub fn relayed_frame(wire: &[u8], offset: u64) -> Vec<u8> {
    tagged(
        tag::RELAYED,
        vec![Value::Bytes(wire.to_vec()), uint(offset)],
    )
}

pub fn blob_put_frame(hash: &str, bytes: &[u8], partition: Option<&PartitionKey>) -> Vec<u8> {
    let mut parts = vec![Value::text(hash), Value::Bytes(bytes.to_vec())];
    if let Some(partition) = partition {
        parts.push(Value::text(partition.as_str()));
    }
    tagged(tag::BLOB_PUT, parts)
}

pub fn blob_get_frame(hash: &str) -> Vec<u8> {
    tagged(tag::BLOB_GET, vec![Value::text(hash)])
}

pub fn blob_frame(hash: &str, bytes: &[u8]) -> Vec<u8> {
    tagged(
        tag::BLOB,
        vec![Value::text(hash), Value::Bytes(bytes.to_vec())],
    )
}

pub fn blob_missing_frame(hash: &str) -> Vec<u8> {
    tagged(tag::BLOB_MISSING, vec![Value::text(hash)])
}

pub fn blob_stored_frame(hash: &str) -> Vec<u8> {
    tagged(tag::BLOB_STORED, vec![Value::text(hash)])
}

/// `[wire]` — a refusal receipt across a relay, under the control tag its session tag collides with.
pub fn room_refusal_frame(wire: &[u8]) -> Vec<u8> {
    tagged(tag::REFUSAL, vec![Value::Bytes(wire.to_vec())])
}

/// `[peer]` — a joiner took its seat; the room's own frame, never a client's.
pub fn seated_frame(peer: &PeerId) -> Vec<u8> {
    tagged(tag::SEATED, vec![peer_value(peer)])
}

/// `[hash, code, limit, used, partition?]` — the partition last, absent for the unnamed budget.
pub fn blob_refused_frame(
    hash: &str,
    code: &str,
    limit: u64,
    used: u64,
    partition: Option<&PartitionKey>,
) -> Vec<u8> {
    let mut parts = vec![
        Value::text(hash),
        Value::text(code),
        uint(limit),
        uint(used),
    ];
    if let Some(partition) = partition {
        parts.push(Value::text(partition.as_str()));
    }
    tagged(tag::BLOB_REFUSED, parts)
}

/// An optional partition element: absent is the unnamed budget, anything else must parse.
fn optional_partition(
    v: Option<&Value>,
    malformed: &'static str,
) -> Result<Option<PartitionKey>, MalformedFrame> {
    match v {
        None => Ok(None),
        Some(value) => as_text(Some(value))
            .and_then(|text| PartitionKey::parse(text).ok())
            .map(Some)
            .ok_or(MalformedFrame::Shape(malformed)),
    }
}

fn as_wires(v: Option<&Value>) -> Result<Vec<Vec<u8>>, MalformedFrame> {
    let Some(Value::Array(list)) = v else {
        return shape("wires are not an array");
    };
    list.iter()
        .map(|w| match w {
            Value::Bytes(b) => Ok(b.clone()),
            _ => shape("wire is not bytes"),
        })
        .collect()
}

fn decode_join(p: &[Option<&Value>; 5]) -> Result<RelayFrame, MalformedFrame> {
    let [a, b, c, d, e] = *p;
    let versions = match a {
        Some(Value::Array(vs)) => vs
            .iter()
            .map(|v| safe_count(Some(v)))
            .collect::<Option<Vec<_>>>()
            .ok_or(MalformedFrame::Shape("join versions are not integers"))?,
        _ => return shape("join versions are not integers"),
    };
    let peer_id = as_peer(b)?;
    let cursors = decode_cursor_pairs(c)?;
    let interest = interest_text(d);
    let proof = match e {
        None => None,
        Some(Value::Bytes(proof)) => Some(proof.clone()),
        Some(_) => return shape("join proof is not bytes"),
    };
    // the body as the sender signed it, re-encoded from what was decoded: `b` is the peer's bytes
    // and `d` whatever sat in the interest slot (text, or even not), so this is the sender's own
    // core rather than a reconstruction of it from the fields this build understood
    // (`a`, `b` and `c` are all present by now; the `Null` is never written)
    let present = |v: Option<&Value>| v.cloned().unwrap_or(Value::Null);
    let core = encode(&Value::Array(vec![
        present(a),
        present(b),
        present(c),
        d.cloned().unwrap_or_else(|| Value::text("")),
    ]));
    Ok(RelayFrame::Join(Join {
        versions,
        peer_id,
        cursors,
        interest,
        core,
        proof,
    }))
}

fn decode_control(t: u64, p: &[Option<&Value>; 5]) -> Option<Result<RelayFrame, MalformedFrame>> {
    let [a, b, c, d, e] = *p;
    let text = |v: Option<&Value>| as_text(v).map(str::to_owned);
    let bytes = |v: Option<&Value>| v.and_then(Value::as_bytes).map(<[u8]>::to_vec);
    Some(match u8::try_from(t).ok()? {
        tag::JOIN => decode_join(p),
        tag::HELLO => (|| {
            let (Some(version), Some(keepalive_ms), Some(epoch)) =
                (safe_count(a), safe_count(b), text(c))
            else {
                return shape("hello is not [version, keepalive, epoch, cursors]");
            };
            let cursors = decode_cursor_pairs(d)?;
            // absent from a relay built before retention, and empty from one that trims nothing
            let floor = match e {
                None => Vec::new(),
                Some(_) => decode_cursor_pairs(e)?,
            };
            Ok(RelayFrame::Hello {
                version,
                keepalive_ms,
                epoch,
                cursors,
                floor,
            })
        })(),
        tag::ERROR => (|| {
            let (Some(code), Some(message)) = (text(a), text(b)) else {
                return shape("error is not [code, message]");
            };
            // only a `retention` refusal's third element is its floor: another code's is a later
            // additive element read past, and a floor that does not decode leaves the refusal
            // standing without one
            let floor = match c {
                Some(_) if code == "retention" => decode_cursor_pairs(c).ok(),
                _ => None,
            };
            Ok(RelayFrame::Error {
                code,
                message,
                floor,
            })
        })(),
        tag::KA => Ok(RelayFrame::Ka),
        tag::ACK => match (text(a), safe_count(b)) {
            (Some(id), Some(offset)) => Ok(RelayFrame::Ack { id, offset }),
            _ => shape("ack is not [id, offset]"),
        },
        tag::PAGE => (|| {
            let grants = as_wires(a)?;
            let events = as_wires(b)?;
            let (Some(more), Some(offset)) = (safe_count(c), safe_count(d)) else {
                return shape("page tail is not [more, offset]");
            };
            let scoped = match e {
                None => None,
                Some(Value::Array(pair)) => match pair.as_slice() {
                    [synced, Value::Text(scope)] => Some(PageScope {
                        synced: decode_cursor_pairs(Some(synced))?,
                        scope: scope.clone(),
                    }),
                    _ => return shape("page scope is not [cursors, interest]"),
                },
                Some(_) => return shape("page scope is not [cursors, interest]"),
            };
            Ok(RelayFrame::Page {
                grants,
                events,
                more: more == 1,
                offset,
                scoped,
            })
        })(),
        tag::RELAYED => match (bytes(a), safe_count(b)) {
            (Some(wire), Some(offset)) => Ok(RelayFrame::Relayed { wire, offset }),
            _ => shape("relayed is not [wire, offset]"),
        },
        tag::BLOB_PUT => match (text(a), bytes(b)) {
            (Some(hash), Some(bytes)) => {
                optional_partition(c, "blob-put partition is not a partition key").map(
                    |partition| RelayFrame::BlobPut {
                        hash,
                        bytes,
                        partition,
                    },
                )
            }
            _ => shape("blob-put is not [hash, bytes]"),
        },
        tag::REFUSAL => match bytes(a) {
            Some(wire) => Ok(RelayFrame::Refusal { wire }),
            None => shape("refusal is not [wire]"),
        },
        tag::SEATED => as_peer(a).map(|peer| RelayFrame::Seated { peer }),
        tag::BLOB_STORED => match text(a) {
            Some(hash) => Ok(RelayFrame::BlobStored { hash }),
            None => shape("blob-stored is not [hash]"),
        },
        tag::BLOB_REFUSED => match (text(a), text(b), safe_count(c), safe_count(d)) {
            (Some(hash), Some(code), Some(limit), Some(used)) => {
                optional_partition(e, "blob-refused partition is not a partition key").map(
                    |partition| RelayFrame::BlobRefused {
                        hash,
                        code,
                        limit,
                        used,
                        partition,
                    },
                )
            }
            _ => shape("blob-refused is not [hash, code, limit, used]"),
        },
        tag::BLOB => match (text(a), bytes(b)) {
            (Some(hash), Some(bytes)) => Ok(RelayFrame::Blob { hash, bytes }),
            _ => shape("blob is not [hash, bytes]"),
        },
        tag::BLOB_GET => match text(a) {
            Some(hash) => Ok(RelayFrame::BlobGet { hash }),
            None => shape("blob-get is not [hash]"),
        },
        tag::BLOB_MISSING => match text(a) {
            Some(hash) => Ok(RelayFrame::BlobMissing { hash }),
            None => shape("blob-missing is not [hash]"),
        },
        tag::CHALLENGE => match bytes(a).and_then(|n| <[u8; CHALLENGE_BYTES]>::try_from(n).ok()) {
            Some(nonce) => Ok(RelayFrame::Challenge { nonce }),
            None => shape("challenge is not 32 bytes"),
        },
        _ => return None,
    })
}

/// Dispatched on the tag, the relay's own tags first. `ka` is a bare tag with nothing after it,
/// which the session decoder would refuse as malformed; asking the control table first is what
/// lets a keepalive decode at all. Never panics.
pub fn decode_relay_frame(bytes: &[u8]) -> Result<RelayFrame, MalformedFrame> {
    let outer = decode(bytes).ok();
    let parts: &[Value] = match &outer {
        Some(Value::Array(items)) => items,
        _ => &[],
    };
    let kind = safe_count(parts.first());
    let p = [
        parts.get(1),
        parts.get(2),
        parts.get(3),
        parts.get(4),
        parts.get(5),
    ];
    if let Some(result) = kind.and_then(|k| decode_control(k, &p)) {
        return result;
    }
    // a bare tag is nobody's session frame — those all carry a payload — so an unrecognised one
    // is a tag some later version added and this build ignores, not junk
    if parts.len() == 1 && kind.is_some() {
        return Ok(RelayFrame::Unknown);
    }
    Ok(match decode_frame(bytes)? {
        Frame::Unknown => RelayFrame::Unknown,
        frame => RelayFrame::Session(frame),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex::to_hex;

    fn peer() -> PeerId {
        PeerId::parse(&to_hex(&[3; 32])).unwrap()
    }

    #[test]
    fn versions_meet_at_the_highest_shared() {
        assert_eq!(
            select_version(&[1, 2, 3], &RELAY_PROTOCOL_VERSIONS),
            Some(3)
        );
        assert_eq!(select_version(&[1, 2], &RELAY_PROTOCOL_VERSIONS), None);
        assert_eq!(select_version(&[1], &RELAY_PROTOCOL_VERSIONS), None);
        assert_eq!(select_version(&[], &RELAY_PROTOCOL_VERSIONS), None);
        assert_eq!(select_version(&[1, 2, 3], &[1, 3]), Some(3));
    }

    #[test]
    fn a_join_with_a_wrong_version_list_is_refused() {
        // versions as text, and as a negative number
        for versions in [Value::text("2"), Value::Array(vec![Value::Int(-1)])] {
            let bytes = encode(&Value::Array(vec![
                Value::Int(8),
                versions,
                peer_value(&peer()),
                Value::Array(vec![]),
                Value::text(""),
            ]));
            assert_eq!(
                decode_relay_frame(&bytes),
                Err(MalformedFrame::Shape("join versions are not integers"))
            );
        }
    }

    #[test]
    fn a_proof_that_is_not_bytes_is_refused_not_ignored() {
        let bytes = encode(&Value::Array(vec![
            Value::Int(8),
            Value::Array(vec![Value::Int(2)]),
            peer_value(&peer()),
            Value::Array(vec![]),
            Value::text(""),
            Value::text("sig"),
        ]));
        assert_eq!(
            decode_relay_frame(&bytes),
            Err(MalformedFrame::Shape("join proof is not bytes"))
        );
    }

    #[test]
    fn only_a_retention_refusal_reads_a_floor() {
        // another code's third element is a later additive one, read past (gaps U30)
        let other = tagged(
            tag::ERROR,
            vec![
                Value::text("version"),
                Value::text("speaks 1"),
                Value::text("hint"),
            ],
        );
        assert_eq!(
            decode_relay_frame(&other),
            Ok(RelayFrame::Error {
                code: "version".to_owned(),
                message: "speaks 1".to_owned(),
                floor: None,
            })
        );
        // a floor that does not decode leaves the refusal standing, without one
        let odd = tagged(
            tag::ERROR,
            vec![
                Value::text("retention"),
                Value::text("below"),
                Value::text("x"),
            ],
        );
        assert_eq!(
            decode_relay_frame(&odd),
            Ok(RelayFrame::Error {
                code: "retention".to_owned(),
                message: "below".to_owned(),
                floor: None,
            })
        );
    }

    #[test]
    fn a_challenge_is_exactly_thirty_two_bytes() {
        assert!(decode_relay_frame(&challenge_frame(&[0; 31])).is_err());
        assert!(decode_relay_frame(&challenge_frame(&[0; 33])).is_err());
        assert_eq!(
            decode_relay_frame(&challenge_frame(&[9; 32])),
            Ok(RelayFrame::Challenge { nonce: [9; 32] })
        );
    }

    #[test]
    fn bare_and_unknown_tags_are_ignored_but_junk_is_not() {
        assert_eq!(decode_relay_frame(&ka_frame()), Ok(RelayFrame::Ka));
        assert_eq!(
            decode_relay_frame(&[0x81, 0x18, 0x63]),
            Ok(RelayFrame::Unknown)
        ); // [99]
        assert_eq!(
            decode_relay_frame(&[0x82, 0x18, 0x63, 0x00]),
            Ok(RelayFrame::Unknown)
        ); // [99, 0]
        assert!(decode_relay_frame(&[0xff]).is_err());
        assert!(decode_relay_frame(&[]).is_err());
        let hello = hello_frame(2, 15_000, "e", &[], &[]);
        for cut in 0..hello.len() {
            assert!(decode_relay_frame(&hello[..cut]).is_err());
        }
    }

    #[test]
    fn session_frames_pass_through() {
        let event = crate::frames::event_frame(&[1, 2]);
        assert_eq!(
            decode_relay_frame(&event),
            Ok(RelayFrame::Session(Frame::Event { wire: vec![1, 2] }))
        );
    }
}
