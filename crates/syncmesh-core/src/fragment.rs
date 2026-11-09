//! A whole frame across a radio that carries a couple of hundred bytes at a time
//! (`ble/src/fragment.ts`), measured against `conformance/fragment-vectors.json`.
//!
//! A peer link promises whole frames in and whole frames out; BLE offers characteristic writes
//! bounded by whatever MTU the two devices negotiated. Every fragment carries an eight-byte header,
//! `[u32 message][u16 index][u16 total]` big-endian, including the only one of a short frame, so
//! nothing ever has to guess whether bytes are a header.
//!
//! A message that never completes is dropped, and dropping it is safe: the frame is never
//! delivered, so nothing folds it and the next cursor exchange asks for the event again.

use std::collections::{BTreeMap, VecDeque};

/// `[u32 message][u16 index][u16 total]`, big-endian.
pub const HEADER_BYTES: usize = 8;

/// One message's fragments must fit a `u16`.
const MAX_FRAGMENTS: usize = 0xffff;

/// What a receiver holds part of before it decides the sender is not worth the memory.
pub const DEFAULT_MAX_MESSAGE_BYTES: usize = 128 * 1024;

/// Partial messages kept at once, per link. Oldest goes first, and says so.
pub const DEFAULT_MAX_ASSEMBLIES: usize = 32;

/// Why a frame could not be cut: the TypeScript's `FragmentError` tags.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum FragmentError {
    /// The negotiated write size left no room for a header.
    LimitTooSmall { limit: usize },
    /// The frame needs more than 65 535 fragments at this write size.
    FrameTooLarge { bytes: usize, limit: usize },
}

impl FragmentError {
    /// The TypeScript error's `_tag`, which the vectors name.
    pub fn tag(&self) -> &'static str {
        match self {
            FragmentError::LimitTooSmall { .. } => "LimitTooSmall",
            FragmentError::FrameTooLarge { .. } => "FrameTooLarge",
        }
    }
}

impl std::fmt::Display for FragmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FragmentError::LimitTooSmall { limit } => {
                write!(f, "{limit} bytes leaves no room for a header")
            }
            FragmentError::FrameTooLarge { bytes, limit } => write!(
                f,
                "{bytes} bytes needs more fragments than a message carries (at most {limit} bytes)"
            ),
        }
    }
}

impl std::error::Error for FragmentError {}

/// One frame as the fragments that carry it, each at most `limit` bytes, under message id
/// `message`. An empty frame is one header and nothing after it.
///
/// ```
/// use syncmesh_core::fragment::fragment;
/// let parts = fragment(&[1, 2, 3], 10, 7).unwrap();
/// assert_eq!(
///     parts,
///     vec![vec![0, 0, 0, 7, 0, 0, 0, 2, 1, 2], vec![0, 0, 0, 7, 0, 1, 0, 2, 3]]
/// );
/// ```
pub fn fragment(frame: &[u8], limit: usize, message: u32) -> Result<Vec<Vec<u8>>, FragmentError> {
    let room = limit
        .checked_sub(HEADER_BYTES)
        .filter(|&r| r > 0)
        .ok_or(FragmentError::LimitTooSmall { limit })?;
    let total = frame.len().div_ceil(room).max(1);
    if total > MAX_FRAGMENTS {
        return Err(FragmentError::FrameTooLarge {
            bytes: frame.len(),
            limit: MAX_FRAGMENTS * room,
        });
    }
    let mut out = Vec::with_capacity(total);
    for index in 0..total {
        let slice = &frame[(index * room).min(frame.len())..((index + 1) * room).min(frame.len())];
        let mut packet = Vec::with_capacity(HEADER_BYTES + slice.len());
        packet.extend_from_slice(&message.to_be_bytes());
        // both fit: `total` is at most `MAX_FRAGMENTS`, which is `u16::MAX`
        packet.extend_from_slice(&(index as u16).to_be_bytes());
        packet.extend_from_slice(&(total as u16).to_be_bytes());
        packet.extend_from_slice(slice);
        out.push(packet);
    }
    Ok(out)
}

/// Why a partial message was given up on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Abandoned {
    /// Pushed out by a newer message once more than the maximum were held.
    Evicted,
    /// It grew past the per-message cap.
    TooLarge,
}

/// A partial message that was given up on: its id, the bytes held, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Abandonment {
    pub message: u32,
    pub held: usize,
    pub why: Abandoned,
}

#[derive(Debug)]
struct Partial {
    total: u16,
    parts: BTreeMap<u16, Vec<u8>>,
    bytes: usize,
    /// Given up on, and kept as a marker so the rest of its fragments cost nothing.
    dead: bool,
}

/// Fragments back into frames, in whatever order they arrived (`reassembler`).
#[derive(Debug)]
pub struct Reassembler {
    max_bytes: usize,
    max_held: usize,
    /// Insertion-ordered, as the TypeScript's `Map`: the front is the oldest.
    order: VecDeque<u32>,
    held: BTreeMap<u32, Partial>,
    abandoned: Vec<Abandonment>,
}

impl Default for Reassembler {
    fn default() -> Self {
        Reassembler::new(DEFAULT_MAX_MESSAGE_BYTES, DEFAULT_MAX_ASSEMBLIES)
    }
}

impl Reassembler {
    pub fn new(max_message_bytes: usize, max_assemblies: usize) -> Reassembler {
        Reassembler {
            max_bytes: max_message_bytes,
            max_held: max_assemblies,
            order: VecDeque::new(),
            held: BTreeMap::new(),
            abandoned: Vec::new(),
        }
    }

    /// A fragment in; the whole frame once its last fragment has landed. A packet too short for a
    /// header, or naming a fragment of nothing, is `None`.
    pub fn accept(&mut self, packet: &[u8]) -> Option<Vec<u8>> {
        let (message, index, total) = read_header(packet)?;
        let fresh = match self.held.get(&message) {
            Some(p) if p.dead => return None,
            // an id reused with a different length: the newer message is the live one
            Some(p) => p.total != total,
            None => true,
        };
        if fresh {
            // a replaced id keeps its place in the eviction order, as `Map.set` does
            if !self.held.contains_key(&message) {
                self.order.push_back(message);
            }
            self.held.insert(
                message,
                Partial {
                    total,
                    parts: BTreeMap::new(),
                    bytes: 0,
                    dead: false,
                },
            );
        }
        let partial = self.held.get_mut(&message)?;
        if partial.parts.contains_key(&index) {
            return None;
        }
        let body = packet[HEADER_BYTES..].to_vec();
        partial.bytes += body.len();
        partial.parts.insert(index, body);
        if partial.bytes > self.max_bytes {
            let held = partial.bytes;
            *partial = Partial {
                total,
                parts: BTreeMap::new(),
                bytes: 0,
                dead: true,
            };
            self.abandoned.push(Abandonment {
                message,
                held,
                why: Abandoned::TooLarge,
            });
            return None;
        }
        self.make_room(message);
        let partial = self.held.get(&message)?;
        if partial.parts.len() != usize::from(partial.total) {
            return None;
        }
        let frame = partial.parts.values().flatten().copied().collect();
        self.forget(message);
        Some(frame)
    }

    /// Partial messages currently held, markers of abandoned ones not counted.
    pub fn pending(&self) -> usize {
        self.held.values().filter(|p| !p.dead).count()
    }

    /// The messages given up on since the last call, oldest first.
    pub fn take_abandoned(&mut self) -> Vec<Abandonment> {
        std::mem::take(&mut self.abandoned)
    }

    fn forget(&mut self, message: u32) {
        if self.held.remove(&message).is_some() {
            self.order.retain(|m| *m != message);
        }
    }

    /// Room for one more, oldest first; `keep` is never the one to go.
    fn make_room(&mut self, keep: u32) {
        if self.held.len() <= self.max_held {
            return;
        }
        let Some(&oldest) = self.order.iter().find(|m| **m != keep) else {
            return;
        };
        if let Some(partial) = self.held.get(&oldest)
            && !partial.dead
        {
            // a marker going is bookkeeping: what it stood for was reported when it was given up
            self.abandoned.push(Abandonment {
                message: oldest,
                held: partial.bytes,
                why: Abandoned::Evicted,
            });
        }
        self.forget(oldest);
    }
}

/// The three numbers, or `None` for a packet too short or claiming a fragment of nothing.
fn read_header(packet: &[u8]) -> Option<(u32, u16, u16)> {
    let header: &[u8; HEADER_BYTES] = packet.get(..HEADER_BYTES)?.try_into().ok()?;
    let message = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    let index = u16::from_be_bytes([header[4], header[5]]);
    let total = u16::from_be_bytes([header[6], header[7]]);
    (total != 0 && index < total).then_some((message, index, total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragments_arriving_out_of_order_rebuild_the_frame() {
        let frame: Vec<u8> = (0..50).collect();
        let mut parts = fragment(&frame, 20, 9).unwrap();
        parts.reverse();
        let mut reader = Reassembler::default();
        let out: Vec<Vec<u8>> = parts.iter().filter_map(|p| reader.accept(p)).collect();
        assert_eq!(out, vec![frame]);
        assert_eq!(reader.pending(), 0);
    }

    #[test]
    fn a_message_past_the_cap_is_abandoned_once_and_its_rest_ignored() {
        let frame = vec![7u8; 100];
        let parts = fragment(&frame, 30, 1).unwrap();
        let mut reader = Reassembler::new(40, 4);
        for p in &parts {
            assert_eq!(reader.accept(p), None);
        }
        assert_eq!(
            reader.take_abandoned(),
            vec![Abandonment {
                message: 1,
                held: 44,
                why: Abandoned::TooLarge
            }]
        );
        assert_eq!(reader.pending(), 0);
    }

    #[test]
    fn the_oldest_partial_is_evicted_past_the_limit() {
        let mut reader = Reassembler::new(1024, 2);
        for message in 0..3u32 {
            let parts = fragment(&[1, 2, 3, 4], 10, message).unwrap();
            assert_eq!(reader.accept(&parts[0]), None);
        }
        let gone = reader.take_abandoned();
        assert_eq!(gone.len(), 1);
        assert_eq!(gone[0].message, 0);
        assert_eq!(gone[0].why, Abandoned::Evicted);
        assert_eq!(reader.pending(), 2);
    }

    #[test]
    fn an_id_reused_with_another_length_keeps_its_place_in_the_eviction_order() {
        let mut reader = Reassembler::new(1024, 2);
        for message in 0..2u32 {
            let parts = fragment(&[1, 2, 3, 4], 10, message).unwrap();
            assert_eq!(reader.accept(&parts[0]), None);
        }
        // the counter wrapped: id 0 names a longer message now, and is still the oldest
        let longer = fragment(&[1, 2, 3, 4, 5, 6, 7, 8], 10, 0).unwrap();
        assert_eq!(reader.accept(&longer[0]), None);
        let parts = fragment(&[1, 2, 3, 4], 10, 2).unwrap();
        assert_eq!(reader.accept(&parts[0]), None);
        let gone = reader.take_abandoned();
        assert_eq!(gone.len(), 1, "{gone:?}");
        assert_eq!(gone[0].message, 0);
    }
}
