//! The bytes every syncmesh peer must reproduce (D35).
//!
//! One implementation of the layers that have to be bit-identical across Bun, the browser, a
//! phone and a native app: canonical CBOR, hex, identity, the hybrid logical clock and its drift
//! bound, stamps, records and the four lattice joins, the fold, and the event codec with its
//! `[core, sig]` envelope. Measured against `conformance/*.json` before anything else.
//!
//! Every failure is a value. Decoders never panic on foreign bytes.

pub mod apply;
pub mod cbor;
pub mod envelope;
pub mod event;
pub mod event_codec;
pub mod hex;
pub mod hlc;
pub mod identity;
pub mod record;
pub mod row_codec;
pub mod stamp;
pub mod state;
pub mod strategy;

pub use apply::{apply_change, merge_record};
pub use cbor::{Key, Value, decode as decode_cbor, encode as encode_cbor};
pub use envelope::{VerifiedEvent, decode_and_verify, sign_event, split_envelope};
pub use event::{Change, PeerId, SyncEvent, event_id};
pub use event_codec::{decode_event_core, encode_event_core};
pub use hex::{from_hex, to_hex};
pub use hlc::{DEFAULT_MAX_DRIFT_MS, Hlc, HlcClock};
pub use identity::{Identity, verify};
pub use record::{Cell, CellValue, JsonValue, RowRecord, canonical_json};
pub use stamp::Stamp;
pub use state::State;
pub use strategy::{MergeSpec, StrategyName, compare_value, counter_value};
