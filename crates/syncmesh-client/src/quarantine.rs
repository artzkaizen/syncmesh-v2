//! The events this build would not take (`engine/src/quarantine.ts`, D13): kept with the verdict
//! it reached, bounded per reason, oldest first, and never in the log.
//!
//! Ordered as the TypeScript orders them — buckets in the order they were first used, each in the
//! order its events were parked, a re-parked event moving to the back of its bucket — because the
//! retry after a fold re-offers them in this order, and the order is what a batch is judged in.

use syncmesh_core::refusal::QuarantineReason;

use crate::store::StoredEvent;
use crate::validate::ValidationError;

/// The bucket an event parks in: the [`QuarantineReason`]s a refusal receipt carries, and one
/// that never leaves this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParkReason {
    UnknownTable,
    /// An older build's write to a table this build dropped (D31). Its own bucket and cap, so an
    /// old fleet's traffic cannot evict what `unknown-table` holds for the next upgrade.
    DroppedTable,
    UnknownKind,
    Refused,
}

impl ParkReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ParkReason::UnknownTable => "unknown-table",
            ParkReason::DroppedTable => "dropped-table",
            ParkReason::UnknownKind => "unknown-kind",
            ParkReason::Refused => "refused",
        }
    }

    /// What a refusal receipt says for the bucket: `dropped-table` travels as `refused` (D31).
    pub fn wire(self) -> QuarantineReason {
        match self {
            ParkReason::UnknownTable => QuarantineReason::UnknownTable,
            ParkReason::UnknownKind => QuarantineReason::UnknownKind,
            ParkReason::DroppedTable | ParkReason::Refused => QuarantineReason::Refused,
        }
    }

    /// Whether new state could clear the verdict, which is what the retry after a fold re-offers.
    /// Only a refusal: no row landing teaches a build a table, or un-drops one.
    pub fn cleared_by_state(self) -> bool {
        self == ParkReason::Refused
    }
}

/// One parked event: the entry as it arrived, and the verdict this build reached about it.
#[derive(Debug, Clone, PartialEq)]
pub struct Parked {
    pub entry: StoredEvent,
    pub reason: ParkReason,
    pub verdict: ValidationError,
}

/// The parked events, per reason.
#[derive(Debug, Clone, Default)]
pub struct Quarantine {
    limit: usize,
    buckets: Vec<(ParkReason, Vec<Parked>)>,
}

impl Quarantine {
    /// Holds at most `limit` events per reason.
    pub fn new(limit: usize) -> Quarantine {
        Quarantine {
            limit,
            buckets: Vec::new(),
        }
    }

    /// Parks an event, replacing any earlier parking of the same one; drops the bucket's oldest
    /// when it is full.
    pub fn park(&mut self, parked: Parked) {
        let reason = parked.reason;
        let at = match self.buckets.iter().position(|(r, _)| *r == reason) {
            Some(at) => at,
            None => {
                self.buckets.push((reason, Vec::new()));
                self.buckets.len() - 1
            }
        };
        let bucket = &mut self.buckets[at].1;
        let id = parked.entry.id();
        bucket.retain(|p| p.entry.id() != id);
        bucket.push(parked);
        if bucket.len() > self.limit {
            let excess = bucket.len() - self.limit;
            bucket.drain(..excess);
        }
    }

    /// Every parked event, bucket by bucket.
    pub fn list(&self) -> impl Iterator<Item = &Parked> {
        self.buckets.iter().flat_map(|(_, bucket)| bucket.iter())
    }

    pub fn is_empty(&self) -> bool {
        self.buckets.iter().all(|(_, bucket)| bucket.is_empty())
    }

    /// Every parked event, removed.
    pub fn take(&mut self) -> Vec<Parked> {
        std::mem::take(&mut self.buckets)
            .into_iter()
            .flat_map(|(_, bucket)| bucket)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use syncmesh_core::event::{SeqNum, SyncEvent};
    use syncmesh_core::hlc::Hlc;
    use syncmesh_core::identity::Identity;

    fn parked(seq: u64, verdict: ValidationError) -> Parked {
        let event = SyncEvent {
            peer_id: Identity::from_seed(&[7; 32]).peer_id().clone(),
            seq_num: SeqNum::parse(seq).unwrap(),
            hlc: Hlc::new(1, 0),
            procedure: "t".into(),
            partition: None,
            changes: Vec::new(),
            sealed: false,
            action: None,
            undo_of: None,
            schema_version: None,
        };
        Parked {
            entry: StoredEvent {
                event,
                core: None,
                sig: None,
            },
            reason: verdict.reason(),
            verdict,
        }
    }

    fn unknown() -> ValidationError {
        ValidationError::UnknownTable { table: "x".into() }
    }

    fn refused() -> ValidationError {
        ValidationError::LocalOnly { table: "x".into() }
    }

    #[test]
    fn buckets_keep_their_first_use_order_and_their_own_cap() {
        let mut q = Quarantine::new(2);
        q.park(parked(1, refused()));
        q.park(parked(2, unknown()));
        q.park(parked(3, refused()));
        // re-parked: to the back of its bucket, never a second copy
        q.park(parked(1, refused()));
        let seqs = |q: &Quarantine| {
            q.list()
                .map(|p| p.entry.event.seq_num.get())
                .collect::<Vec<_>>()
        };
        assert_eq!(seqs(&q), vec![3, 1, 2]);
        // a full bucket drops its own oldest, and no other bucket's
        q.park(parked(4, refused()));
        assert_eq!(seqs(&q), vec![1, 4, 2]);
        assert_eq!(q.take().len(), 3);
        assert!(q.is_empty());
    }
}
