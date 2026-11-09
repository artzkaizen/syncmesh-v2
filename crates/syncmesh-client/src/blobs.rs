//! Bytes that do not belong in a log (D18): a photo in the event log blocks convergence for
//! everything behind it and replicates to every peer forever. So a row carries the sha-256 and
//! the bytes travel on their own channel, content-addressed — the hash *is* the identity, which
//! makes a put idempotent, a re-upload after a loss free, and two rows referencing one photo
//! reference one set of bytes.
//!
//! Ports of `storage/src/blob.ts` (hash, verify, the store) and `relay/src/blob-channel.ts`
//! (the capability over one relay connection). The TypeScript channel owns a timer per download;
//! this one records the deadline and lets the host ask `expired` on its tick.

use std::collections::BTreeMap;
use std::time::Duration;

use sha2::{Digest, Sha256};
use syncmesh_core::event::PartitionKey;
use syncmesh_core::relay_frames::{RelayFrame, blob_get_frame, blob_put_frame};
use syncmesh_core::to_hex;

/// How long a put waits for the relay to say it kept the bytes — `BLOB_ANSWER_WAIT` in the
/// TypeScript. A relay built before `blob-stored` never says, so running out is not a refusal:
/// silence is what that relay has always answered with.
pub const BLOB_ANSWER_WAIT: Duration = Duration::from_secs(10);

/// The sha-256 of the bytes, in the wire's lowercase hex — the blob's whole identity.
pub fn hash_of(bytes: &[u8]) -> String {
    to_hex(&Sha256::digest(bytes))
}

/// Why bytes did not come back for a hash. Every one is recoverable in its own way: `Corrupt`
/// says whoever served this is lying and another source may not be; `NotFound` says any peer
/// that still holds the bytes can put them back; `Timeout` says the reference is still good and
/// the route was not; `Store` is the backend beneath a store refusing to do its job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlobError {
    /// The bytes do not hash to the name they arrived under — junk trying to squat a hash.
    Corrupt {
        hash: String,
    },
    /// Nobody reachable holds these bytes.
    NotFound {
        hash: String,
    },
    /// The fetch outlived its deadline.
    Timeout {
        hash: String,
    },
    /// A relay refused the put: the partition's byte budget would pass its quota. Nothing was
    /// stored there, and this device is still the only holder.
    QuotaExceeded {
        hash: String,
        partition: Option<PartitionKey>,
        limit: u64,
        used: u64,
    },
    /// A grant-gated relay refused the put: this device's grant does not name the partition (D44).
    NotGranted {
        hash: String,
        partition: PartitionKey,
    },
    Store(String),
}

impl std::fmt::Display for BlobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BlobError::Corrupt { hash } => {
                write!(f, "blob {hash}: the bytes are not the ones this hash names")
            }
            BlobError::NotFound { hash } => write!(f, "blob {hash}: no bytes here under that hash"),
            BlobError::Timeout { hash } => {
                write!(
                    f,
                    "blob {hash}: nobody reachable answered with these bytes in time"
                )
            }
            BlobError::QuotaExceeded {
                hash,
                partition,
                limit,
                used,
            } => {
                let budget = partition
                    .as_ref()
                    .map_or("the unnamed budget", PartitionKey::as_str);
                write!(
                    f,
                    "blob {hash}: a relay refused these bytes: {budget} holds {used} of {limit} bytes"
                )
            }
            BlobError::NotGranted { hash, partition } => write!(
                f,
                "blob {hash}: a grant-gated relay refused these bytes: this device's grant does not name {}",
                partition.as_str()
            ),
            BlobError::Store(message) => write!(f, "blob store: {message}"),
        }
    }
}

impl std::error::Error for BlobError {}

/// Only if the bytes are the ones the hash names. A reference is a **proof** of content, not a
/// promise about whoever served it, so this runs on every fetch and every put — a relay that
/// skipped it would let anyone poison any hash.
pub fn verify_blob(hash: &str, bytes: &[u8]) -> Result<(), BlobError> {
    if hash_of(bytes) == hash {
        Ok(())
    } else {
        Err(BlobError::Corrupt {
            hash: hash.to_owned(),
        })
    }
}

/// Where bytes live at one hop — a relay's durable home, or a device's evictable cache (D18).
/// Synchronous for the same reason the event stores are: the host puts the whole device on the
/// thread it wants the work on.
pub trait BlobStore {
    /// Stores the bytes under their own hash and returns it; storing twice is storing once.
    /// **This device made these**, which is what makes them irreplaceable until a peer has them.
    fn put(&mut self, bytes: &[u8]) -> Result<String, BlobError>;
    /// Stores bytes that arrived under a name, verifying **before** storing so junk cannot squat
    /// it. **These came from somewhere**, so they are a cache: dropping them costs a fetch.
    fn put_at(&mut self, hash: &str, bytes: &[u8]) -> Result<(), BlobError>;
    /// The bytes, verified on the way out — a store's own disk can rot too.
    fn get(&self, hash: &str) -> Result<Vec<u8>, BlobError>;
    fn has(&self, hash: &str) -> bool;
    /// Forgets these bytes here; a store that is a cache may do this whenever it likes.
    fn delete(&mut self, hash: &str);
}

/// A store that lives as long as the process: a device's cache, and what tests run against.
#[derive(Debug, Default)]
pub struct MemoryBlobStore {
    held: BTreeMap<String, Vec<u8>>,
}

impl MemoryBlobStore {
    pub fn new() -> MemoryBlobStore {
        MemoryBlobStore::default()
    }

    pub fn len(&self) -> usize {
        self.held.len()
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }
}

impl BlobStore for MemoryBlobStore {
    fn put(&mut self, bytes: &[u8]) -> Result<String, BlobError> {
        let hash = hash_of(bytes);
        self.held.insert(hash.clone(), bytes.to_vec());
        Ok(hash)
    }

    fn put_at(&mut self, hash: &str, bytes: &[u8]) -> Result<(), BlobError> {
        verify_blob(hash, bytes)?;
        self.held.insert(hash.to_owned(), bytes.to_vec());
        Ok(())
    }

    fn get(&self, hash: &str) -> Result<Vec<u8>, BlobError> {
        let bytes = self.held.get(hash).ok_or_else(|| BlobError::NotFound {
            hash: hash.to_owned(),
        })?;
        verify_blob(hash, bytes)?;
        Ok(bytes.clone())
    }

    fn has(&self, hash: &str) -> bool {
        self.held.contains_key(hash)
    }

    fn delete(&mut self, hash: &str) {
        self.held.remove(hash);
    }
}

/// Why a relay would not keep a put, as the putter reads it — or `None` from [`put_refusal`] for
/// a `blob-stored`, and for a refusal whose code is not about this put's budget or grant
/// (`no-store` from a room that keeps no blobs, or a code this build cannot name, D14): either
/// way that is what the putter heard before the answer existed, and it stays the holder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutRefusal {
    Quota {
        partition: Option<PartitionKey>,
        limit: u64,
        used: u64,
    },
    Ungranted {
        partition: PartitionKey,
    },
}

impl PutRefusal {
    /// The partition the refusal names: a refusal answers only the puts billed to it.
    pub fn partition(&self) -> Option<&PartitionKey> {
        match self {
            PutRefusal::Quota { partition, .. } => partition.as_ref(),
            PutRefusal::Ungranted { partition } => Some(partition),
        }
    }

    /// The error a put of `hash` answers with.
    pub fn into_error(self, hash: &str) -> BlobError {
        let hash = hash.to_owned();
        match self {
            PutRefusal::Quota {
                partition,
                limit,
                used,
            } => BlobError::QuotaExceeded {
                hash,
                partition,
                limit,
                used,
            },
            PutRefusal::Ungranted { partition } => BlobError::NotGranted { hash, partition },
        }
    }
}

/// A put's answer from the relay frame: the hash it is for and what it means, or `None` for a
/// frame that is not a put's answer. The TypeScript's `uploadRefusal`.
pub fn put_answer(frame: &RelayFrame) -> Option<(String, Option<PutRefusal>)> {
    match frame {
        RelayFrame::BlobStored { hash } => Some((hash.clone(), None)),
        RelayFrame::BlobRefused {
            hash,
            code,
            limit,
            used,
            partition,
        } => {
            let refusal = match (code.as_str(), partition) {
                ("quota", _) => Some(PutRefusal::Quota {
                    partition: partition.clone(),
                    limit: *limit,
                    used: *used,
                }),
                // a refusal naming no partition cannot be about a grant: a put billed to none is
                // never refused for one
                ("ungranted", Some(partition)) => Some(PutRefusal::Ungranted {
                    partition: partition.clone(),
                }),
                _ => None,
            };
            Some((hash.clone(), refusal))
        }
        _ => None,
    }
}

/// What a download settled to: the verified bytes, or `None` when the relay said `blob-missing`
/// or served bytes that were not the ones the hash names. Both `None`s mean the same thing to the
/// asker — try another source — and the corrupt case is not surfaced separately because a
/// relay that lies once is not a relay to ask again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobAnswer {
    pub hash: String,
    pub bytes: Option<Vec<u8>>,
}

/// The blob capability over one relay connection (D18): an upload offers bytes under their own
/// hash, a download asks for them and waits for the answer that names the same hash — the bytes,
/// a `blob-missing`, or the deadline, whichever arrives first. The relay answers each ask exactly
/// once; an answer nobody asked for is dropped.
#[derive(Debug, Default)]
pub struct BlobChannel {
    /// Downloads in flight, by hash, with the epoch ms past which each is given up on.
    waiting: BTreeMap<String, i64>,
}

impl BlobChannel {
    pub fn new() -> BlobChannel {
        BlobChannel::default()
    }

    /// The `blob-put` frame to send, billed to `partition`. The relay verifies before it stores
    /// and answers `blob-stored` or `blob-refused` ([`put_answer`]); an upload that cannot leave
    /// is the caller's to retry, so nothing is remembered here.
    pub fn upload(&self, hash: &str, bytes: &[u8], partition: Option<&PartitionKey>) -> Vec<u8> {
        blob_put_frame(hash, bytes, partition)
    }

    /// Records the wait and returns the `blob-get` frame to send. Asking again for a hash already
    /// in flight extends its deadline rather than asking twice.
    pub fn request(&mut self, hash: &str, now_ms: i64, timeout_ms: i64) -> Vec<u8> {
        self.waiting
            .insert(hash.to_owned(), now_ms.saturating_add(timeout_ms));
        blob_get_frame(hash)
    }

    /// An inbound `blob` (`Some`) or `blob-missing` (`None`) for a hash. `Some(answer)` only when
    /// a wait was outstanding — it is consumed either way — and the bytes are verified against the
    /// hash before they are handed on, so junk settles the wait as `None`.
    pub fn answer(&mut self, hash: &str, bytes: Option<Vec<u8>>) -> Option<BlobAnswer> {
        self.waiting.remove(hash)?;
        let bytes = bytes.filter(|b| verify_blob(hash, b).is_ok());
        Some(BlobAnswer {
            hash: hash.to_owned(),
            bytes,
        })
    }

    /// `answer`, from the decoded relay frame; any frame that is not a blob answer is `None`.
    pub fn answer_frame(&mut self, frame: &RelayFrame) -> Option<BlobAnswer> {
        match frame {
            RelayFrame::Blob { hash, bytes } => self.answer(hash, Some(bytes.clone())),
            RelayFrame::BlobMissing { hash } => self.answer(hash, None),
            _ => None,
        }
    }

    /// Every wait whose deadline has passed, given up on and returned; the asker reports each as
    /// `BlobError::Timeout`.
    pub fn expired(&mut self, now_ms: i64) -> Vec<String> {
        let gone: Vec<String> = self
            .waiting
            .iter()
            .filter(|(_, deadline)| **deadline <= now_ms)
            .map(|(hash, _)| hash.clone())
            .collect();
        for hash in &gone {
            self.waiting.remove(hash);
        }
        gone
    }

    /// The earliest deadline among the waits in flight, or `None` while nothing is.
    pub fn next_deadline_ms(&self) -> Option<i64> {
        self.waiting.values().copied().min()
    }

    pub fn pending(&self) -> usize {
        self.waiting.len()
    }
}

#[cfg(test)]
mod tests {
    use syncmesh_core::decode_relay_frame;

    use super::*;

    const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn hash_is_lowercase_hex_sha256() {
        assert_eq!(hash_of(b""), EMPTY_SHA256);
        assert_eq!(
            hash_of(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(verify_blob(EMPTY_SHA256, b""), Ok(()));
        assert_eq!(
            verify_blob(EMPTY_SHA256, b"x"),
            Err(BlobError::Corrupt {
                hash: EMPTY_SHA256.to_owned()
            })
        );
        assert!(
            BlobError::Timeout { hash: "h".into() }
                .to_string()
                .contains("in time")
        );
    }

    #[test]
    fn memory_store_puts_verifies_and_forgets() {
        let mut store = MemoryBlobStore::new();
        let hash = store.put(b"photo").unwrap();
        assert_eq!(hash, hash_of(b"photo"));
        assert!(store.has(&hash));
        assert_eq!(store.get(&hash).unwrap(), b"photo");
        assert_eq!(
            store.put(b"photo").unwrap(),
            hash,
            "storing twice is storing once"
        );
        assert_eq!(store.len(), 1);

        let other = hash_of(b"other");
        assert_eq!(
            store.put_at(&other, b"junk"),
            Err(BlobError::Corrupt {
                hash: other.clone()
            }),
            "junk cannot squat a hash"
        );
        assert!(!store.has(&other));
        assert_eq!(store.put_at(&other, b"other"), Ok(()));
        assert_eq!(store.get(&other).unwrap(), b"other");

        store.delete(&hash);
        assert!(!store.has(&hash));
        assert_eq!(store.get(&hash), Err(BlobError::NotFound { hash }));
        store.delete("never-held");
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn channel_frames_decode_to_blob_put_and_blob_get() {
        let mut channel = BlobChannel::new();
        let hash = hash_of(b"photo");
        match decode_relay_frame(&channel.upload(&hash, b"photo", None)).unwrap() {
            RelayFrame::BlobPut { hash: h, bytes, .. } => {
                assert_eq!(h, hash);
                assert_eq!(bytes, b"photo");
            }
            f => panic!("expected blob-put, got {}", f.kind()),
        }
        assert_eq!(channel.pending(), 0, "an upload is not a wait");
        match decode_relay_frame(&channel.request(&hash, 1_000, 10_000)).unwrap() {
            RelayFrame::BlobGet { hash: h } => assert_eq!(h, hash),
            f => panic!("expected blob-get, got {}", f.kind()),
        }
        assert_eq!(channel.pending(), 1);
        assert_eq!(channel.next_deadline_ms(), Some(11_000));
    }

    #[test]
    fn channel_settles_each_ask_once_verified_or_not_at_all() {
        let mut channel = BlobChannel::new();
        let hash = hash_of(b"photo");
        assert_eq!(
            channel.answer(&hash, Some(b"photo".to_vec())),
            None,
            "nobody asked"
        );

        channel.request(&hash, 0, 5_000);
        assert_eq!(
            channel.answer(&hash, Some(b"photo".to_vec())),
            Some(BlobAnswer {
                hash: hash.clone(),
                bytes: Some(b"photo".to_vec())
            })
        );
        assert_eq!(
            channel.answer(&hash, Some(b"photo".to_vec())),
            None,
            "answered once"
        );
        assert_eq!(channel.next_deadline_ms(), None);

        channel.request(&hash, 0, 5_000);
        assert_eq!(
            channel.answer(&hash, Some(b"junk".to_vec())),
            Some(BlobAnswer {
                hash: hash.clone(),
                bytes: None
            }),
            "junk consumes the wait and hands on nothing"
        );

        channel.request(&hash, 0, 5_000);
        let missing =
            decode_relay_frame(&syncmesh_core::relay_frames::blob_missing_frame(&hash)).unwrap();
        assert_eq!(
            channel.answer_frame(&missing),
            Some(BlobAnswer {
                hash: hash.clone(),
                bytes: None
            })
        );
        assert_eq!(channel.answer_frame(&RelayFrame::Unknown), None);
    }

    #[test]
    fn channel_gives_up_at_the_deadline() {
        let mut channel = BlobChannel::new();
        let (a, b) = (hash_of(b"a"), hash_of(b"b"));
        channel.request(&a, 0, 1_000);
        channel.request(&b, 0, 5_000);
        assert_eq!(channel.next_deadline_ms(), Some(1_000));
        assert!(channel.expired(999).is_empty());
        assert_eq!(channel.expired(1_000), vec![a.clone()]);
        assert_eq!(
            channel.answer(&a, Some(b"a".to_vec())),
            None,
            "a late answer is dropped"
        );
        assert_eq!(channel.next_deadline_ms(), Some(5_000));
        // asking again extends rather than duplicates
        channel.request(&b, 2_000, 5_000);
        assert_eq!(channel.pending(), 1);
        assert_eq!(channel.next_deadline_ms(), Some(7_000));
        assert_eq!(channel.expired(7_000), vec![b]);
        assert_eq!(channel.next_deadline_ms(), None);
    }

    #[test]
    fn a_put_answer_reads_as_the_typescript_reads_it() {
        let acme = PartitionKey::parse("org:acme").unwrap();
        let refused = |code: &str, partition: Option<PartitionKey>| RelayFrame::BlobRefused {
            hash: "h".to_owned(),
            code: code.to_owned(),
            limit: 40,
            used: 30,
            partition,
        };
        assert_eq!(
            put_answer(&RelayFrame::BlobStored {
                hash: "h".to_owned()
            }),
            Some(("h".to_owned(), None))
        );
        let quota = put_answer(&refused("quota", Some(acme.clone())))
            .unwrap()
            .1
            .unwrap();
        assert_eq!(
            quota.clone().into_error("h"),
            BlobError::QuotaExceeded {
                hash: "h".to_owned(),
                partition: Some(acme.clone()),
                limit: 40,
                used: 30
            }
        );
        assert!(
            quota
                .into_error("h")
                .to_string()
                .contains("org:acme holds 30 of 40")
        );
        assert_eq!(
            put_answer(&refused("ungranted", Some(acme.clone())))
                .unwrap()
                .1,
            Some(PutRefusal::Ungranted { partition: acme })
        );
        // not this put's budget or grant: the putter stays the holder and the put succeeds
        for code in ["no-store", "ungranted", "a-code-from-later"] {
            assert_eq!(
                put_answer(&refused(code, None)),
                Some(("h".to_owned(), None))
            );
        }
        assert_eq!(put_answer(&RelayFrame::Ka), None);
    }
}
