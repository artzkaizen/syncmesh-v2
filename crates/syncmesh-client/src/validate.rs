//! The shared validator (`engine/src/validate.ts` and the rungs it calls), ported so a Rust device
//! reaches the TypeScript's verdict on every event (gap U3): the same ladder, the same refusal
//! tags, the same quarantine buckets, driven by the manifest as data ([`Manifest`]).
//!
//! The ladder, first failure wins: clock → grant → device → revocation → grace → (per change)
//! reserved tables → table → partition → the row's partition → cells and documents → policy.
//! `conformance/policy-vectors.json` freezes its verdicts and both runtimes replay them.
//!
//! Not ported, because the TypeScript has it only as a function: a column's `check()` schema
//! ([`Manifest::checked_columns`]). And not reachable here: a local write (this crate writes
//! none), so a write to a `local` table is always `LocalOnly`, as a remote one is in TypeScript.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};

use sha2::{Digest, Sha256};
use syncmesh_core::account::{AccountCore, LinkOp, encode_account_core, verify_link};
use syncmesh_core::doc::DocColumns;
use syncmesh_core::envelope::split_envelope;
use syncmesh_core::event::{AccountId, Change, PartitionKey, PeerId, SeqNum, SyncEvent};
use syncmesh_core::grant::Grant;
use syncmesh_core::hex::to_hex;
use syncmesh_core::hlc::Hlc;
use syncmesh_core::policy::{AllowBlock, PolicyContext, PolicyGrant, evaluate, parse_policy_doc};
use syncmesh_core::record::{CellValue, JsonValue, Row};
use syncmesh_core::state::{State, TableState};

use crate::doc_rules::{DocEvent, DocRung, check_doc};
use crate::grants::GrantRegistry;
use crate::manifest::{ColumnDef, ColumnKind, Manifest, TableDef, Visibility};
use crate::quarantine::ParkReason;

/// Why a link row is refused — the TypeScript's `LinkRung`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkRung {
    Columns,
    Key,
    Isolation,
    Author,
    Signature,
}

impl LinkRung {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkRung::Columns => "columns",
            LinkRung::Key => "key",
            LinkRung::Isolation => "isolation",
            LinkRung::Author => "author",
            LinkRung::Signature => "signature",
        }
    }
}

/// The ladder's verdict on an event, one variant per TypeScript `ValidationError` tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    /// Stamped further ahead of `now` than the drift bound (D34).
    ClockAhead {
        peer: PeerId,
        at_ms: i64,
        limit_ms: i64,
    },
    NoGrant {
        peer: PeerId,
    },
    GrantDeviceMismatch {
        peer: PeerId,
        device: PeerId,
    },
    /// The device's powers were withdrawn in this instance before the event was written.
    GrantRevoked {
        peer: PeerId,
        partition: String,
    },
    /// The instance's grace window says the grant is too old for it (RFC-0016).
    GrantStale {
        peer: PeerId,
        expires_at_ms: i64,
    },
    LinkRefused {
        key: String,
        rung: LinkRung,
        message: &'static str,
    },
    UnknownTable {
        table: String,
    },
    /// A table the manifest dropped (D31).
    TableDropped {
        table: String,
    },
    /// This device's own write to a retired table or column (D31).
    RetiredWrite {
        table: String,
        column: Option<String>,
    },
    UnknownChangeKind {
        table: String,
        kind: String,
    },
    PartitionNotGranted {
        table: String,
        partition: String,
    },
    WrongPartition {
        table: String,
        expected: String,
    },
    LocalOnly {
        table: String,
    },
    ReadOnlyPartition {
        table: String,
    },
    SchemaViolation {
        table: String,
        key: String,
        column: String,
        message: &'static str,
    },
    DocChangeRefused {
        table: String,
        key: String,
        column: String,
        rung: DocRung,
        message: &'static str,
    },
    /// A row write naming a document or derived column.
    DocColumnWrite {
        table: String,
        key: String,
        column: String,
    },
    PolicyDenied {
        table: String,
        key: String,
        op: String,
    },
}

impl ValidationError {
    /// The TypeScript's `_tag`: what a refusal receipt names as its verdict.
    pub fn tag(&self) -> &'static str {
        match self {
            ValidationError::ClockAhead { .. } => "ClockAhead",
            ValidationError::NoGrant { .. } => "NoGrant",
            ValidationError::GrantDeviceMismatch { .. } => "GrantDeviceMismatch",
            ValidationError::GrantRevoked { .. } => "GrantRevoked",
            ValidationError::GrantStale { .. } => "GrantStale",
            ValidationError::LinkRefused { .. } => "LinkRefused",
            ValidationError::UnknownTable { .. } => "UnknownTable",
            ValidationError::TableDropped { .. } => "TableDropped",
            ValidationError::RetiredWrite { .. } => "RetiredWrite",
            ValidationError::UnknownChangeKind { .. } => "UnknownChangeKind",
            ValidationError::PartitionNotGranted { .. } => "PartitionNotGranted",
            ValidationError::WrongPartition { .. } => "WrongPartition",
            ValidationError::LocalOnly { .. } => "LocalOnly",
            ValidationError::ReadOnlyPartition { .. } => "ReadOnlyPartition",
            ValidationError::SchemaViolation { .. } => "SchemaViolation",
            ValidationError::DocChangeRefused { .. } => "DocChangeRefused",
            ValidationError::DocColumnWrite { .. } => "DocColumnWrite",
            ValidationError::PolicyDenied { .. } => "PolicyDenied",
        }
    }

    /// The rung a doc or link refusal names; `None` for every other verdict.
    pub fn rung(&self) -> Option<&'static str> {
        match self {
            ValidationError::DocChangeRefused { rung, .. } => Some(rung.as_str()),
            ValidationError::LinkRefused { rung, .. } => Some(rung.as_str()),
            _ => None,
        }
    }

    /// The bucket the verdict parks in.
    pub fn reason(&self) -> ParkReason {
        match self {
            ValidationError::UnknownTable { .. } => ParkReason::UnknownTable,
            ValidationError::TableDropped { .. } => ParkReason::DroppedTable,
            ValidationError::UnknownChangeKind { .. } => ParkReason::UnknownKind,
            _ => ParkReason::Refused,
        }
    }
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationError::ClockAhead {
                at_ms, limit_ms, ..
            } => {
                write!(
                    f,
                    "stamped {at_ms}, past the {limit_ms} this device believes in"
                )
            }
            ValidationError::NoGrant { .. } => f.write_str("no grant held for this author"),
            ValidationError::GrantDeviceMismatch { .. } => {
                f.write_str("the grant names another device")
            }
            ValidationError::GrantRevoked { partition, .. } => {
                write!(f, "this device was revoked from {partition}")
            }
            ValidationError::GrantStale { .. } => f.write_str("this grant is too old: renew it"),
            ValidationError::LinkRefused { message, .. } => f.write_str(message),
            ValidationError::UnknownTable { table } => write!(f, "{table}: not in the schema"),
            ValidationError::TableDropped { table } => {
                write!(
                    f,
                    "{table}: dropped from the schema; an older build still writes it"
                )
            }
            ValidationError::RetiredWrite {
                table,
                column: None,
            } => {
                write!(f, "{table} is retired: nothing here writes it")
            }
            ValidationError::RetiredWrite {
                table,
                column: Some(column),
            } => {
                write!(f, "{table}.{column} is retired: nothing here writes it")
            }
            ValidationError::UnknownChangeKind { table, kind } => {
                write!(f, "{table}: this build has no fold for a {kind} change")
            }
            ValidationError::PartitionNotGranted { .. } => {
                f.write_str("the author's grant does not list this partition")
            }
            ValidationError::WrongPartition { table, expected } => {
                write!(f, "{table}: expected a {expected} partition")
            }
            ValidationError::LocalOnly { table } => {
                write!(f, "{table}: a local table never travels")
            }
            ValidationError::ReadOnlyPartition { table } => {
                write!(f, "{table} is written by the authority")
            }
            ValidationError::SchemaViolation {
                table,
                column,
                message,
                ..
            } => {
                write!(f, "{table}.{column}: {message}")
            }
            ValidationError::DocChangeRefused { message, .. } => f.write_str(message),
            ValidationError::DocColumnWrite { table, column, .. } => {
                write!(
                    f,
                    "{table}.{column} is opened or computed, never written as a value"
                )
            }
            ValidationError::PolicyDenied { table, op, .. } => write!(f, "{op} on {table} denied"),
        }
    }
}

impl std::error::Error for ValidationError {}

/// Who may write: the grants a device holds for other peers, looked up by author.
pub trait GrantSource {
    /// The author's live grant at `now_ms`, or `None` — expired reads as absent.
    fn grant_for(&self, peer: &PeerId, now_ms: i64) -> Option<Grant>;
}

impl GrantSource for GrantRegistry {
    fn grant_for(&self, peer: &PeerId, now_ms: i64) -> Option<Grant> {
        GrantRegistry::grant_for(self, peer, now_ms).cloned()
    }
}

/// A registry the mesh shares with its link, which registers grants as they arrive.
impl GrantSource for Arc<Mutex<GrantRegistry>> {
    fn grant_for(&self, peer: &PeerId, now_ms: i64) -> Option<Grant> {
        let registry = self.lock().unwrap_or_else(PoisonError::into_inner);
        GrantRegistry::grant_for(&registry, peer, now_ms).cloned()
    }
}

/// What the validator runs on.
pub struct ValidatorOptions {
    pub manifest: Manifest,
    /// `None` is ungranted mode: grant and policy rungs are skipped; schema never is. So a `deny`
    /// rule is not enforced — there is nobody to deny, because no write names a grant.
    /// Under a `Mesh` with an issuer, `None` is filled with the mesh's own
    /// registry, which its link registers arriving grants into; a source given here is kept.
    pub grants: Option<Box<dyn GrantSource + Send>>,
    /// The one peer whose events may write `global`, authority and the authority's reserved
    /// tables; checked against the event's author. `None`, those are read-only everywhere.
    pub authority: Option<PeerId>,
    /// Resolves an author to the account a `_links` row binds it to, where no grant is held
    /// (D21). Shipped config on every peer, never a capability.
    pub accounts: bool,
}

/// The event as validation reads it. A probe — this device's own write before it is numbered —
/// has no `seq` and no `hlc`, which reads as "now".
#[derive(Debug, Clone, Copy)]
pub struct Probe<'a> {
    pub peer_id: &'a PeerId,
    pub partition: Option<&'a PartitionKey>,
    pub changes: &'a [Change],
    pub seq: Option<SeqNum>,
    pub hlc: Option<Hlc>,
}

impl<'a> Probe<'a> {
    /// A numbered event as every receiving peer judges it.
    pub fn event(event: &'a SyncEvent) -> Probe<'a> {
        Probe {
            peer_id: &event.peer_id,
            partition: event.partition.as_ref(),
            changes: &event.changes,
            seq: Some(event.seq_num),
            hlc: Some(event.hlc),
        }
    }
}

/// What the device holds about the rows an event touches.
pub trait StateLookup {
    /// The visible row; `None` when absent or deleted.
    fn row(&self, table: &str, key: &str) -> Option<Row>;
    /// The instance the row was first written in.
    fn partition(&self, table: &str, key: &str) -> Option<String>;
    /// Every record of a table, for the one reader that needs more than a key: resolving a link.
    fn records(&self, table: &str) -> Option<&TableState>;
}

impl StateLookup for State {
    fn row(&self, table: &str, key: &str) -> Option<Row> {
        self.read_row(table, key)
    }

    fn partition(&self, table: &str, key: &str) -> Option<String> {
        self.record(table, key)?.partition.clone()
    }

    fn records(&self, table: &str) -> Option<&TableState> {
        self.tables.get(table)
    }
}

/// The clock a verdict is reached under: `now`, and how far ahead of it a stamp may run.
#[derive(Debug, Clone, Copy)]
pub struct ValidationClock {
    pub now_ms: i64,
    pub max_drift_ms: Option<i64>,
}

const POLICY: &str = "_policy";
const CORRECTIONS: &str = "_corrections";
const REVOCATIONS: &str = "_revocations";
const LINKS: &str = "_links";
const CDC: &str = "_cdc";

/// The kinds every app has; what they are is their rule.
const RESERVED_KINDS: [&str; 3] = ["global", "user", "local"];

/// Who a rule is evaluated for, as the author rung resolved it.
#[derive(Debug, Clone)]
struct Author {
    account: String,
    role: Option<String>,
    claims: BTreeMap<String, JsonValue>,
    /// The partitions whatever vouched for it confined it to; `None` when it named none (a link).
    partitions: Option<Vec<PartitionKey>>,
}

impl From<Grant> for Author {
    fn from(grant: Grant) -> Author {
        Author {
            account: grant.account,
            role: grant.role,
            claims: grant.claims,
            partitions: Some(grant.partitions),
        }
    }
}

/// The ladder, over one manifest.
pub struct Validator {
    manifest: Manifest,
    docs: DocColumns,
    grants: Option<Box<dyn GrantSource + Send>>,
    authority: Option<PeerId>,
    accounts: bool,
    /// Every `_links` wire whose signature was checked, and whether it held: an Ed25519 verify
    /// per wire, not per wire per event judged (`accounts.ts` keeps the same per-wire memo).
    signed: Mutex<BTreeMap<Vec<u8>, bool>>,
}

impl Validator {
    pub fn new(options: ValidatorOptions) -> Validator {
        Validator {
            docs: options.manifest.doc_columns(),
            manifest: options.manifest,
            grants: options.grants,
            authority: options.authority,
            accounts: options.accounts,
            signed: Mutex::default(),
        }
    }

    /// Whether the account signed this link, checked once per wire.
    fn link_signed(&self, wire: &[u8]) -> bool {
        let mut signed = self.signed.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(&held) = signed.get(wire) {
            return held;
        }
        let held = verify_link(wire).is_ok();
        signed.insert(wire.to_vec(), held);
        held
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// The doc columns the ladder judges by — the manifest's own, unless the engine was handed
    /// others, and always what the engine's fold joins by the lineage rule.
    pub fn doc_columns(&self) -> &DocColumns {
        &self.docs
    }

    /// Judges doc changes against `docs` rather than the manifest's: the engine's own, when its
    /// options name them.
    pub(crate) fn judge_docs(&mut self, docs: DocColumns) {
        self.docs = docs;
    }

    /// Whether the manifest marks the column retired (D31): what a compensation leaves out.
    pub fn retired_column(&self, table: &str, column: &str) -> bool {
        self.manifest
            .tables
            .get(table)
            .and_then(|t| t.columns.get(column))
            .is_some_and(|c| c.retired)
    }

    /// The ladder's verdict on one event against what the device holds. `clock` absent, no stamp
    /// is judged by the clock and no grace window applies — the same as a TypeScript validator
    /// given no `now`.
    pub fn validate(
        &self,
        event: &Probe<'_>,
        before: &dyn StateLookup,
        clock: Option<ValidationClock>,
    ) -> Result<(), ValidationError> {
        check_clock(event, clock)?;
        let author = self.check_author(event, before, clock.map(|c| c.now_ms))?;
        for (index, change) in event.changes.iter().enumerate() {
            let table = change.table();
            if let Some(columns) = self.reserved_table(table) {
                self.check_reserved(table, columns, change, event)?;
                continue;
            }
            let entry = self.resolve_entry(table, event)?;
            self.check_partition(table, entry, event, author.as_ref())?;
            if let Some(held) = before.partition(table, change.key())
                && Some(held.as_str()) != event.partition.map(PartitionKey::as_str)
            {
                return Err(ValidationError::WrongPartition {
                    table: table.to_owned(),
                    expected: held,
                });
            }
            if self.check_cells(table, entry, change, event, index, before)? == Cells::Settled {
                continue;
            }
            let synced = synced_rules(table, event.partition, before);
            let rules = synced.as_ref().or(entry.allow.as_ref());
            self.check_policy(table, entry, rules, change, author.as_ref(), before)?;
        }
        Ok(())
    }

    /// The reserved table's columns, when the change names one this mesh installs.
    fn reserved_table(&self, table: &str) -> Option<Option<&BTreeMap<String, ColumnDef>>> {
        [POLICY, CORRECTIONS, REVOCATIONS, LINKS, CDC]
            .contains(&table)
            .then(|| self.manifest.reserved.get(table))
    }

    /// Who is writing, and whether they may still write at all: a grant held, naming this
    /// device, not withdrawn since it was issued, and recent enough for the instance.
    fn check_author(
        &self,
        event: &Probe<'_>,
        before: &dyn StateLookup,
        now_ms: Option<i64>,
    ) -> Result<Option<Author>, ValidationError> {
        let Some(grants) = &self.grants else {
            return Ok(if self.accounts {
                linked_author(event, before, &|wire| self.link_signed(wire))
            } else {
                None
            });
        };
        let peer = event.peer_id;
        // a registry with no clock to judge expiry against is no registry: `i64::MIN` reads
        // every grant as live, the TypeScript's grantFor with the clock left out
        let Some(grant) = grants.grant_for(peer, now_ms.unwrap_or(i64::MIN)) else {
            return Err(ValidationError::NoGrant { peer: peer.clone() });
        };
        if &grant.device != peer {
            return Err(ValidationError::GrantDeviceMismatch {
                peer: peer.clone(),
                device: grant.device,
            });
        }
        check_revoked(event, &grant, before)?;
        // the authority is exempt from the window it publishes, never from a revocation
        if self.authority.as_ref() == Some(peer) {
            return Ok(Some(grant.into()));
        }
        check_stale(event, &grant, before, now_ms)?;
        Ok(Some(grant.into()))
    }

    /// The manifest's own tables, held to the signature their author class names.
    fn check_reserved(
        &self,
        table: &str,
        columns: Option<&BTreeMap<String, ColumnDef>>,
        change: &Change,
        event: &Probe<'_>,
    ) -> Result<(), ValidationError> {
        let Some(columns) = columns else {
            return Err(ValidationError::UnknownTable {
                table: table.to_owned(),
            });
        };
        if table == CDC && event.partition.is_some() {
            return Err(ValidationError::WrongPartition {
                table: table.to_owned(),
                expected: String::new(),
            });
        }
        if table == LINKS {
            check_link(change, event, &|wire| self.link_signed(wire))?;
        } else if self.authority.as_ref() != Some(event.peer_id) {
            return Err(ValidationError::ReadOnlyPartition {
                table: table.to_owned(),
            });
        }
        if let Change::Doc(d) = change {
            return Err(ValidationError::DocChangeRefused {
                table: table.to_owned(),
                key: d.key.clone(),
                column: d.column.clone(),
                rung: DocRung::Column,
                message: "the manifest's own tables have no document columns",
            });
        }
        check_columns(table, columns, change, None, true)
    }

    /// The entry a change's table has, as this build may write it.
    fn resolve_entry(&self, table: &str, event: &Probe<'_>) -> Result<&TableDef, ValidationError> {
        let Some(entry) = self.manifest.tables.get(table) else {
            return Err(if self.manifest.dropped.contains(table) {
                ValidationError::TableDropped {
                    table: table.to_owned(),
                }
            } else {
                ValidationError::UnknownTable {
                    table: table.to_owned(),
                }
            });
        };
        if entry.retired && event.seq.is_none() {
            return Err(ValidationError::RetiredWrite {
                table: table.to_owned(),
                column: None,
            });
        }
        Ok(entry)
    }

    fn check_partition(
        &self,
        table: &str,
        entry: &TableDef,
        event: &Probe<'_>,
        author: Option<&Author>,
    ) -> Result<(), ValidationError> {
        let by_authority = self.authority.as_ref() == Some(event.peer_id);
        let read_only = || ValidationError::ReadOnlyPartition {
            table: table.to_owned(),
        };
        let kind = entry.partition.as_str();
        if entry.visibility == Visibility::Authority {
            return if by_authority {
                Ok(())
            } else {
                Err(read_only())
            };
        }
        if kind == "local" {
            return Err(ValidationError::LocalOnly {
                table: table.to_owned(),
            });
        }
        if kind == "global" {
            return if by_authority {
                Ok(())
            } else {
                Err(read_only())
            };
        }
        let actual = event.partition.map(PartitionKey::as_str).unwrap_or("");
        let matches = match author {
            Some(author) if kind == "user" => actual == format!("user:{}", author.account),
            _ => actual
                .strip_prefix(kind)
                .and_then(|rest| rest.strip_prefix(':'))
                .is_some_and(|instance| !instance.is_empty()),
        };
        if !matches {
            return Err(ValidationError::WrongPartition {
                table: table.to_owned(),
                expected: kind.to_owned(),
            });
        }
        let confined = author.and_then(|a| a.partitions.as_ref());
        match confined {
            Some(partitions)
                if !RESERVED_KINDS.contains(&kind)
                    && !partitions.iter().any(|p| p.as_str() == actual) =>
            {
                Err(ValidationError::PartitionNotGranted {
                    table: table.to_owned(),
                    partition: actual.to_owned(),
                })
            }
            _ => Ok(()),
        }
    }

    /// A change's cells against its table, and a doc change against the rules only a document
    /// has. `Settled` when a doc change rides on an insert of its row in the same event, which
    /// is judged as part of that insert (RFC-0023 §11).
    fn check_cells(
        &self,
        table: &str,
        entry: &TableDef,
        change: &Change,
        event: &Probe<'_>,
        index: usize,
        before: &dyn StateLookup,
    ) -> Result<Cells, ValidationError> {
        let declared = self.docs.get(table);
        check_columns(table, &entry.columns, change, declared, event.seq.is_none())?;
        let Change::Doc(d) = change else {
            return Ok(Cells::Policy);
        };
        let at = DocEvent {
            peer: event.peer_id,
            seq: event.seq,
            changes: event.changes,
        };
        let adapter = declared.and_then(|cols| cols.get(&d.column));
        if let Some(refused) =
            check_doc(d, index, at, adapter, entry.columns.contains_key(&d.column))
        {
            return Err(ValidationError::DocChangeRefused {
                table: table.to_owned(),
                key: d.key.clone(),
                column: d.column.clone(),
                rung: refused.rung,
                message: refused.message,
            });
        }
        if before.row(table, &d.key).is_some() {
            return Ok(Cells::Policy);
        }
        let inserts = event.changes.iter().any(
            |c| matches!(c, Change::Insert { table: t, key, .. } if t == table && key == &d.key),
        );
        Ok(if inserts {
            Cells::Settled
        } else {
            Cells::Policy
        })
    }

    fn check_policy(
        &self,
        table: &str,
        entry: &TableDef,
        rules: Option<&AllowBlock>,
        change: &Change,
        author: Option<&Author>,
        before: &dyn StateLookup,
    ) -> Result<(), ValidationError> {
        let (Some(author), Some(rules)) = (author, rules) else {
            return Ok(());
        };
        let (op, patch) = match change {
            Change::Insert { row, .. } => ("insert", Some(row.clone())),
            Change::Update { patch, .. } => ("update", Some(patch.clone())),
            Change::Delete { .. } => ("delete", None),
            // to the ladder a doc change is an update of its row — and a genesis is `replace`,
            // which falls back to `update` when the block has no rule of its own (§16.2)
            Change::Doc(d) => (
                if d.genesis { "replace" } else { "update" },
                Some(Row::from([(d.column.clone(), CellValue::Null)])),
            ),
            // check_columns refuses it first; said as a value all the same, never a panic
            Change::Unknown { tag, .. } => return Err(unknown_kind(table, *tag)),
        };
        let row = before.row(table, change.key());
        let ctx = PolicyContext {
            grant: PolicyGrant {
                account: &author.account,
                role: author.role.as_deref(),
                claims: &author.claims,
            },
            roles: self.manifest.roles(&entry.partition),
            row: row.as_ref(),
            patch: patch.as_ref(),
        };
        if evaluate(rules.resolve(op), &ctx) {
            Ok(())
        } else {
            Err(ValidationError::PolicyDenied {
                table: table.to_owned(),
                key: change.key().to_owned(),
                op: op.to_owned(),
            })
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cells {
    Policy,
    Settled,
}

/// A change kind no fold here understands, checked over the whole event before any rung reads a
/// cell — and with no validator too, because the crash it prevents is the fold's (D22-A).
pub fn unfoldable(event: &SyncEvent) -> Option<ValidationError> {
    event.changes.iter().find_map(|change| match change {
        Change::Unknown { tag, table, .. } => Some(unknown_kind(table, *tag)),
        _ => None,
    })
}

/// The refusal of a change kind this build has no fold for, named as the TypeScript names it.
fn unknown_kind(table: &str, tag: u64) -> ValidationError {
    ValidationError::UnknownChangeKind {
        table: table.to_owned(),
        kind: format!("unknown({tag})"),
    }
}

/// A stamp further ahead of `now` than the bound is `ClockAhead`. A probe carries no stamp and is
/// not judged; ahead only, since a stamp from the past is history.
fn check_clock(event: &Probe<'_>, clock: Option<ValidationClock>) -> Result<(), ValidationError> {
    let (
        Some(hlc),
        Some(ValidationClock {
            now_ms,
            max_drift_ms: Some(drift),
        }),
    ) = (event.hlc, clock)
    else {
        return Ok(());
    };
    let limit_ms = now_ms.saturating_add(drift);
    if hlc.ms <= limit_ms {
        return Ok(());
    }
    Err(ValidationError::ClockAhead {
        peer: event.peer_id.clone(),
        at_ms: hlc.ms,
        limit_ms,
    })
}

/// A reserved integer cell, as the TypeScript's `moment`: a number, or 0 for anything else.
fn moment(value: Option<&CellValue>) -> f64 {
    match value {
        Some(CellValue::Number(n)) => *n,
        _ => 0.0,
    }
}

/// The `_policy` record for one instance, as this device holds it.
fn policy_row(partition: Option<&PartitionKey>, before: &dyn StateLookup) -> Option<Row> {
    before.row(POLICY, partition?.as_str())
}

/// Whether this device's powers were withdrawn in the instance, before the event was written
/// and after the grant was issued (RFC-0016).
fn check_revoked(
    event: &Probe<'_>,
    grant: &Grant,
    before: &dyn StateLookup,
) -> Result<(), ValidationError> {
    let Some(partition) = event.partition else {
        return Ok(());
    };
    let key = format!("{}:{}", partition.as_str(), event.peer_id.as_str());
    let Some(record) = before.row(REVOCATIONS, &key) else {
        return Ok(());
    };
    let at = moment(record.get("at"));
    if grant.issued_at_ms as f64 > at {
        return Ok(());
    }
    // a probe has no stamp, so it is happening now, which is after any revocation already folded
    if event.hlc.is_some_and(|hlc| (hlc.ms as f64) < at) {
        return Ok(());
    }
    Err(ValidationError::GrantRevoked {
        peer: event.peer_id.clone(),
        partition: partition.as_str().to_owned(),
    })
}

/// Whether the instance still trusted a grant this old when the event was written: its `_policy`
/// row's `grace`, against the event's own stamp. No clock, no check.
fn check_stale(
    event: &Probe<'_>,
    grant: &Grant,
    before: &dyn StateLookup,
    now_ms: Option<i64>,
) -> Result<(), ValidationError> {
    let Some(now_ms) = now_ms else { return Ok(()) };
    let grace = policy_row(event.partition, before).and_then(|row| match row.get("grace") {
        None | Some(CellValue::Null) => None,
        other => Some(moment(other)),
    });
    let Some(grace) = grace else { return Ok(()) };
    let at = event.hlc.map_or(now_ms, |hlc| hlc.ms) as f64;
    if at + grace < grant.expires_at_ms as f64 {
        return Ok(());
    }
    Err(ValidationError::GrantStale {
        peer: event.peer_id.clone(),
        expires_at_ms: grant.expires_at_ms,
    })
}

/// The rules for one table as the instance's `_policy` row states them, when one has synced and
/// parses. Absent or unparsable, the bundled manifest stands.
fn synced_rules(
    table: &str,
    partition: Option<&PartitionKey>,
    before: &dyn StateLookup,
) -> Option<AllowBlock> {
    let row = policy_row(partition, before)?;
    let rules @ CellValue::Object(_) = row.get("rules")? else {
        return None;
    };
    let mut doc = parse_policy_doc(&rules.as_json()?).ok()?;
    doc.remove(table)
}

/// The value a row write sets per column, and the columns its change names.
fn written_cells(change: &Change) -> Option<&Row> {
    match change {
        Change::Insert { row, .. } => Some(row),
        Change::Update { patch, .. } => Some(patch),
        _ => None,
    }
}

/// A change against the table it names: a kind this build can fold, cells that pass the columns
/// it declares, and no row write to a document column. Derived and retired columns are refused
/// only on a `probe`; on a numbered event their cells are dropped from the check, as an
/// undeclared column's are (D13).
fn check_columns(
    table: &str,
    columns: &BTreeMap<String, ColumnDef>,
    change: &Change,
    docs: Option<&BTreeMap<String, String>>,
    probe: bool,
) -> Result<(), ValidationError> {
    if let Change::Unknown { tag, .. } = change {
        return Err(unknown_kind(table, *tag));
    }
    if probe {
        let named: Vec<&String> = match change {
            Change::Doc(d) => vec![&d.column],
            _ => written_cells(change)
                .map(|c| c.keys().collect())
                .unwrap_or_default(),
        };
        if let Some(column) = named
            .into_iter()
            .find(|c| columns.get(*c).is_some_and(|def| def.retired))
        {
            return Err(ValidationError::RetiredWrite {
                table: table.to_owned(),
                column: Some(column.clone()),
            });
        }
    }
    let (Some(cells), insert) = (
        written_cells(change),
        matches!(change, Change::Insert { .. }),
    ) else {
        return Ok(());
    };
    let key = change.key();
    let derived = |column: &str| columns.get(column).is_some_and(|def| def.derived.is_some());
    if let Some(column) = cells
        .keys()
        .find(|c| docs.is_some_and(|d| d.contains_key(*c)) || (probe && derived(c)))
    {
        return Err(ValidationError::DocColumnWrite {
            table: table.to_owned(),
            key: key.to_owned(),
            column: column.clone(),
        });
    }
    let violation = |column: &str, message| ValidationError::SchemaViolation {
        table: table.to_owned(),
        key: key.to_owned(),
        column: column.to_owned(),
        message,
    };
    // the cells this build checks: declared, and not derived
    let checked = |column: &str| columns.contains_key(column) && !derived(column);
    if insert {
        for (column, def) in columns {
            let value = cells.get(column).filter(|_| checked(column));
            if value.is_none() && (def.nullable || def.derived.is_some()) {
                continue;
            }
            check_value(def, value).map_err(|m| violation(column, m))?;
        }
        return Ok(());
    }
    for (column, value) in cells.iter().filter(|(c, _)| checked(c)) {
        check_value(&columns[column], Some(value)).map_err(|m| violation(column, m))?;
    }
    Ok(())
}

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// JavaScript's `Number.isSafeInteger`.
fn is_safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER
}

fn is_safe_json_integer(v: &JsonValue) -> bool {
    matches!(v, JsonValue::Number(n) if is_safe_integer(*n))
}

/// `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
fn is_canonical_uuid(s: &str) -> bool {
    let groups: Vec<&str> = s.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// A `counter` column's two wire shapes: the increment an event carries (`{"+": n}`), and the
/// per-author totals a snapshot carries (`{"p": {…}, "n": {…}}`).
fn accepts_counter(value: &CellValue) -> bool {
    let CellValue::Object(held) = value else {
        return false;
    };
    if let Some(increment) = held.get("+") {
        return is_safe_json_integer(increment);
    }
    held.keys().all(|k| k == "p" || k == "n")
        && held.values().all(|side| match side {
            JsonValue::Object(totals) => totals.values().all(is_safe_json_integer),
            _ => false,
        })
}

/// One wire value against its column: nullability, then the kind. A `check()` is not run here
/// (it is a function, and the manifest only says it exists).
fn check_value(column: &ColumnDef, value: Option<&CellValue>) -> Result<(), &'static str> {
    let value = match value {
        None => {
            return Err(if column.nullable {
                "undefined is not null"
            } else {
                "column is not nullable"
            });
        }
        Some(CellValue::Null) if column.nullable => return Ok(()),
        Some(CellValue::Null) => return Err("column is not nullable"),
        Some(v) => v,
    };
    if column.merge.as_deref() == Some("counter") {
        return accepts_counter(value)
            .then_some(())
            .ok_or("expected a counter increment or totals");
    }
    let accepted = match column.kind {
        ColumnKind::Text => matches!(value, CellValue::Text(_)),
        ColumnKind::Integer => matches!(value, CellValue::Number(n) if is_safe_integer(*n)),
        ColumnKind::Float | ColumnKind::Timestamp => {
            matches!(value, CellValue::Number(n) if n.is_finite())
        }
        ColumnKind::Boolean => matches!(value, CellValue::Bool(_)),
        ColumnKind::Json => !matches!(value, CellValue::Bytes(_)),
        ColumnKind::Blob => matches!(value, CellValue::Bytes(_)),
        ColumnKind::Uuid => matches!(value, CellValue::Text(s) if is_canonical_uuid(s)),
    };
    accepted
        .then_some(())
        .ok_or("the value is not of the column's kind")
}

/// What `instance:device:digest` names, sliced as the TypeScript slices it: by UTF-16 code unit
/// from the end, since device and digest are fixed-width hex.
fn split_link_key(key: &str) -> (String, String) {
    let units: Vec<u16> = key.encode_utf16().collect();
    let slice = |from: isize, to: isize| {
        let len = units.len() as isize;
        let at = |i: isize| (if i < 0 { (len + i).max(0) } else { i.min(len) }) as usize;
        let (from, to) = (at(from), at(to));
        String::from_utf16_lossy(if from < to { &units[from..to] } else { &[] })
    };
    (slice(0, -130), slice(-129, -65))
}

/// The key a link is filed under: the instance, the device, and the digest of the signed core.
fn link_key(partition: &PartitionKey, device: &PeerId, core: &[u8]) -> String {
    format!(
        "{}:{}:{}",
        partition.as_str(),
        device.as_str(),
        to_hex(&Sha256::digest(core))
    )
}

fn refuse_link(key: &str, rung: LinkRung, message: &'static str) -> ValidationError {
    ValidationError::LinkRefused {
        key: key.to_owned(),
        rung,
        message,
    }
}

/// Whether a `_links` change is one every peer should fold, with the Ed25519 verify last.
fn check_link(
    change: &Change,
    event: &Probe<'_>,
    signed: &dyn Fn(&[u8]) -> bool,
) -> Result<(), ValidationError> {
    let key = change.key();
    let cells = match change {
        Change::Delete { .. } => {
            return Err(refuse_link(
                key,
                LinkRung::Columns,
                "a link ends with an unlink, never with a delete",
            ));
        }
        Change::Unknown { .. } => {
            return Err(refuse_link(
                key,
                LinkRung::Columns,
                "a link this build cannot read is not a link it can admit",
            ));
        }
        Change::Doc(_) => {
            return Err(refuse_link(
                key,
                LinkRung::Columns,
                "a link carries no document",
            ));
        }
        Change::Insert { row, .. } | Change::Update { patch: row, .. } => row,
    };
    let (instance, device) = split_link_key(key);
    let device = PeerId::parse(&device).ok();
    let in_instance = instance == event.partition.map(PartitionKey::as_str).unwrap_or("");
    let Some(device) = device.filter(|_| in_instance) else {
        return Err(refuse_link(
            key,
            LinkRung::Key,
            "a link is filed as `instance:device:digest`, in the instance it holds in",
        ));
    };
    if event.changes.len() > 1 {
        return Err(refuse_link(
            key,
            LinkRung::Isolation,
            "a link travels alone, or it takes the write beside it down",
        ));
    }
    // a device may claim only itself; anyone may carry an unlink
    if moment(cells.get("kind")) == 0.0 && event.peer_id != &device {
        return Err(refuse_link(
            key,
            LinkRung::Author,
            "a device may claim only itself",
        ));
    }
    resolve_link(key, |name| cells.get(name), signed).map(|_| ())
}

/// What a row's own bytes say, once its columns have been proved to say the same thing.
fn resolve_link<'a>(
    key: &str,
    cell: impl Fn(&str) -> Option<&'a CellValue>,
    signed: &dyn Fn(&[u8]) -> bool,
) -> Result<AccountCore, ValidationError> {
    let Some(CellValue::Bytes(wire)) = cell("wire") else {
        return Err(refuse_link(
            key,
            LinkRung::Columns,
            "the row carries no link bytes",
        ));
    };
    let Some(stated) = stated_core(key, &cell) else {
        return Err(refuse_link(
            key,
            LinkRung::Columns,
            "the columns are not a link core",
        ));
    };
    let Ok((core, _)) = split_envelope(wire) else {
        return Err(refuse_link(
            key,
            LinkRung::Columns,
            "the link bytes are not an envelope",
        ));
    };
    if core != encode_account_core(&stated) {
        return Err(refuse_link(
            key,
            LinkRung::Columns,
            "the columns do not say what the signed core says",
        ));
    }
    if key != link_key(&stated.partition, &stated.device, &core) {
        return Err(refuse_link(
            key,
            LinkRung::Key,
            "this row is not filed under its own core",
        ));
    }
    if signed(wire) {
        Ok(stated)
    } else {
        Err(refuse_link(
            key,
            LinkRung::Signature,
            "the account did not sign this link",
        ))
    }
}

/// The core a row states, read from its key and its columns alone — never from the blob.
fn stated_core<'a>(
    key: &str,
    cell: &impl Fn(&str) -> Option<&'a CellValue>,
) -> Option<AccountCore> {
    let (instance, device) = split_link_key(key);
    let account = match cell("account") {
        Some(CellValue::Text(s)) => AccountId::parse(s).ok()?,
        _ => AccountId::parse("").ok()?,
    };
    let device = PeerId::parse(&device).ok()?;
    let partition = PartitionKey::parse(&instance).ok()?;
    let op = match moment(cell("kind")) {
        0.0 => LinkOp::Link,
        1.0 => LinkOp::Unlink,
        _ => return None,
    };
    let at = moment(cell("at"));
    // a fractional instant is no instant: the TypeScript's `fromEpochMilliseconds` refuses it too
    if at.fract() != 0.0 {
        return None;
    }
    Some(AccountCore {
        op,
        account,
        device,
        partition,
        at_ms: at as i64,
    })
}

/// Whether link `a` stands over link `b` for one `(instance, device)`: the later `at`, an unlink
/// winning a tie, and the smaller account id beyond that.
fn beats(a: &AccountCore, b: &AccountCore) -> bool {
    if a.at_ms != b.at_ms {
        return a.at_ms > b.at_ms;
    }
    if a.op != b.op {
        return a.op == LinkOp::Unlink;
    }
    a.account.as_str() < b.account.as_str()
}

/// The account this device answers to in this instance, when a standing link says so and the
/// row's own bytes still agree. No role and no partitions: a link signs neither.
fn linked_author(
    event: &Probe<'_>,
    before: &dyn StateLookup,
    signed: &dyn Fn(&[u8]) -> bool,
) -> Option<Author> {
    let partition = event.partition?;
    let rows = before.records(LINKS)?;
    let mut standing: Option<AccountCore> = None;
    for (key, record) in rows {
        if record.delete_stamp.is_some() {
            continue;
        }
        let Ok(core) = resolve_link(key, |name| record.cells.get(name).map(|c| &c.value), signed)
        else {
            continue;
        };
        if &core.partition != partition || &core.device != event.peer_id {
            continue;
        }
        if standing.as_ref().is_none_or(|held| beats(&core, held)) {
            standing = Some(core);
        }
    }
    let link = standing.filter(|core| core.op == LinkOp::Link)?;
    Some(Author {
        account: link.account.as_str().to_owned(),
        role: None,
        claims: BTreeMap::new(),
        partitions: None,
    })
}

/// What the batch has already admitted, layered over what the device held before it, so an
/// update is judged against the row an insert beside it made (`engine/src/admit.ts`). Only
/// admitted events are layered: a refusal never furnishes the row that clears the next one.
pub struct Overlay<'a> {
    before: &'a State,
    rows: BTreeMap<(String, String), Option<Row>>,
    partitions: BTreeMap<(String, String), String>,
}

impl<'a> Overlay<'a> {
    pub fn new(before: &'a State) -> Overlay<'a> {
        Overlay {
            before,
            rows: BTreeMap::new(),
            partitions: BTreeMap::new(),
        }
    }

    /// Layers an admitted event's row writes. A doc change moves no cell a rule reads.
    pub fn took(&mut self, event: &SyncEvent) {
        for change in &event.changes {
            let id = (change.table().to_owned(), change.key().to_owned());
            match change {
                Change::Delete { .. } => {
                    self.rows.insert(id, None);
                }
                Change::Insert { row, .. } => {
                    if let Some(p) = &event.partition {
                        self.partitions.insert(id.clone(), p.as_str().to_owned());
                    }
                    self.rows.insert(id, Some(row.clone()));
                }
                Change::Update { patch, .. } => {
                    let current = match self.rows.get(&id) {
                        Some(Some(row)) => Some(row.clone()),
                        _ => self.before.read_row(&id.0, &id.1),
                    };
                    // an update to a row nothing has written stays absent
                    let Some(mut row) = current else { continue };
                    row.extend(patch.iter().map(|(c, v)| (c.clone(), v.clone())));
                    self.rows.insert(id, Some(row));
                }
                Change::Doc(_) | Change::Unknown { .. } => {}
            }
        }
    }
}

impl StateLookup for Overlay<'_> {
    fn row(&self, table: &str, key: &str) -> Option<Row> {
        match self.rows.get(&(table.to_owned(), key.to_owned())) {
            Some(layered) => layered.clone(),
            None => self.before.read_row(table, key),
        }
    }

    fn partition(&self, table: &str, key: &str) -> Option<String> {
        self.partitions
            .get(&(table.to_owned(), key.to_owned()))
            .cloned()
            .or_else(|| StateLookup::partition(self.before, table, key))
    }

    fn records(&self, table: &str) -> Option<&TableState> {
        self.before.tables.get(table)
    }
}
