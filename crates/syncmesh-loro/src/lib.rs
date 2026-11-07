//! The `loro@1` document adapter over the `loro` crate (RFC-0023 §2.8, §13).
//!
//! The Rust half of `@syncmesh/loro`, at the same Loro version: one `version` for one history,
//! byte for byte, and snapshots and updates that import to the same document
//! (`conformance/loro-vectors.json`). The app edits a [`LoroDoc`] through Loro's own API; this
//! crate only carries and stores it.

pub use loro;

use std::panic::{AssertUnwindSafe, catch_unwind};

use loro::{ExportMode, LoroDoc, LoroResult, VersionVector};
use syncmesh_client::docs::{DocLimits, DocumentAdapter, UpdateRejected};

/// `loro@1`: the major is the compatibility contract (RFC-0023 §10): Loro's own 1.x snapshots and
/// updates, and [`encode_version`]'s versions.
pub const LORO_ID: &str = "loro@1";

/// The `loro@1` adapter. `limits` narrows RFC-0023's defaults.
///
/// # Examples
///
/// ```
/// use syncmesh_loro::LoroAdapter;
/// use syncmesh_client::docs::DocumentAdapter;
///
/// let adapter = LoroAdapter::default();
/// let doc = adapter.create(1);
/// doc.get_text("body").insert(0, "hi").unwrap();
/// doc.commit();
/// assert!(adapter.snapshot(&doc).starts_with(b"loro"));
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LoroAdapter {
    pub limits: DocLimits,
}

impl LoroAdapter {
    pub const fn new(limits: DocLimits) -> Self {
        Self { limits }
    }
}

fn reject(message: String) -> UpdateRejected {
    UpdateRejected {
        adapter: LORO_ID.to_owned(),
        message,
    }
}

/// Runs a Loro call on foreign bytes, turning its error or its panic into [`UpdateRejected`].
fn guarded<T, E: std::fmt::Display>(
    what: &str,
    call: impl FnOnce() -> Result<T, E>,
) -> Result<T, UpdateRejected> {
    match catch_unwind(AssertUnwindSafe(call)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(e)) => Err(reject(format!("{what}: {e}"))),
        Err(_) => Err(reject(format!("{what}: loro panicked"))),
    }
}

const VERSION_FORMAT: u8 = 1;
const PEER_BYTES: usize = 8;
const ENTRY_BYTES: usize = PEER_BYTES + 4;

/// `loro@1`'s version: `0x01`, then per peer in ascending order its id (u64) and end counter
/// (u32), both big-endian. Not Loro's own [`VersionVector::encode`], whose peer order differs
/// between word sizes.
pub fn encode_version(vv: &VersionVector) -> Vec<u8> {
    let mut peers: Vec<_> = vv.iter().map(|(&peer, &end)| (peer, end)).collect();
    peers.sort_unstable();
    let mut out = Vec::with_capacity(1 + peers.len() * ENTRY_BYTES);
    out.push(VERSION_FORMAT);
    for (peer, end) in peers {
        out.extend_from_slice(&peer.to_be_bytes());
        // a version's end counters are never negative
        out.extend_from_slice(&u32::try_from(end).unwrap_or(0).to_be_bytes());
    }
    out
}

/// The inverse of [`encode_version`]; anything else is refused.
pub fn decode_version(bytes: &[u8]) -> Result<VersionVector, UpdateRejected> {
    let refuse = || reject("not a loro@1 version".to_owned());
    let Some((&VERSION_FORMAT, entries)) = bytes.split_first() else {
        return Err(refuse());
    };
    if entries.len() % ENTRY_BYTES != 0 {
        return Err(refuse());
    }
    let mut vv = VersionVector::new();
    for entry in entries.chunks_exact(ENTRY_BYTES) {
        let (peer, end) = entry.split_at(PEER_BYTES);
        let peer = u64::from_be_bytes(peer.try_into().map_err(|_| refuse())?);
        let end = u32::from_be_bytes(end.try_into().map_err(|_| refuse())?);
        vv.insert(peer, i32::try_from(end).map_err(|_| refuse())?);
    }
    Ok(vv)
}

impl DocumentAdapter for LoroAdapter {
    type Doc = LoroDoc;

    fn id(&self) -> &str {
        LORO_ID
    }

    fn limits(&self) -> DocLimits {
        self.limits
    }

    /// # Panics
    ///
    /// If `replica` is `u64::MAX`, which Loro reserves; [`replica_id`](syncmesh_client::docs::replica_id)
    /// never returns it.
    fn create(&self, replica: u64) -> LoroDoc {
        let doc = LoroDoc::new();
        doc.set_peer_id(replica)
            .expect("u64::MAX is Loro's reserved peer id");
        doc
    }

    fn apply(&self, doc: &LoroDoc, updates: &[&[u8]]) -> Result<bool, UpdateRejected> {
        if let Some(oversized) = updates
            .iter()
            .find(|u| u.len() > self.limits.max_snapshot_bytes)
        {
            return Err(reject(format!(
                "an update of {} bytes is over the bound",
                oversized.len()
            )));
        }
        if updates.is_empty() {
            return Ok(false);
        }
        let before = doc.oplog_vv();
        let owned: Vec<Vec<u8>> = updates.iter().map(|u| u.to_vec()).collect();
        // an op whose deps this replica lacks waits in Loro's pending set until they land (D38)
        guarded("loro could not import the update", || -> LoroResult<_> {
            doc.import_batch(&owned)
        })?;
        Ok(doc.oplog_vv() != before)
    }

    fn pending(&self, doc: &LoroDoc) -> bool {
        // an export that fails is read as pending: the snapshot is then not taken, never short
        !matches!(doc.export_pending_updates(), Ok(None))
    }

    fn snapshot(&self, doc: &LoroDoc) -> Vec<u8> {
        doc.export(ExportMode::Snapshot)
            .expect("a snapshot of a whole document always encodes")
    }

    fn version(&self, doc: &LoroDoc) -> Vec<u8> {
        encode_version(&doc.oplog_vv())
    }

    fn since(&self, doc: &LoroDoc, version: &[u8]) -> Result<Vec<u8>, UpdateRejected> {
        let from = decode_version(version)?;
        guarded("loro could not export past that version", || {
            doc.export(ExportMode::updates(&from))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edited(adapter: &LoroAdapter, replica: u64, text: &str) -> LoroDoc {
        let doc = adapter.create(replica);
        doc.get_text("body").insert(0, text).unwrap();
        doc.commit();
        doc
    }

    #[test]
    fn garbage_is_rejected_not_a_panic() {
        let adapter = LoroAdapter::default();
        let doc = adapter.create(1);
        for junk in [&b""[..], b"loro", b"\xff\x00\x13garbage", &[0u8; 64]] {
            assert!(adapter.apply(&doc, &[junk]).is_err(), "{junk:?}");
        }
        assert!(adapter.since(&doc, b"\xff\xff\xff").is_err());
        assert_eq!(doc.get_text("body").to_string(), "");
    }

    #[test]
    fn an_update_over_the_bound_is_refused() {
        let small = LoroAdapter::new(DocLimits {
            max_snapshot_bytes: 32,
            ..DocLimits::DEFAULT
        });
        let source = edited(&small, 1, &"x".repeat(256));
        let update = small.snapshot(&source);
        assert!(update.len() > 32);
        let target = small.create(2);
        let refused = small.apply(&target, &[&update]).unwrap_err();
        assert!(refused.message.contains("over the bound"), "{refused}");
        assert_eq!(target.get_text("body").to_string(), "");
        assert_eq!(LoroAdapter::default().apply(&target, &[&update]), Ok(true));
    }

    #[test]
    fn two_replicas_exchanging_since_converge() {
        let adapter = LoroAdapter::default();
        let empty = adapter.version(&adapter.create(9));
        let a = edited(&adapter, 1, "alpha ");
        let b = edited(&adapter, 2, "beta ");
        let from_a = adapter.since(&a, &empty).unwrap();
        let from_b = adapter.since(&b, &empty).unwrap();
        assert_eq!(adapter.apply(&a, &[&from_b]), Ok(true));
        assert_eq!(adapter.apply(&b, &[&from_a]), Ok(true));
        assert_eq!(adapter.apply(&b, &[&from_a]), Ok(false));
        assert_eq!(
            a.get_text("body").to_string(),
            b.get_text("body").to_string()
        );
        assert_eq!(adapter.version(&a), adapter.version(&b));
        assert_eq!(adapter.apply(&a, &[]), Ok(false));
    }

    #[test]
    fn an_update_missing_its_dependency_is_pending_until_it_lands() {
        let adapter = LoroAdapter::default();
        let empty = adapter.version(&adapter.create(9));
        let a = edited(&adapter, 1, "first ");
        let first = adapter.since(&a, &empty).unwrap();
        let b = adapter.create(2);
        adapter.apply(&b, &[&first]).unwrap();
        b.get_text("body").insert(6, "second").unwrap();
        b.commit();
        let second = adapter.since(&b, &adapter.version(&a)).unwrap();
        let target = adapter.create(3);
        adapter.apply(&target, &[&second]).unwrap();
        assert!(adapter.pending(&target));
        adapter.apply(&target, &[&first]).unwrap();
        assert!(!adapter.pending(&target));
        assert_eq!(target.get_text("body").to_string(), "first second");
    }

    #[test]
    fn versions_are_canonical_and_round_trip() {
        assert_eq!(encode_version(&VersionVector::new()), [1]);
        let vv: VersionVector = [(u64::MAX - 1, 7), (2, 300)].into_iter().collect();
        let bytes = encode_version(&vv);
        assert_eq!(
            bytes,
            [
                &[1][..],
                &2u64.to_be_bytes(),
                &300u32.to_be_bytes(),
                &(u64::MAX - 1).to_be_bytes(),
                &7u32.to_be_bytes(),
            ]
            .concat()
        );
        assert_eq!(decode_version(&bytes), Ok(vv));
        for junk in [&b""[..], &[0], &[2], &[1, 0, 0], &bytes[..bytes.len() - 1]] {
            assert!(decode_version(junk).is_err(), "{junk:?}");
        }
        let past_i32 = [&[1][..], &1u64.to_be_bytes(), &u32::MAX.to_be_bytes()].concat();
        assert!(decode_version(&past_i32).is_err());
    }

    #[test]
    fn mangled_updates_never_panic() {
        let adapter = LoroAdapter::default();
        let source = edited(&adapter, 1, "the quick brown fox");
        source.get_map("meta").insert("title", "draft").unwrap();
        source.commit();
        let valid = adapter
            .since(&source, &encode_version(&VersionVector::new()))
            .unwrap();
        // xorshift64: deterministic, so a failure replays
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for round in 0..300 {
            let mut bytes = valid.clone();
            match round % 3 {
                0 => {
                    for _ in 0..=next() % 8 {
                        let at = (next() % bytes.len() as u64) as usize;
                        bytes[at] ^= 1 << (next() % 8);
                    }
                }
                1 => bytes.truncate((next() % bytes.len() as u64) as usize),
                _ => {
                    let len = (next() % 512) as usize;
                    bytes = (0..len).map(|_| next() as u8).collect();
                    if round % 2 == 0 && bytes.len() >= 4 {
                        bytes[..4].copy_from_slice(b"loro");
                    }
                }
            }
            let target = adapter.create(2);
            let _ = adapter.apply(&target, &[&bytes]);
            let _ = adapter.since(&target, &bytes);
            let _ = adapter.version(&target);
        }
    }
}
