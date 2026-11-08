//! State instead of history (`engine/src/snapshot.ts`, RFC-0019): the rows a peer holds and the
//! coverage they stand for, as one value. [`crate::Engine::snapshot`] takes one and
//! [`crate::Engine::install_snapshot`] lands one; [`crate::join`] carries them between devices.
//!
//! The coverage is the dangerous half: adopting it is what stops a device asking for those events
//! again, so it is adopted only once every row has been installed, and a snapshot incomplete for
//! its scope, adopted anyway, would lose the missing rows forever.

use syncmesh_core::doc::LineageCellRefused;
use syncmesh_core::snapshot_codec::SnapshotRow;

use crate::engine::FoldBatch;
use crate::interest::Interest;
use crate::store::{Coverage, StoreError};

/// Every row in scope, tombstones included, and the coverage they represent.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub rows: Vec<SnapshotRow>,
    /// What the sender had folded when it took this; the joiner adopts it only after installing.
    /// Its `floor` is never set: that is the sender's own account of its log.
    pub coverage: Coverage,
    /// The slice the rows are complete for; `None` means the sender's whole state.
    pub scope: Option<Interest>,
}

/// What an install did.
#[derive(Debug, Clone, PartialEq)]
pub struct Installed {
    pub rows: usize,
    /// One batch for the whole snapshot, however many rows it held (`source` is `Snapshot`).
    pub batch: FoldBatch,
}

/// Why nothing was installed.
#[derive(Debug, Clone, PartialEq)]
pub enum InstallError {
    /// A row holds a lineage cell of a rule this build does not run (RFC-0023 §16.1): refused
    /// whole, so the history behind it still arrives as events.
    Refused(LineageCellRefused),
    /// The state store did not take the rows and coverage; the coverage was not adopted.
    Store(StoreError),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::Refused(refused) => write!(f, "{refused}"),
            InstallError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for InstallError {}

impl From<StoreError> for InstallError {
    fn from(e: StoreError) -> Self {
        InstallError::Store(e)
    }
}
