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
pub mod engine;
pub mod grants;
pub mod holdback;
pub mod interest;
pub mod presence;
pub mod random;
pub mod relay;
pub mod room;
pub mod store;

#[cfg(feature = "sqlite")]
pub mod sqlite;

#[cfg(feature = "tokio")]
pub mod driver;
#[cfg(feature = "tokio")]
pub mod mesh;

pub use syncmesh_core as core;

pub use blobs::{
    BlobAnswer, BlobChannel, BlobError, BlobStore, MemoryBlobStore, hash_of, verify_blob,
};
pub use coverage::CoverageTracker;
pub use engine::{
    Engine, EngineOptions, FoldBatch, FoldSource, MutateError, Mutated, ReceiveReport, Received,
};
pub use grants::{GrantCache, GrantRegistry};
pub use holdback::Holdback;
pub use interest::{Interest, interest_from, interest_text, matches_interest, narrows};
pub use presence::{
    MalformedPresence, Presence, PresenceEntry, PresenceStore, PresenceTier, PresenceTouch,
    VerifiedPresence, decode_and_verify_presence, decode_presence_core, encode_presence_core,
    sign_presence,
};
pub use relay::{Action, RelayLink, RelayOptions};
pub use room::{Room, RoomAction, RoomOptions, SocketId};
pub use store::{
    Ahead, Coverage, Cursors, EventStore, MemoryEventStore, MemoryStateStore, RowWrite, StateStore,
    StoreError, StoredEvent,
};
