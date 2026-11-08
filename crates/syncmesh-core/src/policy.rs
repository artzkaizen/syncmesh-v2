//! Rules as data (`@syncmesh/policy`): the AST every peer evaluates, the `allow` ladder a block
//! resolves through, and the parser for a synced `_policy` row (RFC-0008).
//!
//! Pure: two devices with the same node and context reach the same verdict. No clock, no
//! lookups. Strings order by UTF-16 code units and scalars compare by kind, exactly as the
//! TypeScript's `===` and `<` do, so a `compare` rule over text says the same thing in both.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use crate::record::{CellValue, JsonValue, Row};

/// How a column stands to a constant. Ordered comparisons hold only between two scalars of one
/// kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompareOp {
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
}

impl CompareOp {
    /// The op as the AST spells it, or `None` for anything else.
    pub fn parse(s: &str) -> Option<CompareOp> {
        Some(match s {
            "ne" => CompareOp::Ne,
            "lt" => CompareOp::Lt,
            "lte" => CompareOp::Lte,
            "gt" => CompareOp::Gt,
            "gte" => CompareOp::Gte,
            _ => return None,
        })
    }
}

/// A rule as data: no closures, so every device evaluates the same one and it can sync as the
/// `_policy` row.
#[derive(Debug, Clone, PartialEq)]
pub enum PolicyNode {
    Allow,
    Deny,
    /// The grant's role is this one, or more senior on the kind's ladder.
    Role(String),
    /// The row's column equals the grant's account.
    Owner(String),
    /// The row's column value is in the list the grant carries under `claim` (dotted path).
    ClaimHas {
        claim: String,
        column: String,
    },
    ClaimEquals {
        claim: String,
        column: String,
    },
    /// A constant is in the list the grant carries under `claim` — `can(module, action)`.
    ClaimIncludes {
        claim: String,
        value: String,
    },
    RowIs(BTreeMap<String, CellValue>),
    /// The row's column stands in this relation to a constant.
    Compare {
        column: String,
        op: CompareOp,
        value: CellValue,
    },
    /// The row's column is one of these constants.
    IsIn {
        column: String,
        values: Vec<CellValue>,
    },
    /// Every column the write touches is one of these.
    PatchOnly(Vec<String>),
    Any(Vec<PolicyNode>),
    All(Vec<PolicyNode>),
    Not(Box<PolicyNode>),
}

/// Rules per operation, `$default` included. `write` covers insert, update and delete;
/// `$default` covers everything else.
#[derive(Debug, Clone, PartialEq)]
pub struct AllowBlock {
    rules: BTreeMap<String, PolicyNode>,
}

const DEFAULT: &str = "$default";

impl AllowBlock {
    /// A block from its rules; `None` without a `$default`, which every block needs.
    pub fn new(rules: BTreeMap<String, PolicyNode>) -> Option<AllowBlock> {
        rules.contains_key(DEFAULT).then_some(AllowBlock { rules })
    }

    /// The rule a block names for `op` itself, before any fallback.
    pub fn get(&self, op: &str) -> Option<&PolicyNode> {
        self.rules.get(op)
    }

    /// `block[op] ?? block.write (for writes) ?? block.$default` — and a `replace` with no rule
    /// of its own resolves exactly as `update` does (RFC-0023 §16.2).
    pub fn resolve(&self, op: &str) -> &PolicyNode {
        if op == "replace" {
            return match self.rules.get("replace") {
                Some(rule) => rule,
                None => self.resolve("update"),
            };
        }
        let write = matches!(op, "insert" | "update" | "delete");
        self.rules
            .get(op)
            .or_else(|| write.then(|| self.rules.get("write")).flatten())
            .or_else(|| self.rules.get(DEFAULT))
            .expect("an allow block always holds $default: `new` and the parser refuse one without")
    }
}

/// The roles a partition kind names, and whether their order is seniority (a ladder, most
/// senior first) or nothing at all (a flat set).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RoleSet {
    pub names: Vec<String>,
    pub ordered: bool,
}

/// What a rule may read about the caller: the account, role and claims whatever vouched for it
/// signed. Nothing else.
#[derive(Debug, Clone, Copy)]
pub struct PolicyGrant<'a> {
    pub account: &'a str,
    pub role: Option<&'a str>,
    pub claims: &'a BTreeMap<String, JsonValue>,
}

#[derive(Debug, Clone, Copy)]
pub struct PolicyContext<'a> {
    pub grant: PolicyGrant<'a>,
    pub roles: &'a RoleSet,
    /// The row before the write; `None` for an insert or a row the device does not hold.
    pub row: Option<&'a Row>,
    /// The columns the write sets; `None` for a read or a delete.
    pub patch: Option<&'a Row>,
}

/// Whether `node` admits the context.
pub fn evaluate(node: &PolicyNode, ctx: &PolicyContext<'_>) -> bool {
    match node {
        PolicyNode::Allow => true,
        PolicyNode::Deny => false,
        PolicyNode::Role(wanted) => role_at_least(ctx.roles, ctx.grant.role, wanted),
        PolicyNode::Owner(column) => {
            matches!(cell(ctx, column), Some(CellValue::Text(s)) if s == ctx.grant.account)
        }
        PolicyNode::ClaimHas { claim, column } => {
            match (claim_at(ctx.grant.claims, claim), cell(ctx, column)) {
                (Some(JsonValue::Array(list)), Some(value)) => {
                    list.iter().any(|item| same_scalar(&json_cell(item), value))
                }
                _ => false,
            }
        }
        PolicyNode::ClaimIncludes { claim, value } => {
            let wanted = CellValue::Text(value.clone());
            matches!(claim_at(ctx.grant.claims, claim), Some(JsonValue::Array(list))
                if list.iter().any(|item| same_scalar(&json_cell(item), &wanted)))
        }
        PolicyNode::ClaimEquals { claim, column } => {
            match (claim_at(ctx.grant.claims, claim), cell(ctx, column)) {
                (Some(held), Some(value)) => same_scalar(&json_cell(held), value),
                _ => false,
            }
        }
        PolicyNode::RowIs(want) => want
            .iter()
            .all(|(column, expected)| cell(ctx, column).is_some_and(|v| same_scalar(v, expected))),
        PolicyNode::Compare { column, op, value } => compare_cells(cell(ctx, column), *op, value),
        PolicyNode::IsIn { column, values } => {
            cell(ctx, column).is_some_and(|v| values.iter().any(|item| same_scalar(item, v)))
        }
        PolicyNode::PatchOnly(columns) => ctx
            .patch
            .is_none_or(|patch| patch.keys().all(|c| columns.contains(c))),
        PolicyNode::Any(of) => of.iter().any(|n| evaluate(n, ctx)),
        PolicyNode::All(of) => of.iter().all(|n| evaluate(n, ctx)),
        PolicyNode::Not(of) => !evaluate(of, ctx),
    }
}

/// The value a rule sees for a column: the incoming write first, then the stored row.
fn cell<'a>(ctx: &PolicyContext<'a>, column: &str) -> Option<&'a CellValue> {
    ctx.patch
        .and_then(|p| p.get(column))
        .or_else(|| ctx.row.and_then(|r| r.get(column)))
}

/// A claim's JSON as a cell, for the scalar comparison both sides share.
fn json_cell(value: &JsonValue) -> CellValue {
    CellValue::from(value.clone())
}

/// Whether `have` satisfies `role(wanted)`: on a ladder, `wanted` or anyone above it; in a flat
/// set, exactly `wanted`. An unknown role on either side is never enough.
pub fn role_at_least(roles: &RoleSet, have: Option<&str>, wanted: &str) -> bool {
    let Some(have) = have else { return false };
    let position = |name: &str| roles.names.iter().position(|n| n == name);
    match (position(have), position(wanted)) {
        (Some(mine), Some(needed)) if roles.ordered => mine <= needed,
        (Some(mine), Some(needed)) => mine == needed,
        _ => false,
    }
}

/// The value under a dotted path in a grant's claims; `None` when the path leaves the object.
pub fn claim_at<'a>(claims: &'a BTreeMap<String, JsonValue>, path: &str) -> Option<&'a JsonValue> {
    let mut parts = path.split('.');
    let mut current = claims.get(parts.next()?)?;
    for part in parts {
        let JsonValue::Object(object) = current else {
            return None;
        };
        current = object.get(part)?;
    }
    Some(current)
}

/// Scalars compare by value; bytes, arrays and objects never match a rule.
fn same_scalar(a: &CellValue, b: &CellValue) -> bool {
    match (a, b) {
        (CellValue::Null, CellValue::Null) => true,
        (CellValue::Bool(x), CellValue::Bool(y)) => x == y,
        (CellValue::Number(x), CellValue::Number(y)) => x == y,
        (CellValue::Text(x), CellValue::Text(y)) => x == y,
        _ => false,
    }
}

/// JavaScript's string order: by UTF-16 code unit, not by code point.
pub fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// An ordered comparison with the strictness equality has: two scalars of one orderable kind, or
/// false. `ne` holds for any present value that is not the constant.
fn compare_cells(value: Option<&CellValue>, op: CompareOp, expected: &CellValue) -> bool {
    let Some(value) = value else { return false };
    if op == CompareOp::Ne {
        return !same_scalar(expected, value);
    }
    let order = match (value, expected) {
        (CellValue::Number(a), CellValue::Number(b)) => a.partial_cmp(b),
        (CellValue::Text(a), CellValue::Text(b)) => Some(utf16_cmp(a, b)),
        _ => None,
    };
    let Some(order) = order else { return false };
    match op {
        CompareOp::Lt => order == Ordering::Less,
        CompareOp::Lte => order != Ordering::Greater,
        CompareOp::Gt => order == Ordering::Greater,
        CompareOp::Gte => order != Ordering::Less,
        CompareOp::Ne => unreachable!("handled above"),
    }
}

/// One partition instance's rules: table name → its allow block. What a `_policy` row carries.
pub type PolicyDoc = BTreeMap<String, AllowBlock>;

/// A rule that does not parse, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MalformedPolicy {
    pub path: String,
    pub message: &'static str,
}

impl std::fmt::Display for MalformedPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

impl std::error::Error for MalformedPolicy {}

fn malformed<T>(path: &str, message: &'static str) -> Result<T, MalformedPolicy> {
    Err(MalformedPolicy {
        path: path.to_owned(),
        message,
    })
}

/// Parses a synced policy doc. A rule that does not parse is a value; nothing partial is applied.
pub fn parse_policy_doc(json: &JsonValue) -> Result<PolicyDoc, MalformedPolicy> {
    let JsonValue::Object(tables) = json else {
        return malformed("", "expected an object of tables");
    };
    tables
        .iter()
        .map(|(table, block)| Ok((table.clone(), parse_allow_block(block, table)?)))
        .collect()
}

/// Parses one allow block: an object of operations to rules, `$default` among them.
pub fn parse_allow_block(json: &JsonValue, path: &str) -> Result<AllowBlock, MalformedPolicy> {
    let JsonValue::Object(ops) = json else {
        return malformed(path, "an allow block needs $default");
    };
    if !ops.contains_key(DEFAULT) {
        return malformed(path, "an allow block needs $default");
    }
    let rules = ops
        .iter()
        .map(|(op, node)| {
            Ok((
                op.clone(),
                parse_policy_node(node, &format!("{path}.{op}"))?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    Ok(AllowBlock { rules })
}

fn text<'a>(object: &'a BTreeMap<String, JsonValue>, field: &str) -> Option<&'a str> {
    match object.get(field) {
        Some(JsonValue::Text(s)) => Some(s),
        _ => None,
    }
}

/// A JSON scalar as a cell; `None` for an array or an object.
fn scalar(value: &JsonValue) -> Option<CellValue> {
    match value {
        JsonValue::Array(_) | JsonValue::Object(_) => None,
        other => Some(json_cell(other)),
    }
}

/// Parses one rule node.
pub fn parse_policy_node(json: &JsonValue, path: &str) -> Result<PolicyNode, MalformedPolicy> {
    let JsonValue::Object(j) = json else {
        return malformed(path, "a rule needs a kind");
    };
    let Some(kind) = text(j, "kind") else {
        return malformed(path, "a rule needs a kind");
    };
    let named = |field: &str, message| text(j, field).map(str::to_owned).ok_or(message);
    let node = match kind {
        "allow" => Ok(PolicyNode::Allow),
        "deny" => Ok(PolicyNode::Deny),
        "role" => named("role", "role needs a name").map(PolicyNode::Role),
        "owner" => named("column", "owner needs a column").map(PolicyNode::Owner),
        "compare" => {
            let op = text(j, "op").and_then(CompareOp::parse);
            let value = j.get("value").and_then(scalar);
            match (text(j, "column"), op, value) {
                (Some(column), Some(op), Some(value)) => Ok(PolicyNode::Compare {
                    column: column.to_owned(),
                    op,
                    value,
                }),
                _ => Err("compare needs a column, one of ne/lt/lte/gt/gte, and a scalar"),
            }
        }
        "isIn" => {
            let values = match j.get("values") {
                Some(JsonValue::Array(list)) => list.iter().map(scalar).collect::<Option<Vec<_>>>(),
                _ => None,
            };
            match (text(j, "column"), values) {
                (Some(column), Some(values)) => Ok(PolicyNode::IsIn {
                    column: column.to_owned(),
                    values,
                }),
                _ => Err("isIn needs a column and a list of scalars"),
            }
        }
        "claimHas" | "claimEquals" => match (text(j, "claim"), text(j, "column")) {
            (Some(claim), Some(column)) => {
                let (claim, column) = (claim.to_owned(), column.to_owned());
                Ok(if kind == "claimHas" {
                    PolicyNode::ClaimHas { claim, column }
                } else {
                    PolicyNode::ClaimEquals { claim, column }
                })
            }
            _ if kind == "claimHas" => Err("claimHas needs a claim and a column"),
            _ => Err("claimEquals needs a claim and a column"),
        },
        "claimIncludes" => match (text(j, "claim"), text(j, "value")) {
            (Some(claim), Some(value)) => Ok(PolicyNode::ClaimIncludes {
                claim: claim.to_owned(),
                value: value.to_owned(),
            }),
            _ => Err("claimIncludes needs a claim and a value"),
        },
        "rowIs" => match j.get("where") {
            Some(JsonValue::Object(want)) => want
                .iter()
                .map(|(c, v)| scalar(v).map(|v| (c.clone(), v)))
                .collect::<Option<BTreeMap<_, _>>>()
                .map(PolicyNode::RowIs)
                .ok_or("rowIs needs scalar values"),
            _ => Err("rowIs needs scalar values"),
        },
        "patchOnly" => match j.get("columns") {
            Some(JsonValue::Array(list)) => list
                .iter()
                .map(|c| match c {
                    JsonValue::Text(s) => Some(s.clone()),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()
                .map(PolicyNode::PatchOnly)
                .ok_or("patchOnly needs column names"),
            _ => Err("patchOnly needs column names"),
        },
        "any" | "all" => {
            let Some(JsonValue::Array(list)) = j.get("of") else {
                return malformed(path, "expected a list of rules");
            };
            let of = list
                .iter()
                .enumerate()
                .map(|(i, item)| parse_policy_node(item, &format!("{path}.of[{i}]")))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(if kind == "any" {
                PolicyNode::Any(of)
            } else {
                PolicyNode::All(of)
            });
        }
        "not" => {
            let of = j.get("of").unwrap_or(&JsonValue::Null);
            return Ok(PolicyNode::Not(Box::new(parse_policy_node(
                of,
                &format!("{path}.of"),
            )?)));
        }
        _ => Err("unknown rule kind"),
    };
    node.or_else(|message| malformed(path, message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ladder(names: &[&str]) -> RoleSet {
        RoleSet {
            names: names.iter().map(|s| (*s).to_owned()).collect(),
            ordered: true,
        }
    }

    #[test]
    fn a_replace_with_no_rule_of_its_own_resolves_as_update() {
        let mut rules = BTreeMap::new();
        rules.insert("$default".to_owned(), PolicyNode::Deny);
        rules.insert("write".to_owned(), PolicyNode::Role("member".into()));
        let block = AllowBlock::new(rules.clone()).unwrap();
        assert_eq!(block.resolve("replace"), &PolicyNode::Role("member".into()));
        assert_eq!(block.resolve("read"), &PolicyNode::Deny);
        rules.insert("replace".to_owned(), PolicyNode::Role("admin".into()));
        let block = AllowBlock::new(rules).unwrap();
        assert_eq!(block.resolve("replace"), &PolicyNode::Role("admin".into()));
        assert_eq!(block.resolve("update"), &PolicyNode::Role("member".into()));
        assert!(AllowBlock::new(BTreeMap::new()).is_none());
    }

    #[test]
    fn a_ladder_admits_seniors_and_a_flat_set_only_the_role() {
        let roles = ladder(&["admin", "member"]);
        assert!(role_at_least(&roles, Some("admin"), "member"));
        assert!(!role_at_least(&roles, Some("member"), "admin"));
        assert!(!role_at_least(&roles, Some("guest"), "member"));
        assert!(!role_at_least(&roles, None, "member"));
        let flat = RoleSet {
            ordered: false,
            ..roles
        };
        assert!(!role_at_least(&flat, Some("admin"), "member"));
        assert!(role_at_least(&flat, Some("member"), "member"));
    }

    #[test]
    fn text_orders_by_utf16_code_unit_as_javascript_does() {
        // U+1F600 is the surrogate pair D83D DE00, which sorts below U+FF00
        assert_eq!(utf16_cmp("\u{1F600}", "\u{FF00}"), Ordering::Less);
        assert_eq!("\u{1F600}".cmp("\u{FF00}"), Ordering::Greater);
        let row: Row = [("t".to_owned(), CellValue::text("\u{1F600}"))].into();
        let claims = BTreeMap::new();
        let roles = RoleSet::default();
        let ctx = PolicyContext {
            grant: PolicyGrant {
                account: "a",
                role: None,
                claims: &claims,
            },
            roles: &roles,
            row: Some(&row),
            patch: None,
        };
        let lt = PolicyNode::Compare {
            column: "t".into(),
            op: CompareOp::Lt,
            value: CellValue::text("\u{FF00}"),
        };
        assert!(evaluate(&lt, &ctx));
    }

    #[test]
    fn a_policy_doc_parses_whole_or_not_at_all() {
        let rule = |kind: &str| {
            JsonValue::Object([("kind".to_owned(), JsonValue::Text(kind.to_owned()))].into())
        };
        let block = JsonValue::Object([("$default".to_owned(), rule("allow"))].into());
        let doc = JsonValue::Object([("notes".to_owned(), block.clone())].into());
        assert!(
            parse_policy_doc(&doc).unwrap()["notes"]
                .get("$default")
                .is_some()
        );
        let bad = JsonValue::Object(
            [(
                "notes".to_owned(),
                JsonValue::Object(
                    [
                        ("$default".to_owned(), rule("allow")),
                        ("insert".to_owned(), rule("teleport")),
                    ]
                    .into(),
                ),
            )]
            .into(),
        );
        assert_eq!(
            parse_policy_doc(&bad).unwrap_err().path,
            "notes.insert".to_owned()
        );
        let empty = JsonValue::Object([("notes".to_owned(), JsonValue::Object([].into()))].into());
        assert!(parse_policy_doc(&empty).is_err());
    }
}
