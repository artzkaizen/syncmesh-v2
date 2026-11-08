//! A manifest as the data the validator reads (`schema/src/portable.ts`, gap U3): tables, their
//! columns and partition kinds, each table's `allow` block, every kind's roles, and the tables the
//! app dropped. The TypeScript writes it with `portableSchema(schema)`; this reads it back.
//!
//! What is not in it, because it has no data form: a column's `check()` schema is a JavaScript
//! function (a Standard Schema validator), so this port cannot run it. The manifest says which
//! columns carry one ([`Manifest::checked_columns`]); a write that only such a check refuses is
//! refused by a TypeScript peer and folded here.

use std::collections::{BTreeMap, BTreeSet};

use syncmesh_core::doc::DocColumns;
use syncmesh_core::policy::{AllowBlock, RoleSet, parse_allow_block};
use syncmesh_core::record::JsonValue;
use syncmesh_core::strategy::{MergeSpec, StrategyName};

/// What a column holds on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnKind {
    Text,
    Integer,
    Float,
    Boolean,
    Timestamp,
    Json,
    Blob,
    Uuid,
}

impl ColumnKind {
    fn parse(s: &str) -> Option<ColumnKind> {
        Some(match s {
            "text" => ColumnKind::Text,
            "integer" => ColumnKind::Integer,
            "float" => ColumnKind::Float,
            "boolean" => ColumnKind::Boolean,
            "timestamp" => ColumnKind::Timestamp,
            "json" => ColumnKind::Json,
            "blob" => ColumnKind::Blob,
            "uuid" => ColumnKind::Uuid,
            _ => return None,
        })
    }
}

/// One column, as the manifest declares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnDef {
    pub kind: ColumnKind,
    pub nullable: bool,
    pub primary_key: bool,
    pub unique: bool,
    /// How it merges; `None` is `lww`.
    pub merge: Option<String>,
    /// The document adapter (`name@major`), on a document column.
    pub doc: Option<String>,
    /// The document column a derived column is computed from (RFC-0023 §16.4).
    pub derived: Option<String>,
    /// Retired (D31): read and folded from peers, refused for this device's own writes.
    pub retired: bool,
    /// A `check()` schema guards it in TypeScript; this port cannot run it.
    pub check: bool,
}

/// Who writes a table's rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Partition,
    /// Only the authority writes it (D24).
    Authority,
}

/// One table, as the manifest declares it.
#[derive(Debug, Clone, PartialEq)]
pub struct TableDef {
    /// The kind its rows live in: `global`, `user`, `local` or a declared one.
    pub partition: String,
    pub visibility: Visibility,
    /// Retired (D31): its events fold, this device's own writes to it are refused.
    pub retired: bool,
    pub columns: BTreeMap<String, ColumnDef>,
    /// The rules as data; `None` for a reserved kind or an authority table.
    pub allow: Option<AllowBlock>,
}

/// The validator's whole view of a schema.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Manifest {
    pub schema_version: u64,
    pub tables: BTreeMap<String, TableDef>,
    /// The manifest's own tables (`_policy`, `_revocations`, …) and their columns.
    pub reserved: BTreeMap<String, BTreeMap<String, ColumnDef>>,
    roles: BTreeMap<String, RoleSet>,
    /// Tables the app dropped (D31): a write to one is `TableDropped`, not `UnknownTable`.
    pub dropped: BTreeSet<String>,
}

/// The text is not a portable manifest (format v1), and the first place it was not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestUnreadable {
    pub path: String,
    pub message: String,
}

impl std::fmt::Display for ManifestUnreadable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "manifest unreadable at {}: {}", self.path, self.message)
    }
}

impl std::error::Error for ManifestUnreadable {}

fn unreadable<T>(path: &str, message: impl Into<String>) -> Result<T, ManifestUnreadable> {
    Err(ManifestUnreadable {
        path: path.to_owned(),
        message: message.into(),
    })
}

type Object = serde_json::Map<String, serde_json::Value>;

/// serde's JSON as the core's, where rules are parsed.
fn core_json(value: &serde_json::Value) -> JsonValue {
    match value {
        serde_json::Value::Null => JsonValue::Null,
        serde_json::Value::Bool(b) => JsonValue::Bool(*b),
        serde_json::Value::Number(n) => JsonValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(s) => JsonValue::Text(s.clone()),
        serde_json::Value::Array(a) => JsonValue::Array(a.iter().map(core_json).collect()),
        serde_json::Value::Object(o) => {
            JsonValue::Object(o.iter().map(|(k, v)| (k.clone(), core_json(v))).collect())
        }
    }
}

fn object<'a>(
    value: Option<&'a serde_json::Value>,
    path: &str,
) -> Result<&'a Object, ManifestUnreadable> {
    match value {
        Some(serde_json::Value::Object(o)) => Ok(o),
        _ => unreadable(path, "expected an object"),
    }
}

fn flag(o: &Object, field: &str, path: &str) -> Result<bool, ManifestUnreadable> {
    match o.get(field) {
        None => Ok(false),
        Some(serde_json::Value::Bool(b)) => Ok(*b),
        Some(_) => unreadable(&format!("{path}.{field}"), "expected a boolean"),
    }
}

fn optional_text(
    o: &Object,
    field: &str,
    path: &str,
) -> Result<Option<String>, ManifestUnreadable> {
    match o.get(field) {
        None => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => unreadable(&format!("{path}.{field}"), "expected text"),
    }
}

fn required(o: &Object, field: &str, path: &str) -> Result<bool, ManifestUnreadable> {
    match o.get(field) {
        Some(serde_json::Value::Bool(b)) => Ok(*b),
        _ => unreadable(&format!("{path}.{field}"), "expected a boolean"),
    }
}

fn column(value: &serde_json::Value, path: &str) -> Result<ColumnDef, ManifestUnreadable> {
    let o = object(Some(value), path)?;
    let kind = o
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .and_then(ColumnKind::parse);
    let Some(kind) = kind else {
        return unreadable(&format!("{path}.kind"), "not a column kind");
    };
    let merge = optional_text(o, "merge", path)?;
    if merge
        .as_deref()
        .is_some_and(|m| StrategyName::parse(m).is_none())
    {
        return unreadable(&format!("{path}.merge"), "not a merge rule");
    }
    Ok(ColumnDef {
        kind,
        nullable: required(o, "nullable", path)?,
        primary_key: required(o, "primaryKey", path)?,
        unique: required(o, "unique", path)?,
        merge,
        doc: optional_text(o, "doc", path)?,
        derived: optional_text(o, "derived", path)?,
        retired: flag(o, "retired", path)?,
        check: flag(o, "check", path)?,
    })
}

fn columns(
    value: Option<&serde_json::Value>,
    path: &str,
) -> Result<BTreeMap<String, ColumnDef>, ManifestUnreadable> {
    object(value, path)?
        .iter()
        .map(|(name, def)| Ok((name.clone(), column(def, &format!("{path}.{name}"))?)))
        .collect()
}

fn table(value: &serde_json::Value, path: &str) -> Result<TableDef, ManifestUnreadable> {
    let o = object(Some(value), path)?;
    let Some(partition) = o.get("partition").and_then(serde_json::Value::as_str) else {
        return unreadable(&format!("{path}.partition"), "expected a kind");
    };
    let visibility = match o.get("visibility").and_then(serde_json::Value::as_str) {
        Some("partition") => Visibility::Partition,
        Some("authority") => Visibility::Authority,
        _ => {
            return unreadable(
                &format!("{path}.visibility"),
                "expected partition or authority",
            );
        }
    };
    let allow = match o.get("allow") {
        None => None,
        Some(block) => Some(
            parse_allow_block(&core_json(block), &format!("{path}.allow"))
                .or_else(|e| unreadable(&e.path, e.message))?,
        ),
    };
    Ok(TableDef {
        partition: partition.to_owned(),
        visibility,
        retired: flag(o, "retired", path)?,
        columns: columns(o.get("columns"), &format!("{path}.columns"))?,
        allow,
    })
}

fn role_set(value: &serde_json::Value, path: &str) -> Result<RoleSet, ManifestUnreadable> {
    let o = object(Some(value), path)?;
    let names = o
        .get("names")
        .and_then(serde_json::Value::as_array)
        .and_then(|names| {
            names
                .iter()
                .map(|n| n.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        });
    let Some(names) = names else {
        return unreadable(&format!("{path}.names"), "expected a list of roles");
    };
    Ok(RoleSet {
        names,
        ordered: required(o, "ordered", path)?,
    })
}

const NO_ROLES: &RoleSet = &RoleSet {
    names: Vec::new(),
    ordered: true,
};

impl Manifest {
    /// Reads what `portableSchema` wrote. Anything else is a value, never a panic.
    pub fn parse(text: &str) -> Result<Manifest, ManifestUnreadable> {
        let value: serde_json::Value =
            serde_json::from_str(text).or_else(|e| unreadable("", e.to_string()))?;
        Manifest::from_json(&value)
    }

    /// [`Manifest::parse`], for JSON already parsed.
    pub fn from_json(value: &serde_json::Value) -> Result<Manifest, ManifestUnreadable> {
        let root = object(Some(value), "")?;
        if root.get("v").and_then(serde_json::Value::as_u64) != Some(1) {
            return unreadable("v", "not a portable manifest (format v1)");
        }
        let Some(schema_version) = root
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            .filter(|v| *v >= 1)
        else {
            return unreadable("schemaVersion", "expected a positive integer");
        };
        let tables = object(root.get("tables"), "tables")?
            .iter()
            .map(|(name, def)| Ok((name.clone(), table(def, &format!("tables.{name}"))?)))
            .collect::<Result<_, _>>()?;
        let reserved = object(root.get("reserved"), "reserved")?
            .iter()
            .map(|(name, def)| {
                let path = format!("reserved.{name}");
                let o = object(Some(def), &path)?;
                Ok((
                    name.clone(),
                    columns(o.get("columns"), &format!("{path}.columns"))?,
                ))
            })
            .collect::<Result<_, _>>()?;
        let roles = object(root.get("roles"), "roles")?
            .iter()
            .map(|(kind, set)| Ok((kind.clone(), role_set(set, &format!("roles.{kind}"))?)))
            .collect::<Result<_, _>>()?;
        let dropped = root
            .get("dropped")
            .and_then(serde_json::Value::as_array)
            .and_then(|names| {
                names
                    .iter()
                    .map(|n| n.as_str().map(str::to_owned))
                    .collect::<Option<BTreeSet<_>>>()
            });
        let Some(dropped) = dropped else {
            return unreadable("dropped", "expected a list of table names");
        };
        Ok(Manifest {
            schema_version,
            tables,
            reserved,
            roles,
            dropped,
        })
    }

    /// The roles a kind's rules may name; none for a reserved or undeclared kind.
    pub fn roles(&self, kind: &str) -> &RoleSet {
        self.roles.get(kind).unwrap_or(NO_ROLES)
    }

    /// Every document column and the adapter it declares — what the engine's `docs` is.
    pub fn doc_columns(&self) -> DocColumns {
        self.tables
            .iter()
            .filter_map(|(name, table)| {
                let docs: BTreeMap<_, _> = table
                    .columns
                    .iter()
                    .filter_map(|(c, def)| def.doc.clone().map(|adapter| (c.clone(), adapter)))
                    .collect();
                (!docs.is_empty()).then(|| (name.clone(), docs))
            })
            .collect()
    }

    /// Every column's merge rule other than `lww` — what the engine's `merge` is.
    pub fn merge(&self) -> MergeSpec {
        self.tables
            .iter()
            .filter_map(|(name, table)| {
                let rules: BTreeMap<_, _> = table
                    .columns
                    .iter()
                    .filter_map(|(c, def)| {
                        let strategy = def.merge.as_deref().and_then(StrategyName::parse)?;
                        (strategy != StrategyName::Lww).then(|| (c.clone(), strategy))
                    })
                    .collect();
                (!rules.is_empty()).then(|| (name.clone(), rules))
            })
            .collect()
    }

    /// `(table, column)` for every column a `check()` guards in TypeScript: the one rule this port
    /// does not run, so a write only it refuses folds here.
    pub fn checked_columns(&self) -> Vec<(&str, &str)> {
        self.tables
            .iter()
            .flat_map(|(name, table)| {
                table
                    .columns
                    .iter()
                    .filter(|(_, def)| def.check)
                    .map(move |(c, _)| (name.as_str(), c.as_str()))
            })
            .collect()
    }
}
