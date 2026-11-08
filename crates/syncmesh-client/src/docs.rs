//! The document-adapter SPI (RFC-0023 §2.8): what syncmesh needs from a CRDT library to carry and
//! store its documents, mirroring `DocumentAdapter` in `@syncmesh/docs`.

use std::panic::{AssertUnwindSafe, catch_unwind};

use sha2::{Digest, Sha256};

use crate::doc_rules::DerivedColumns;
use syncmesh_core::record::{CellValue, Row};

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

/// One document column as the manifest's shareable half carries it (RFC-0023 §4.1):
/// `{ "column": "content", "doc": "loro@1", "derive": ["title", "wordCount"] }`. The TypeScript
/// schema writes it (`JSON.stringify(schema.docs.get(table))`); the derive functions themselves
/// never leave the runtime that declared them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocColumnEntry {
    pub column: String,
    /// The adapter id, `name@major`.
    pub doc: String,
    /// The columns derived from this one, in declaration order.
    pub derive: Vec<String>,
}

/// Per table, the columns its manifest entries derive: what [`crate::EngineOptions::derived`] takes
/// so the engine refuses a local write naming one.
///
/// # Examples
///
/// ```
/// use syncmesh_client::docs::{DocColumnEntry, derived_columns};
///
/// let manifest = r#"[{ "column": "content", "doc": "loro@1", "derive": ["title"] }]"#;
/// let entries = DocColumnEntry::parse_list(manifest).unwrap();
/// let derived = derived_columns([("notes", entries.as_slice())]);
/// assert!(derived["notes"].contains("title"));
/// ```
pub fn derived_columns<'a>(
    tables: impl IntoIterator<Item = (&'a str, &'a [DocColumnEntry])>,
) -> DerivedColumns {
    tables
        .into_iter()
        .map(|(table, entries)| {
            let columns = entries
                .iter()
                .flat_map(|e| e.derive.iter().cloned())
                .collect();
            (table.to_owned(), columns)
        })
        .collect()
}

impl DocColumnEntry {
    /// Reads one table's entries from the manifest's JSON: an array of
    /// `{ column, doc, derive }` objects. Anything else is [`InvalidDerive`].
    pub fn parse_list(json: &str) -> Result<Vec<DocColumnEntry>, InvalidDerive> {
        let refuse = |message: &str| InvalidDerive {
            column: String::new(),
            message: format!("manifest: {message}"),
        };
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|e| refuse(&e.to_string()))?;
        let entries = value.as_array().ok_or_else(|| refuse("not an array"))?;
        entries
            .iter()
            .map(|entry| {
                let text = |key: &str| {
                    entry
                        .get(key)
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .ok_or_else(|| refuse(&format!("`{key}` is not text")))
                };
                let derive = entry
                    .get("derive")
                    .and_then(serde_json::Value::as_array)
                    .ok_or_else(|| refuse("`derive` is not a list"))?
                    .iter()
                    .map(|name| {
                        name.as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| refuse("a derived column is not text"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(DocColumnEntry {
                    column: text("column")?,
                    doc: text("doc")?,
                    derive,
                })
            })
            .collect()
    }
}

/// A derive declaration that does not fit the manifest, or a manifest that cannot be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidDerive {
    pub column: String,
    pub message: String,
}

impl std::fmt::Display for InvalidDerive {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for InvalidDerive {}

/// A derive closure panicked. The document is unharmed; the derived column keeps its last value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeriveFailed {
    pub column: String,
    pub message: String,
}

impl std::fmt::Display for DeriveFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DeriveFailed {}

type DeriveFn<D> = Box<dyn Fn(&D) -> CellValue + Send + Sync>;

/// The derived columns of one document column, as a Rust app declares them (RFC-0023 §16.4,
/// §16.8): a builder over the manifest's names, no macro. Every replica computes its own values
/// from its own document; they are written to the local row only, never sent as cells.
///
/// # Examples
///
/// ```
/// use syncmesh_client::core::record::CellValue;
/// use syncmesh_client::docs::{Derive, DocColumnEntry};
///
/// let manifest = r#"[{ "column": "content", "doc": "loro@1", "derive": ["title"] }]"#;
/// let entry = &DocColumnEntry::parse_list(manifest).unwrap()[0];
/// let derive = Derive::<String>::new("notes", "content")
///     .with("title", |doc: &String| CellValue::text(doc.lines().next().unwrap_or("")));
/// derive.check(entry).unwrap();
/// let row = derive.compute(&"Q3 plan\nbody".to_owned()).unwrap();
/// assert_eq!(row.get("title"), Some(&CellValue::text("Q3 plan")));
/// ```
pub struct Derive<D> {
    table: String,
    column: String,
    targets: Vec<(String, DeriveFn<D>)>,
}

impl<D> Derive<D> {
    /// No derived columns yet, for the document column `column` of `table`.
    pub fn new(table: impl Into<String>, column: impl Into<String>) -> Self {
        Self {
            table: table.into(),
            column: column.into(),
            targets: Vec::new(),
        }
    }

    /// Declares how `target` is computed from the document.
    pub fn with(
        mut self,
        target: impl Into<String>,
        derive: impl Fn(&D) -> CellValue + Send + Sync + 'static,
    ) -> Self {
        self.targets.push((target.into(), Box::new(derive)));
        self
    }

    /// The derived columns this declares, in the order they were declared.
    pub fn columns(&self) -> impl Iterator<Item = &str> {
        self.targets.iter().map(|(name, _)| name.as_str())
    }

    /// Refuses a declaration that does not match the manifest's entry for this column: another
    /// column, a target the manifest does not derive, one it derives that has no closure here, or
    /// one declared twice. Two runtimes computing different column sets would disagree on rows.
    pub fn check(&self, entry: &DocColumnEntry) -> Result<(), InvalidDerive> {
        let at = |name: &str| format!("{}.{name}", self.table);
        let refuse = |name: &str, why: &str| {
            Err(InvalidDerive {
                column: at(name),
                message: format!("{}: {why}", at(name)),
            })
        };
        if entry.column != self.column {
            return refuse(
                &self.column,
                &format!("the manifest entry is for {}", entry.column),
            );
        }
        for (index, (name, _)) in self.targets.iter().enumerate() {
            if self.targets[..index].iter().any(|(other, _)| other == name) {
                return refuse(name, "derived twice");
            }
            if !entry.derive.contains(name) {
                return refuse(
                    name,
                    &format!("the manifest does not derive it from {}", self.column),
                );
            }
        }
        match entry
            .derive
            .iter()
            .find(|name| !self.targets.iter().any(|(target, _)| target == *name))
        {
            Some(missing) => refuse(
                missing,
                "the manifest derives it, and no closure computes it",
            ),
            None => Ok(()),
        }
    }

    /// Runs every closure over `doc`: the row's derived values. A closure that panics is
    /// [`DeriveFailed`], and nothing is half-computed.
    pub fn compute(&self, doc: &D) -> Result<Row, DeriveFailed> {
        self.targets
            .iter()
            .map(|(name, derive)| {
                catch_unwind(AssertUnwindSafe(|| derive(doc)))
                    .map(|value| (name.clone(), value))
                    .map_err(|_| DeriveFailed {
                        column: format!("{}.{name}", self.table),
                        message: format!("{}.{name}: the derive closure panicked", self.table),
                    })
            })
            .collect()
    }
}
