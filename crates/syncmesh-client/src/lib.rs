//! A syncmesh device in Rust (D37).
//!
//! What `syncmesh-core` deliberately is not: a running thing. This crate is the device around the
//! core — the engine that numbers, signs, appends and folds; the stores it keeps its log and its
//! rows in; the relay link that speaks D36's sealed protocol; the ephemeral tier (D16) and blobs
//! (D18). It is **sans-IO**: every unit here is a state machine that takes bytes and clock
//! readings in and hands frames and facts out, so a host with its own event loop — a GPUI app,
//! a test, a tokio task — drives it without the crate choosing a runtime for it. The `tokio`
//! feature adds the one driver that dials a relay over a WebSocket and runs the machine.
//!
//! Measured against the TypeScript the way the core is measured against the vectors: a device
//! built here converges with the TypeScript relay and the TypeScript client, byte for byte on the
//! wire, and the tests under `tests/` are what prove it.
//!
//! Every failure is a value. Nothing here panics on foreign bytes or a peer's behaviour; a
//! definition mistake in the caller's own configuration is the one thing that may.

pub mod blobs;
pub mod coverage;
pub mod digest;
pub mod doc_log;
pub mod doc_rules;
pub mod docs;
pub mod engine;
pub mod grants;
pub mod holdback;
pub mod interest;
pub mod join;
pub mod manifest;
pub mod peer;
pub mod presence;
pub mod quarantine;
pub mod random;
pub mod rejoin;
pub mod relay;
pub mod room;
pub mod snapshot;
pub mod store;
pub mod undo;
pub mod validate;

#[cfg(feature = "sqlite")]
pub mod sqlite;

#[cfg(feature = "tokio")]
pub mod driver;
#[cfg(feature = "tokio")]
pub mod mesh;

pub use syncmesh_core as core;

pub use blobs::{
    BLOB_ANSWER_WAIT, BlobAnswer, BlobChannel, BlobError, BlobStore, MemoryBlobStore, PutRefusal,
    hash_of, put_answer, verify_blob,
};
pub use coverage::CoverageTracker;
pub use digest::{row_digest, table_digests};
pub use doc_log::{
    DocAddress, DocAppend, DocEntryState, DocHead, DocHeadMode, DocLogEntry, DocStore,
    MemoryDocStore, doc_digests,
};
pub use engine::{
    Engine, EngineOptions, FoldBatch, FoldSource, MutateError, Mutated, OwnPosition, ReceiveReport,
    Received, RevertError, Reverted,
};
pub use grants::{GrantCache, GrantRegistry};
pub use holdback::Holdback;
pub use interest::{
    Interest, InterestWindow, interest_from, interest_key, interest_text, matches_interest,
    narrows, same_interest, scope_from, scope_text, window_rows,
};
pub use join::{
    JoinExchange, JoinOptions, JoinOutcome, JoinPolicy, JoinStep, Settled, SnapshotInstalled,
    Ticket, Withheld,
};
pub use manifest::{
    CheckSchema, ColumnDef, ColumnKind, Manifest, ManifestUnreadable, TableDef, Visibility,
};
pub use peer::{
    Admits, Framing, PeerAction, PeerLink, PeerOptions, PeerSession, SessionOptions, presence_slot,
};
pub use presence::{
    MalformedPresence, Presence, PresenceEntry, PresenceStore, PresenceTier, PresenceTouch,
    VerifiedPresence, decode_and_verify_presence, decode_presence_core, encode_presence_core,
    sign_presence,
};
pub use quarantine::{ParkReason, Parked};
pub use rejoin::{
    Accepted, BelowFloor, BelowFloorReason, FloorSource, PeerJoin, Rejoins, below_floor,
};
pub use relay::{Action, RelayLink, RelayOptions};
pub use room::{Room, RoomAction, RoomOptions, SocketId};
pub use snapshot::{InstallError, Installed, Snapshot};
pub use store::{
    Ahead, Coverage, Cursors, EventStore, MemoryEventStore, MemoryStateStore, RowWrite, StateStore,
    StoreError, StoredEvent,
};
pub use undo::{SkipReason, Skipped};
pub use validate::{
    ColumnCheck, ColumnChecks, GrantSource, LinkRung, PolicySource, Principal, Probe, StateLookup,
    ValidationClock, ValidationError, Validator, ValidatorOptions,
};
