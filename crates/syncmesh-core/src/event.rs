//! Identifiers and the event itself: one local write as every peer will see it (RFC-0002).

use crate::hlc::Hlc;
use crate::record::Row;
use crate::stamp::Stamp;

/// A device identity: its Ed25519 public key as 64 lowercase hex characters.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PeerId(String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidId {
    pub input: String,
    pub message: &'static str,
}

impl std::fmt::Display for InvalidId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {:?}", self.message, self.input)
    }
}

impl std::error::Error for InvalidId {}

pub const HEX_ID_EXPECTED: &str = "expected 64 lowercase hex characters";

fn is_hex_id(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl PeerId {
    pub fn parse(input: &str) -> Result<PeerId, InvalidId> {
        if is_hex_id(input) {
            Ok(PeerId(input.to_owned()))
        } else {
            Err(InvalidId {
                input: input.to_owned(),
                message: HEX_ID_EXPECTED,
            })
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The public key the id spells.
    pub fn key_bytes(&self) -> [u8; 32] {
        let bytes = crate::hex::from_hex(&self.0).expect("a peer id is valid hex by construction");
        bytes.try_into().expect("64 hex characters are 32 bytes")
    }
}

impl std::fmt::Display for PeerId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// An account, the same 64-hex shape as a device (D21). Nothing may render one as the other.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AccountId(String);

impl AccountId {
    pub fn parse(input: &str) -> Result<AccountId, InvalidId> {
        if is_hex_id(input) {
            Ok(AccountId(input.to_owned()))
        } else {
            Err(InvalidId {
                input: input.to_owned(),
                message: HEX_ID_EXPECTED,
            })
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A positive integer: the author's own count of its events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SeqNum(u64);

impl SeqNum {
    pub fn parse(n: u64) -> Option<SeqNum> {
        (1..=crate::cbor::MAX_SAFE_INTEGER as u64)
            .contains(&n)
            .then_some(SeqNum(n))
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

/// `kind:id` — the one form a partition instance takes (D07): `^[a-z][a-z0-9_]{0,63}:[^\s:]{1,255}$`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PartitionKey(String);

impl PartitionKey {
    pub fn parse(input: &str) -> Result<PartitionKey, InvalidId> {
        let invalid = || InvalidId {
            input: input.to_owned(),
            message: "expected kind:id",
        };
        let (kind, id) = input.split_once(':').ok_or_else(invalid)?;
        let mut kind_bytes = kind.bytes();
        let head_ok = kind_bytes.next().is_some_and(|b| b.is_ascii_lowercase());
        let tail_ok = kind.len() <= 64
            && kind_bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        let id_units = id.encode_utf16().count();
        let id_ok =
            (1..=255).contains(&id_units) && !id.chars().any(|c| c.is_whitespace() || c == ':');
        if head_ok && tail_ok && id_ok {
            Ok(PartitionKey(input.to_owned()))
        } else {
            Err(invalid())
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// `clinic` out of `clinic:ward-3`.
    pub fn kind(&self) -> &str {
        self.0.split_once(':').map(|(k, _)| k).unwrap_or(&self.0)
    }
}

pub type TableName = String;
pub type RowKey = String;
pub type Procedure = String;

#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    Insert {
        table: TableName,
        key: RowKey,
        row: Row,
    },
    Update {
        table: TableName,
        key: RowKey,
        patch: Row,
    },
    Delete {
        table: TableName,
        key: RowKey,
    },
    /// A change a newer build wrote and this one has no fold for (D22-A), kept exactly as it arrived.
    Unknown {
        tag: u64,
        table: TableName,
        key: RowKey,
        data: Option<crate::cbor::Value>,
    },
}

impl Change {
    pub fn table(&self) -> &str {
        match self {
            Change::Insert { table, .. }
            | Change::Update { table, .. }
            | Change::Delete { table, .. }
            | Change::Unknown { table, .. } => table,
        }
    }

    pub fn key(&self) -> &str {
        match self {
            Change::Insert { key, .. }
            | Change::Update { key, .. }
            | Change::Delete { key, .. }
            | Change::Unknown { key, .. } => key,
        }
    }
}

/// One local write as every peer will see it. Unsigned: the envelope carries the signature.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncEvent {
    pub peer_id: PeerId,
    pub seq_num: SeqNum,
    pub hlc: Hlc,
    pub procedure: Procedure,
    pub partition: Option<PartitionKey>,
    pub changes: Vec<Change>,
    /// The content is sealed and this device holds no key: `changes` is empty because nothing is readable.
    pub sealed: bool,
}

impl SyncEvent {
    pub const VERSION: i64 = 1;

    pub fn id(&self) -> String {
        event_id(&self.peer_id, self.seq_num, false)
    }

    pub fn stamp(&self) -> Stamp {
        Stamp::new(self.hlc, self.peer_id.clone())
    }
}

/// `${peerId}-${seqNum}`, or `${peerId}-L${seqNum}` for a local write.
pub fn event_id(peer: &PeerId, seq: SeqNum, local: bool) -> String {
    format!(
        "{}-{}{}",
        peer.as_str(),
        if local { "L" } else { "" },
        seq.get()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_checked_at_the_door() {
        assert!(PeerId::parse(&"a".repeat(64)).is_ok());
        assert!(PeerId::parse(&"A".repeat(64)).is_err());
        assert!(PeerId::parse(&"a".repeat(63)).is_err());
        assert!(SeqNum::parse(0).is_none());
        assert_eq!(SeqNum::parse(7).unwrap().get(), 7);
        assert!(PartitionKey::parse("org:acme").is_ok());
        assert_eq!(
            PartitionKey::parse("clinic:ward-3").unwrap().kind(),
            "clinic"
        );
        assert!(PartitionKey::parse("Org:acme").is_err());
        assert!(PartitionKey::parse("org:").is_err());
        assert!(PartitionKey::parse("org:a b").is_err());
        assert!(PartitionKey::parse("org:a:b").is_err());
        assert!(PartitionKey::parse("user:acct_b").is_ok());
    }
}
