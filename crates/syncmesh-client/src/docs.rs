//! The document-adapter SPI (RFC-0023 §2.8): what syncmesh needs from a CRDT library to carry and
//! store its documents, mirroring `DocumentAdapter` in `@syncmesh/docs`.

use sha2::{Digest, Sha256};

/// The bounds an adapter holds every document to (RFC-0023 §5.4, §8.2, §10). Exceeding one is a
/// value, never a crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocLimits {
    /// The largest update a flush exports or an import accepts (RFC-0023 §5.4's inline bound).
    pub max_update_bytes: usize,
    /// The largest snapshot a document may grow to; past it, edits are refused.
    pub max_snapshot_bytes: usize,
    /// Tail length at which a document is materialised and its log may be trimmed (§8.2).
    pub snapshot_every: usize,
    /// Tail bytes at which the same happens.
    pub snapshot_every_bytes: usize,
}

impl DocLimits {
    /// RFC-0023's numbers: 64 KiB inline, 200 updates or 256 KiB of tail, 16 MiB of document.
    pub const DEFAULT: DocLimits = DocLimits {
        max_update_bytes: 64 * 1024,
        max_snapshot_bytes: 16 * 1024 * 1024,
        snapshot_every: 200,
        snapshot_every_bytes: 256 * 1024,
    };
}

impl Default for DocLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// The adapter refused: bytes it could not take — malformed, oversized, or from another library —
/// or a document it could not export.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateRejected {
    pub adapter: String,
    pub message: String,
}

impl std::fmt::Display for UpdateRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.adapter, self.message)
    }
}

impl std::error::Error for UpdateRejected {}

/// A CRDT library behind syncmesh's document columns (RFC-0023 §2.8). [`Doc`](Self::Doc) is the
/// library's own document, handed to the app untouched; nothing here edits it.
///
/// Every method is total on foreign bytes: they come back as [`UpdateRejected`], never as a
/// panic. Two runtimes implementing one adapter id write one `version` for one history, byte for
/// byte on every target. Their `snapshot` and `since` outputs agree as documents: imported into a
/// fresh replica, they land on the same `version` and value; byte for byte only between builds of
/// one word size (`conformance/loro-vectors.json` for `loro@1`).
pub trait DocumentAdapter {
    type Doc;

    /// The adapter id, `name@major` (`loro@1`); the major is the compatibility contract (§10).
    fn id(&self) -> &str;
    fn limits(&self) -> DocLimits;
    /// An empty document whose own operations are attributed to `replica` (see [`replica_id`]).
    fn create(&self, replica: u64) -> Self::Doc;
    /// Imports updates or snapshots, in any order and any number of times. `true` when it changed
    /// the document.
    fn apply(&self, doc: &Self::Doc, updates: &[&[u8]]) -> Result<bool, UpdateRejected>;
    /// Whether imported operations wait on others the document has not seen. A snapshot leaves
    /// them out, so a document with any is never materialised.
    fn pending(&self, doc: &Self::Doc) -> bool;
    /// The whole document as one importable snapshot; a library that cannot encode it answers
    /// [`UpdateRejected`], never a panic.
    fn snapshot(&self, doc: &Self::Doc) -> Result<Vec<u8>, UpdateRejected>;
    /// The document's version, in the adapter's canonical encoding; what `since` reads back.
    fn version(&self, doc: &Self::Doc) -> Vec<u8>;
    /// One update holding every operation the document has past `version`.
    fn since(&self, doc: &Self::Doc, version: &[u8]) -> Result<Vec<u8>, UpdateRejected>;
}

const REPLICA_DOMAIN: &[u8] = b"syncmesh/doc-replica";

/// The replica a document handle edits as: `sha256("syncmesh/doc-replica" ‖ peer ‖ nonce)`, first
/// eight bytes big-endian, top bit cleared. A fresh nonce per open keeps two handles of one device
/// off one replica (RFC-0023 §13).
pub fn replica_id(peer: &[u8; 32], nonce: &[u8]) -> u64 {
    let hash = Sha256::new()
        .chain_update(REPLICA_DOMAIN)
        .chain_update(peer)
        .chain_update(nonce)
        .finalize();
    let mut head = [0u8; 8];
    head.copy_from_slice(&hash[..8]);
    u64::from_be_bytes(head) & (u64::MAX >> 1)
}
