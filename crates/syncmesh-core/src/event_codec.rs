//! The event core: a CBOR map with the keys the vectors froze (RFC-0002).
//! `v`0 `peerId`1 `seq`2 `hlc`3 `procedure`5 `partition`6 `changes`7 `sealed`8, and RFC-0023's
//! `action`10 `undoOf`11. Key 9 is reserved for `schemaVersion` and never written here.

use crate::cbor::{Key, MalformedCbor, Value, decode, encode};
use crate::doc::{doc_data_to_cbor, doc_from_cbor, id16};
use crate::event::{Change, PartitionKey, PeerId, SeqNum, SyncEvent};
use crate::hex::to_hex;
use crate::hlc::Hlc;
use crate::row_codec::{row_from_cbor, row_to_cbor};

const KEY_V: i64 = 0;
const KEY_PEER: i64 = 1;
const KEY_SEQ: i64 = 2;
const KEY_HLC: i64 = 3;
const KEY_PROCEDURE: i64 = 5;
const KEY_PARTITION: i64 = 6;
const KEY_CHANGES: i64 = 7;
const KEY_SEALED: i64 = 8;
const KEY_ACTION: i64 = 10;
const KEY_UNDO_OF: i64 = 11;

/// One change's map keys.
const CHANGE_KIND: i64 = 0;
const CHANGE_TABLE: i64 = 1;
const CHANGE_KEY: i64 = 2;
const CHANGE_DATA: i64 = 3;

const KIND_INSERT: i64 = 0;
const KIND_UPDATE: i64 = 1;
const KIND_DELETE: i64 = 2;
/// 3–5 were the cell lattices D25 deleted and are never reused; they decode as `Unknown`.
const KIND_DOC: i64 = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventDecodeError {
    Cbor(MalformedCbor),
    Malformed(&'static str),
}

impl std::fmt::Display for EventDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EventDecodeError::Cbor(e) => write!(f, "{e}"),
            EventDecodeError::Malformed(m) => write!(f, "malformed event: {m}"),
        }
    }
}

impl std::error::Error for EventDecodeError {}

fn encode_change(change: &Change) -> Value {
    let (kind, data) = match change {
        Change::Insert { row, .. } => (Value::Int(KIND_INSERT), row_to_cbor(row)),
        Change::Update { patch, .. } => (Value::Int(KIND_UPDATE), row_to_cbor(patch)),
        Change::Delete { .. } => (Value::Int(KIND_DELETE), Value::Null),
        Change::Doc(doc) => (Value::Int(KIND_DOC), doc_data_to_cbor(doc)),
        Change::Unknown { tag, data, .. } => {
            (Value::Int(*tag as i64), data.clone().unwrap_or(Value::Null))
        }
    };
    Value::map([
        (Key::Int(CHANGE_KIND), kind),
        (
            Key::Int(CHANGE_TABLE),
            Value::Text(change.table().to_owned()),
        ),
        (Key::Int(CHANGE_KEY), Value::Text(change.key().to_owned())),
        (Key::Int(CHANGE_DATA), data),
    ])
}

/// The changes as the CBOR list a core carries them in — also what a sealed payload is made of.
pub fn encode_changes(changes: &[Change]) -> Value {
    Value::Array(changes.iter().map(encode_change).collect())
}

/// The core bytes a signature covers. Sealing is the caller's: pass the sealed bytes to put them
/// under key 8 instead of the plaintext list.
pub fn encode_event_core(event: &SyncEvent) -> Vec<u8> {
    encode_event_core_with(event, None)
}

pub fn encode_event_core_with(event: &SyncEvent, sealed: Option<Vec<u8>>) -> Vec<u8> {
    let mut core = vec![
        (Key::Int(KEY_V), Value::Int(SyncEvent::VERSION)),
        (
            Key::Int(KEY_PEER),
            Value::Bytes(event.peer_id.key_bytes().to_vec()),
        ),
        (Key::Int(KEY_SEQ), Value::Int(event.seq_num.get() as i64)),
        (
            Key::Int(KEY_HLC),
            Value::Array(vec![
                Value::Int(event.hlc.ms),
                Value::Int(event.hlc.logical as i64),
            ]),
        ),
        (
            Key::Int(KEY_PROCEDURE),
            Value::Text(event.procedure.clone()),
        ),
    ];
    if let Some(p) = &event.partition {
        core.push((Key::Int(KEY_PARTITION), Value::Text(p.as_str().to_owned())));
    }
    if let Some(action) = event.action {
        core.push((Key::Int(KEY_ACTION), Value::Bytes(action.to_vec())));
    }
    if let Some(undo_of) = event.undo_of {
        core.push((Key::Int(KEY_UNDO_OF), Value::Bytes(undo_of.to_vec())));
    }
    // exactly one of the two: a sealed event has no plaintext to be inconsistent with
    match sealed {
        Some(bytes) => core.push((Key::Int(KEY_SEALED), Value::Bytes(bytes))),
        None => core.push((Key::Int(KEY_CHANGES), encode_changes(&event.changes))),
    }
    encode(&Value::map(core))
}

fn malformed<T>(m: &'static str) -> Result<T, EventDecodeError> {
    Err(EventDecodeError::Malformed(m))
}

fn safe_non_negative(v: Option<&Value>) -> Option<u64> {
    match v {
        Some(Value::Int(n)) if *n >= 0 => Some(*n as u64),
        _ => None,
    }
}

fn decode_change(v: &Value) -> Result<Change, EventDecodeError> {
    let Value::Map(m) = v else {
        return malformed("change is not a map");
    };
    let (Some(Value::Text(table)), Some(Value::Text(key))) =
        (m.get(&Key::Int(CHANGE_TABLE)), m.get(&Key::Int(CHANGE_KEY)))
    else {
        return malformed("change table/key are not text");
    };
    let (table, key) = (table.clone(), key.clone());
    let data = m.get(&Key::Int(CHANGE_DATA));
    let Some(kind) = safe_non_negative(m.get(&Key::Int(CHANGE_KIND))) else {
        return malformed("change kind is not a tag");
    };
    Ok(match kind as i64 {
        KIND_DELETE => Change::Delete { table, key },
        KIND_DOC => {
            Change::Doc(doc_from_cbor(table, key, data).map_err(EventDecodeError::Malformed)?)
        }
        KIND_INSERT => Change::Insert {
            table,
            key,
            row: row_from_cbor(data).map_err(|e| EventDecodeError::Malformed(e.message))?,
        },
        KIND_UPDATE => Change::Update {
            table,
            key,
            patch: row_from_cbor(data).map_err(|e| EventDecodeError::Malformed(e.message))?,
        },
        // a tag this build does not know is kept whole rather than refused (D22-A)
        _ => Change::Unknown {
            tag: kind,
            table,
            key,
            data: data.cloned(),
        },
    })
}

pub fn decode_change_list(v: &Value) -> Result<Vec<Change>, EventDecodeError> {
    let Value::Array(items) = v else {
        return malformed("changes is not an array");
    };
    items.iter().map(decode_change).collect()
}

/// Decodes a core; refuses `v ≠ 1`; ignores unknown keys. A sealed payload this device holds no key
/// for decodes to an event with no readable changes and `sealed` set. Never panics.
pub fn decode_event_core(core: &[u8]) -> Result<SyncEvent, EventDecodeError> {
    decode_event_core_with(core, |_, _| None)
}

/// `open(partition, sealed_bytes)` returns the plaintext change list when this device holds the key.
pub fn decode_event_core_with(
    core: &[u8],
    open: impl Fn(&PartitionKey, &[u8]) -> Option<Vec<u8>>,
) -> Result<SyncEvent, EventDecodeError> {
    let value = decode(core).map_err(EventDecodeError::Cbor)?;
    let Value::Map(m) = value else {
        return malformed("core is not a map");
    };
    if m.get(&Key::Int(KEY_V)) != Some(&Value::Int(SyncEvent::VERSION)) {
        return malformed("unsupported version");
    }
    let Some(Value::Bytes(peer_bytes)) = m.get(&Key::Int(KEY_PEER)) else {
        return malformed("peerId is not bytes");
    };
    let partition = match m.get(&Key::Int(KEY_PARTITION)) {
        None => None,
        Some(Value::Text(p)) => Some(
            PartitionKey::parse(p)
                .map_err(|_| EventDecodeError::Malformed("partition is not kind:id"))?,
        ),
        Some(_) => return malformed("partition is not text"),
    };
    let Some(Value::Array(hlc)) = m.get(&Key::Int(KEY_HLC)) else {
        return malformed("hlc is not a pair");
    };
    if hlc.len() != 2 {
        return malformed("hlc is not a pair");
    }
    let Some(Value::Text(procedure)) = m.get(&Key::Int(KEY_PROCEDURE)) else {
        return malformed("procedure is not text");
    };
    let (Some(ms), Some(logical)) = (
        safe_non_negative(hlc.first()),
        safe_non_negative(hlc.get(1)),
    ) else {
        return malformed("hlc components are not integers");
    };
    let Some(seq) = safe_non_negative(m.get(&Key::Int(KEY_SEQ))) else {
        return malformed("seq is not an integer");
    };
    let peer_id = PeerId::parse(&to_hex(peer_bytes))
        .map_err(|_| EventDecodeError::Malformed(crate::event::HEX_ID_EXPECTED))?;
    let Some(seq_num) = SeqNum::parse(seq) else {
        return malformed("expected a positive safe integer");
    };
    let (changes, sealed) = match m.get(&Key::Int(KEY_SEALED)) {
        Some(Value::Bytes(under)) => match partition.as_ref().and_then(|p| open(p, under)) {
            // no key: the event is carried whole and folds to nothing, which is custody without judgment
            None => (Vec::new(), true),
            Some(plain) => {
                let list = decode(&plain).map_err(|e| EventDecodeError::Malformed(e.message))?;
                (decode_change_list(&list)?, false)
            }
        },
        Some(_) => return malformed("a sealed payload is not bytes"),
        None => match m.get(&Key::Int(KEY_CHANGES)) {
            Some(list) => (decode_change_list(list)?, false),
            None => return malformed("changes is not an array"),
        },
    };
    Ok(SyncEvent {
        peer_id,
        seq_num,
        hlc: Hlc::new(
            ms as i64,
            u32::try_from(logical)
                .map_err(|_| EventDecodeError::Malformed("logical counter too large"))?,
        ),
        procedure: procedure.clone(),
        partition,
        changes,
        sealed,
        // lenient on purpose: an old build skips both keys and folds the event, so refusing it
        // over a malformed one would park what every old peer folded
        action: id16(m.get(&Key::Int(KEY_ACTION))),
        undo_of: id16(m.get(&Key::Int(KEY_UNDO_OF))),
    })
}
