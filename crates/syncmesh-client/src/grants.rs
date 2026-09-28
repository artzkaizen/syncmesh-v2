//! Other peers' grants, held so a device can answer "who is this author?" offline (D08).
//!
//! Two ports with one shape and different trust: `GrantRegistry` (`wire/src/grant-registry.ts`)
//! is a device's, configured with the issuer's key and verifying every grant it holds;
//! `GrantCache` (`relay/src/grant-cache.ts`) is a room's, which holds no issuer key, verifies
//! nothing, and only decides which bytes are worth passing on. Both keep the exact wire they
//! received, because a re-encode of a decoded grant can be shorter than what was signed.

use std::collections::BTreeMap;
use std::collections::btree_map::Entry;

use syncmesh_core::event::PeerId;
use syncmesh_core::grant::{Grant, GrantError, read_grant_origin, verify_grant};
use syncmesh_core::signed::Signed;

/// What an engine holds about other peers' grants. Newest-issued wins, so a replay of an older
/// grant cannot downgrade anyone; expiry is a staleness bound rather than a tombstone.
#[derive(Debug)]
pub struct GrantRegistry {
    issuer: PeerId,
    held: BTreeMap<PeerId, Signed<Grant>>,
    /// Wires that became current since `take_registered` last ran — the sans-IO `onRegistered`.
    registered: Vec<Vec<u8>>,
}

impl GrantRegistry {
    pub fn new(issuer: PeerId) -> GrantRegistry {
        GrantRegistry {
            issuer,
            held: BTreeMap::new(),
            registered: Vec::new(),
        }
    }

    pub fn issuer(&self) -> &PeerId {
        &self.issuer
    }

    /// Verifies under the issuer's key and against `now_ms`, then keeps it if it is the newest
    /// mint for its device. An older re-registration is not an error: the grant now held is
    /// returned, since that is the one the caller should be reasoning from.
    pub fn register(&mut self, wire: &[u8], now_ms: i64) -> Result<&Grant, GrantError> {
        let signed = verify_grant(wire, &self.issuer, now_ms)?;
        let device = signed.value.device.clone();
        match self.held.entry(device) {
            Entry::Occupied(mut current) => {
                if signed.value.issued_at_ms > current.get().value.issued_at_ms {
                    current.insert(signed);
                    self.registered.push(wire.to_vec());
                }
                Ok(&current.into_mut().value)
            }
            Entry::Vacant(slot) => {
                self.registered.push(wire.to_vec());
                Ok(&slot.insert(signed).value)
            }
        }
    }

    fn live(&self, device: &PeerId, now_ms: i64) -> Option<&Signed<Grant>> {
        self.held
            .get(device)
            .filter(|signed| now_ms <= signed.value.expires_at_ms)
    }

    /// The device's grant, or `None` once it has expired — staleness, not a tombstone. Anything
    /// deciding what a device may do asks here.
    pub fn grant_for(&self, device: &PeerId, now_ms: i64) -> Option<&Grant> {
        self.live(device, now_ms).map(|signed| &signed.value)
    }

    /// The exact bytes received for a live grant, for byte-identical re-forwarding.
    pub fn wire_for(&self, device: &PeerId, now_ms: i64) -> Option<&[u8]> {
        self.live(device, now_ms)
            .map(|signed| signed.wire.as_slice())
    }

    /// Every wire held; these travel first in every sync session.
    pub fn all_wires(&self) -> Vec<Vec<u8>> {
        self.held
            .values()
            .map(|signed| signed.wire.clone())
            .collect()
    }

    /// Every grant held, expired ones included — the same population `all_wires` reports,
    /// decoded. A lapsed grant still names the account, role and partitions a renewal re-issues
    /// on; filtering here would leave an authority unable to see the devices that most need
    /// renewing.
    pub fn all(&self) -> Vec<&Grant> {
        self.held.values().map(|signed| &signed.value).collect()
    }

    /// Withdraws it here only; the propagating form is a `_revocations` row. `true` when a grant
    /// was actually dropped — the sans-IO `onForgotten`, which is what keeps a store that
    /// remembers grants from resurrecting one on the next restart.
    pub fn revoke(&mut self, device: &PeerId) -> bool {
        self.held.remove(device).is_some()
    }

    /// The wires that became current since the last call, in order.
    pub fn take_registered(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.registered)
    }
}

/// The grants circulating in one room, one per device — what a joiner is handed on its first
/// catch-up page. Keyed by device rather than by bytes so a re-issued, narrower grant *replaces*
/// the broad one it revokes. Not a `GrantRegistry` — the relay holds no issuer key and verifies
/// nothing.
#[derive(Debug, Default)]
pub struct GrantCache {
    held: BTreeMap<PeerId, (i64, Vec<u8>)>,
}

impl GrantCache {
    pub fn new() -> GrantCache {
        GrantCache::default()
    }

    /// Whether the room should pass this grant on: `false` for an echo or for a mint the room
    /// has already superseded, which is where those bytes stop. A grant whose core will not
    /// decode is passed on uncached — the relay is not the place that judges grants, so it
    /// forwards what it cannot read rather than dropping it.
    pub fn admit(&mut self, wire: &[u8]) -> bool {
        let Ok(origin) = read_grant_origin(wire) else {
            return true;
        };
        match self.held.entry(origin.device) {
            Entry::Occupied(mut current) => {
                if origin.issued_at_ms <= current.get().0 {
                    return false;
                }
                current.insert((origin.issued_at_ms, wire.to_vec()));
            }
            Entry::Vacant(slot) => {
                slot.insert((origin.issued_at_ms, wire.to_vec()));
            }
        }
        true
    }

    /// Every wire held, newest mint per device, in the bytes it arrived as.
    pub fn all(&self) -> Vec<Vec<u8>> {
        self.held.values().map(|(_, wire)| wire.clone()).collect()
    }

    pub fn len(&self) -> usize {
        self.held.len()
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use syncmesh_core::Identity;
    use syncmesh_core::event::PartitionKey;
    use syncmesh_core::grant::{GrantRequest, issue_grant};

    use super::*;

    const NOW: i64 = 1_700_000_000_000;
    const HOUR: i64 = 3_600_000;

    fn seed(start: u8) -> Identity {
        Identity::from_seed(&std::array::from_fn(|i| start + i as u8))
    }

    fn mint(issuer: &Identity, device: &Identity, partitions: &[&str], issued_ms: i64) -> Vec<u8> {
        issue_grant(
            issuer,
            &GrantRequest {
                account: "acct_a".to_owned(),
                device: device.peer_id().clone(),
                role: Some("member".to_owned()),
                partitions: partitions
                    .iter()
                    .map(|p| PartitionKey::parse(p).unwrap())
                    .collect(),
                claims: BTreeMap::new(),
                keys: Vec::new(),
                valid_for_ms: HOUR,
                now_ms: issued_ms,
            },
        )
    }

    #[test]
    fn registry_keeps_the_newest_mint_and_never_downgrades() {
        let (issuer, device) = (seed(1), seed(101));
        let mut registry = GrantRegistry::new(issuer.peer_id().clone());
        let broad = mint(&issuer, &device, &["org:acme", "shelf:s1"], NOW);
        let narrow = mint(&issuer, &device, &["org:acme"], NOW + 1_000);

        let held = registry.register(&broad, NOW).unwrap();
        assert_eq!(held.partitions.len(), 2);
        assert_eq!(registry.take_registered(), vec![broad.clone()]);

        let held = registry.register(&narrow, NOW + 1_000).unwrap();
        assert_eq!(
            held.partitions.len(),
            1,
            "the newer, narrower grant replaces the broad one"
        );
        assert_eq!(registry.take_registered(), vec![narrow.clone()]);

        let held = registry.register(&broad, NOW + 2_000).unwrap();
        assert_eq!(
            held.partitions.len(),
            1,
            "a replay of the older grant returns the current one"
        );
        assert!(
            registry.take_registered().is_empty(),
            "nothing became current"
        );
        assert_eq!(registry.all_wires(), vec![narrow.clone()]);
        assert_eq!(
            registry.wire_for(device.peer_id(), NOW + 2_000),
            Some(narrow.as_slice())
        );
        assert_eq!(registry.all().len(), 1);

        assert!(registry.revoke(device.peer_id()));
        assert!(!registry.revoke(device.peer_id()), "already gone");
        assert!(registry.all().is_empty());
        assert_eq!(registry.grant_for(device.peer_id(), NOW), None);
    }

    #[test]
    fn registry_reads_expired_as_absent_but_still_lists_it() {
        let (issuer, device, other) = (seed(1), seed(101), seed(102));
        let mut registry = GrantRegistry::new(issuer.peer_id().clone());
        registry
            .register(&mint(&issuer, &device, &["org:acme"], NOW), NOW)
            .unwrap();
        registry
            .register(
                &mint(&issuer, &other, &["org:acme"], NOW + HOUR),
                NOW + HOUR,
            )
            .unwrap();
        assert!(
            registry.grant_for(device.peer_id(), NOW + HOUR).is_some(),
            "the last valid ms"
        );
        assert_eq!(registry.grant_for(device.peer_id(), NOW + HOUR + 1), None);
        assert_eq!(registry.wire_for(device.peer_id(), NOW + HOUR + 1), None);
        assert!(
            registry
                .grant_for(other.peer_id(), NOW + HOUR + 1)
                .is_some()
        );
        assert_eq!(registry.all().len(), 2, "expiry is not a tombstone");
        assert_eq!(registry.all_wires().len(), 2);

        // registering a grant that is already expired is refused at the door
        assert!(matches!(
            registry.register(&mint(&issuer, &device, &[], NOW), NOW + 2 * HOUR),
            Err(GrantError::Expired { .. })
        ));
    }

    #[test]
    fn registry_refuses_another_issuer_and_junk() {
        let (issuer, impostor, device) = (seed(1), seed(2), seed(101));
        let mut registry = GrantRegistry::new(issuer.peer_id().clone());
        assert_eq!(
            registry.register(&mint(&impostor, &device, &["org:acme"], NOW), NOW),
            Err(GrantError::BadSignature)
        );
        assert!(matches!(
            registry.register(&[0xff], NOW),
            Err(GrantError::Cbor(_))
        ));
        assert!(registry.all().is_empty());
        assert!(registry.take_registered().is_empty());
    }

    #[test]
    fn cache_admits_the_newest_mint_per_device_and_forwards_what_it_cannot_read() {
        let (issuer, device, other) = (seed(1), seed(101), seed(102));
        let mut cache = GrantCache::new();
        let first = mint(&issuer, &device, &["org:acme", "shelf:s1"], NOW);
        let second = mint(&issuer, &device, &["org:acme"], NOW + 1_000);
        let theirs = mint(&issuer, &other, &["org:acme"], NOW);

        assert!(cache.admit(&first));
        assert!(!cache.admit(&first), "an echo stops here");
        assert!(cache.admit(&theirs));
        assert!(cache.admit(&second));
        assert!(!cache.admit(&first), "a superseded mint stops here");
        assert_eq!(cache.len(), 2);
        let all = cache.all();
        assert!(all.contains(&second) && all.contains(&theirs) && !all.contains(&first));

        assert!(cache.admit(b"not a grant"), "passed on, uncached");
        assert!(
            cache.admit(b"not a grant"),
            "and again: nothing was remembered"
        );
        assert_eq!(cache.len(), 2);
    }
}
