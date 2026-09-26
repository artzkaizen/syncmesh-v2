//! Cells, rows and records — what the fold holds.

use std::collections::BTreeMap;

use crate::stamp::Stamp;

/// JSON, as a cell holds it. Object keys sort by UTF-16 code units, as JavaScript sorts them.
#[derive(Debug, Clone, PartialEq)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>),
}

/// What a cell can hold: JSON, or raw bytes for `blob` columns.
#[derive(Debug, Clone, PartialEq)]
pub enum CellValue {
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
    Bytes(Vec<u8>),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>),
}

impl CellValue {
    pub fn text(s: &str) -> CellValue {
        CellValue::Text(s.to_owned())
    }

    /// The value as JSON, or `None` for bytes.
    pub fn as_json(&self) -> Option<JsonValue> {
        Some(match self {
            CellValue::Null => JsonValue::Null,
            CellValue::Bool(b) => JsonValue::Bool(*b),
            CellValue::Number(n) => JsonValue::Number(*n),
            CellValue::Text(s) => JsonValue::Text(s.clone()),
            CellValue::Array(a) => JsonValue::Array(a.clone()),
            CellValue::Object(o) => JsonValue::Object(o.clone()),
            CellValue::Bytes(_) => return None,
        })
    }

    /// The value as a JSON object, or `None` for anything else — the one door the CRDT cells read foreign values through.
    pub fn as_object(&self) -> Option<&BTreeMap<String, JsonValue>> {
        match self {
            CellValue::Object(o) => Some(o),
            _ => None,
        }
    }
}

impl From<JsonValue> for CellValue {
    fn from(v: JsonValue) -> Self {
        match v {
            JsonValue::Null => CellValue::Null,
            JsonValue::Bool(b) => CellValue::Bool(b),
            JsonValue::Number(n) => CellValue::Number(n),
            JsonValue::Text(s) => CellValue::Text(s),
            JsonValue::Array(a) => CellValue::Array(a),
            JsonValue::Object(o) => CellValue::Object(o),
        }
    }
}

pub type ColumnName = String;
pub type Row = BTreeMap<ColumnName, CellValue>;

#[derive(Debug, Clone, PartialEq)]
pub struct Cell {
    pub value: CellValue,
    pub stamp: Stamp,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct RowRecord {
    pub cells: BTreeMap<ColumnName, Cell>,
    pub write_stamp: Option<Stamp>,
    pub delete_stamp: Option<Stamp>,
    /// The instance the row belongs to, fixed by the first write that reached it.
    pub partition: Option<String>,
}

impl RowRecord {
    /// Live: written, and never deleted or written after its latest delete (RFC-0014 §1).
    pub fn is_visible(&self) -> bool {
        match (&self.write_stamp, &self.delete_stamp) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some(w), Some(d)) => w > d,
        }
    }

    /// The row's current values, whether or not it is visible.
    pub fn values(&self) -> Row {
        self.cells
            .iter()
            .map(|(c, cell)| (c.clone(), cell.value.clone()))
            .collect()
    }
}

/// A JSON value as text with every object's keys sorted — what container cells compare by.
pub fn canonical_json(value: &JsonValue) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

fn write_json(out: &mut String, value: &JsonValue) {
    match value {
        JsonValue::Null => out.push_str("null"),
        JsonValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsonValue::Number(n) => out.push_str(&js_number(*n)),
        JsonValue::Text(s) => write_json_string(out, s),
        JsonValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        JsonValue::Object(fields) => {
            // BTreeMap<String> orders by bytes; JavaScript's `.sort()` orders by UTF-16 units.
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort_by(|a, b| crate::cbor::cmp_utf16(a, b));
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(out, key);
                out.push(':');
                write_json(out, &fields[*key]);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify` of a string: the escapes it emits, and nothing more.
pub fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A number as JavaScript prints it — exact for integers and for the shortest round-trip form of
/// ordinary doubles; the exponent notation JavaScript switches to above 1e21 and below 1e-7 is
/// reproduced for those ranges.
pub fn js_number(n: f64) -> String {
    if !n.is_finite() {
        return "null".to_owned();
    }
    if n == 0.0 {
        return "0".to_owned();
    }
    if n.fract() == 0.0 && n.abs() < 1e21 {
        return format!("{}", n as i128);
    }
    let abs = n.abs();
    if (1e-6..1e21).contains(&abs) {
        // JavaScript switches to exponent form below 1e-6 and at 1e21; Rust never does, so plain form here matches
        return format!("{n}");
    }
    // JavaScript: d.ddde±x with the shortest mantissa; Rust's `{:e}` gives the same digits
    let s = format!("{n:e}");
    let (mantissa, exponent) = s.split_once('e').expect("exponent form");
    let exponent: i32 = exponent.parse().expect("integer exponent");
    let sign = if exponent < 0 { "-" } else { "+" };
    format!("{mantissa}e{sign}{}", exponent.abs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_keys_and_prints_like_javascript() {
        let mut o = BTreeMap::new();
        o.insert("b".to_owned(), JsonValue::Number(1.5));
        o.insert(
            "a".to_owned(),
            JsonValue::Array(vec![JsonValue::Null, JsonValue::Text("q\"".into())]),
        );
        o.insert("c".to_owned(), JsonValue::Number(12.0));
        assert_eq!(
            canonical_json(&JsonValue::Object(o)),
            r#"{"a":[null,"q\""],"b":1.5,"c":12}"#
        );
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(1e-7), "1e-7");
        assert_eq!(js_number(123456789012.5), "123456789012.5");
        assert_eq!(js_number(-0.0), "0");
    }
}
