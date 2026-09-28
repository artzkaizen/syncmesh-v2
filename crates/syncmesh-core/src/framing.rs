//! Frame boundaries over a medium that has none (`transport/src/framing.ts`).
//!
//! TCP, and every peer-to-peer Wi-Fi data path, delivers a byte stream: what one end wrote as
//! three frames may arrive as one read or as seven. A four-byte big-endian length before each
//! frame is the whole protocol. This is the sans-I/O half of it — bytes in, whole frames out —
//! so the crate stays free of any socket or runtime; the caller owns the stream and closes it
//! when a read reports [`FramingError`].
//!
//! **The cap is not a tuning knob, it is the door.** A peer nobody has authenticated yet can
//! write four bytes saying four gigabytes follow, and a reader that believed it would allocate
//! for a stranger. Over the limit the stream is broken for good rather than trimmed: a stream
//! whose lengths are not to be trusted has no next frame worth reading.

pub const LENGTH_BYTES: usize = 4;

/// Comfortably above a full page of events; far below what a stranger could ask a device to hold.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FramingError {
    /// The peer announced a frame larger than this link holds; the stream is finished.
    Announced { length: u64, max: usize },
    /// We were asked to send a frame larger than this link holds.
    TooLarge { length: usize, max: usize },
}

impl std::fmt::Display for FramingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FramingError::Announced { length, max } => write!(
                f,
                "a peer announced a {length}-byte frame; this link holds {max}"
            ),
            FramingError::TooLarge { length, max } => {
                write!(f, "this frame is {length} bytes; the link holds {max}")
            }
        }
    }
}

impl std::error::Error for FramingError {}

/// The frame with its length in front, as a byte stream carries it.
pub fn frame_with_length(frame: &[u8], max: usize) -> Result<Vec<u8>, FramingError> {
    let length = u32::try_from(frame.len())
        .ok()
        .filter(|&n| n as usize <= max)
        .ok_or(FramingError::TooLarge {
            length: frame.len(),
            max,
        })?;
    let mut out = Vec::with_capacity(LENGTH_BYTES + frame.len());
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(frame);
    Ok(out)
}

/// What has arrived and not yet been read out as whole frames.
#[derive(Debug)]
pub struct FrameReader {
    max: usize,
    held: Vec<u8>,
    /// Where the unread bytes in `held` begin; compacted on the next `push`.
    start: usize,
    broken: Option<FramingError>,
}

impl Default for FrameReader {
    fn default() -> Self {
        FrameReader::new(DEFAULT_MAX_FRAME_BYTES)
    }
}

impl FrameReader {
    pub fn new(max_frame_bytes: usize) -> FrameReader {
        FrameReader {
            max: max_frame_bytes,
            held: Vec::new(),
            start: 0,
            broken: None,
        }
    }

    /// Bytes as they came off the stream, split anywhere. Ignored once the stream is broken.
    pub fn push(&mut self, bytes: &[u8]) {
        if self.broken.is_some() {
            return;
        }
        if self.start > 0 {
            self.held.drain(..self.start);
            self.start = 0;
        }
        self.held.extend_from_slice(bytes);
    }

    /// The next whole frame, `Ok(None)` while one is still arriving, and the same error on every
    /// call after the stream announced a length over the cap.
    pub fn next_frame(&mut self) -> Result<Option<Vec<u8>>, FramingError> {
        if let Some(e) = &self.broken {
            return Err(e.clone());
        }
        let unread = &self.held[self.start..];
        let Some(prefix) = unread.first_chunk::<LENGTH_BYTES>() else {
            return Ok(None);
        };
        let length = u32::from_be_bytes(*prefix);
        if length as u64 > self.max as u64 {
            let e = FramingError::Announced {
                length: length as u64,
                max: self.max,
            };
            self.broken = Some(e.clone());
            self.held = Vec::new();
            self.start = 0;
            return Err(e);
        }
        let end = LENGTH_BYTES + length as usize;
        if unread.len() < end {
            return Ok(None);
        }
        let frame = unread[LENGTH_BYTES..end].to_vec();
        self.start += end;
        Ok(Some(frame))
    }

    /// Every whole frame that has arrived, stopping at the first refusal.
    pub fn drain(&mut self) -> (Vec<Vec<u8>>, Option<FramingError>) {
        let mut frames = Vec::new();
        loop {
            match self.next_frame() {
                Ok(Some(frame)) => frames.push(frame),
                Ok(None) => return (frames, None),
                Err(e) => return (frames, Some(e)),
            }
        }
    }

    pub fn is_broken(&self) -> bool {
        self.broken.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_survive_any_split() {
        let a = frame_with_length(b"one", DEFAULT_MAX_FRAME_BYTES).unwrap();
        let b = frame_with_length(b"", DEFAULT_MAX_FRAME_BYTES).unwrap();
        let c = frame_with_length(b"three", DEFAULT_MAX_FRAME_BYTES).unwrap();
        let stream = [a, b, c].concat();
        for split in 0..=stream.len() {
            let mut reader = FrameReader::default();
            reader.push(&stream[..split]);
            let (mut frames, e) = reader.drain();
            assert!(e.is_none());
            reader.push(&stream[split..]);
            frames.extend(reader.drain().0);
            assert_eq!(frames, vec![b"one".to_vec(), vec![], b"three".to_vec()]);
        }
    }

    #[test]
    fn an_oversized_announcement_breaks_the_stream_for_good() {
        let mut reader = FrameReader::new(4);
        let ok = frame_with_length(b"ab", 4).unwrap();
        reader.push(&[ok, vec![0, 0, 0, 5, 1, 2, 3, 4, 5]].concat());
        let (frames, e) = reader.drain();
        assert_eq!(frames, vec![b"ab".to_vec()]);
        assert_eq!(e, Some(FramingError::Announced { length: 5, max: 4 }));
        reader.push(&frame_with_length(b"x", 4).unwrap());
        assert!(reader.next_frame().is_err());
        assert!(reader.is_broken());
    }

    #[test]
    fn sending_over_the_cap_is_refused() {
        assert_eq!(
            frame_with_length(b"hello", 4),
            Err(FramingError::TooLarge { length: 5, max: 4 })
        );
    }
}
