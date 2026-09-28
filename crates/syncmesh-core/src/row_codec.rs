//! A row as a CBOR map of column name to cell; the form event cores and persisted state share.

use std::collections::BTreeMap;

use crate::cbor::{Key, Value};
use crate::record::{CellValue, JsonValue, Row};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MalformedRow {
    pub message: &'static str,
}

impl std::fmt::Display for MalformedRow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "malformed row: {}", self.message)
    }
}

impl std::error::Error for MalformedRow {}

fn json_to_cbor(v: &JsonValue) -> Value {
    match v {
        JsonValue::Null => Value::Null,
        JsonValue::Bool(b) => Value::Bool(*b),
        JsonValue::Number(n) => Value::number(*n),
        JsonValue::Text(s) => Value::Text(s.clone()),
        JsonValue::Array(items) => Value::Array(items.iter().map(json_to_cbor).collect()),
        JsonValue::Object(o) => Value::Map(
            o.iter()
                .map(|(k, v)| (Key::Text(k.clone()), json_to_cbor(v)))
                .collect(),
        ),
    }
}

pub fn cell_to_cbor(v: &CellValue) -> Value {
    match v {
        CellValue::Null => Value::Null,
        CellValue::Bool(b) => Value::Bool(*b),
        CellValue::Number(n) => Value::number(*n),
        CellValue::Text(s) => Value::Text(s.clone()),
        CellValue::Bytes(b) => Value::Bytes(b.clone()),
        CellValue::Array(items) => Value::Array(items.iter().map(json_to_cbor).collect()),
        CellValue::Object(o) => Value::Map(
            o.iter()
                .map(|(k, v)| (Key::Text(k.clone()), json_to_cbor(v)))
                .collect(),
        ),
    }
}

pub fn row_to_cbor(row: &Row) -> Value {
    Value::Map(
        row.iter()
            .map(|(c, v)| (Key::Text(c.clone()), cell_to_cbor(v)))
            .collect(),
    )
}

fn json_from_cbor(v: &Value) -> Result<JsonValue, MalformedRow> {
    Ok(match v {
        Value::Null => JsonValue::Null,
        Value::Bool(b) => JsonValue::Bool(*b),
        Value::Int(n) => JsonValue::Number(*n as f64),
        Value::Float(f) => JsonValue::Number(*f),
        Value::Text(s) => JsonValue::Text(s.clone()),
        Value::Bytes(_) => {
            return Err(MalformedRow {
                message: "bytes are only allowed at the top of a cell",
            });
        }
        Value::Array(items) => {
            JsonValue::Array(items.iter().map(json_from_cbor).collect::<Result<_, _>>()?)
        }
        Value::Map(m) => {
            let mut o = BTreeMap::new();
            for (k, v) in m {
                let Key::Text(k) = k else {
                    return Err(MalformedRow {
                        message: "json object keys must be text",
                    });
                };
                o.insert(k.clone(), json_from_cbor(v)?);
            }
            JsonValue::Object(o)
        }
    })
}

/// Bytes are accepted only at the top of a cell; nested, they are refused.
pub fn cell_from_cbor(v: &Value) -> Result<CellValue, MalformedRow> {
    match v {
        Value::Bytes(b) => Ok(CellValue::Bytes(b.clone())),
        other => json_from_cbor(other).map(CellValue::from),
    }
}

pub fn row_from_cbor(v: Option<&Value>) -> Result<Row, MalformedRow> {
    let Some(Value::Map(m)) = v else {
        return Err(MalformedRow {
            message: "row is not a map",
        });
    };
    let mut row = Row::new();
    for (k, v) in m {
        let Key::Text(column) = k else {
            return Err(MalformedRow {
                message: "column name is not text",
            });
        };
        row.insert(column.clone(), cell_from_cbor(v)?);
    }
    Ok(row)
}
