//! Canonical CBOR, the whole contract of the wire (RFC-0002, D35).
//!
//! Shortest heads; map keys integers first ascending, then text in UTF-16 code-unit order (what
//! JavaScript's `<` does, and therefore what the vectors were frozen by); safe integers as
//! integers and every other number as f64; no tags, no indefinite lengths, no trailing bytes.
//! Decoding is strict and never panics: anything off the wire is a value describing the fault.

use std::collections::BTreeMap;

/// The largest integer JavaScript represents exactly; anything beyond it is a float on this wire.
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// A map key: integers order before text, text by UTF-16 code units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    Int(i64),
    Text(String),
}

impl Ord for Key {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            (Key::Int(a), Key::Int(b)) => a.cmp(b),
            (Key::Int(_), Key::Text(_)) => std::cmp::Ordering::Less,
            (Key::Text(_), Key::Int(_)) => std::cmp::Ordering::Greater,
            (Key::Text(a), Key::Text(b)) => cmp_utf16(a, b),
        }
    }
}

impl PartialOrd for Key {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl From<i64> for Key {
    fn from(n: i64) -> Self {
        Key::Int(n)
    }
}

impl From<&str> for Key {
    fn from(s: &str) -> Self {
        Key::Text(s.to_owned())
    }
}

impl From<String> for Key {
    fn from(s: String) -> Self {
        Key::Text(s)
    }
}

/// JavaScript string order: by UTF-16 code unit, which differs from byte order only past the BMP.
pub fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Int(i64),
    Float(f64),
    Bool(bool),
    Null,
    Text(String),
    Bytes(Vec<u8>),
    Array(Vec<Value>),
    Map(BTreeMap<Key, Value>),
}

impl Value {
    pub fn map<I: IntoIterator<Item = (Key, Value)>>(entries: I) -> Value {
        Value::Map(entries.into_iter().collect())
    }

    pub fn text(s: &str) -> Value {
        Value::Text(s.to_owned())
    }

    pub fn as_int(&self) -> Option<i64> {
        match self {
            Value::Int(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_text(&self) -> Option<&str> {
        match self {
            Value::Text(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Value::Bytes(b) => Some(b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&BTreeMap<Key, Value>> {
        match self {
            Value::Map(m) => Some(m),
            _ => None,
        }
    }

    /// The number a JavaScript peer would hold: a safe integer stays an integer, anything else is f64.
    pub fn number(n: f64) -> Value {
        if is_safe_integer(n) {
            Value::Int(n as i64)
        } else {
            Value::Float(n)
        }
    }
}

pub fn is_safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER as f64
}

const MAJOR_UINT: u8 = 0;
const MAJOR_NINT: u8 = 1;
const MAJOR_BYTES: u8 = 2;
const MAJOR_TEXT: u8 = 3;
const MAJOR_ARRAY: u8 = 4;
const MAJOR_MAP: u8 = 5;
const MAJOR_SIMPLE: u8 = 7;
const SIMPLE_FALSE: u8 = 0xf4;
const SIMPLE_TRUE: u8 = 0xf5;
const SIMPLE_NULL: u8 = 0xf6;
const SIMPLE_F64: u8 = 0xfb;

fn head(out: &mut Vec<u8>, major: u8, length: u64) {
    let t = major << 5;
    if length < 24 {
        out.push(t | length as u8);
    } else if length < 0x100 {
        out.push(t | 24);
        out.push(length as u8);
    } else if length < 0x1_0000 {
        out.push(t | 25);
        out.extend_from_slice(&(length as u16).to_be_bytes());
    } else if length < 0x1_0000_0000 {
        out.push(t | 26);
        out.extend_from_slice(&(length as u32).to_be_bytes());
    } else {
        out.push(t | 27);
        out.extend_from_slice(&length.to_be_bytes());
    }
}

fn write(out: &mut Vec<u8>, v: &Value) {
    match v {
        Value::Null => out.push(SIMPLE_NULL),
        Value::Bool(true) => out.push(SIMPLE_TRUE),
        Value::Bool(false) => out.push(SIMPLE_FALSE),
        Value::Int(n) => {
            if n.unsigned_abs() > MAX_SAFE_INTEGER as u64 {
                write_f64(out, *n as f64);
            } else if *n >= 0 {
                head(out, MAJOR_UINT, *n as u64);
            } else {
                head(out, MAJOR_NINT, (-1 - *n) as u64);
            }
        }
        Value::Float(f) => {
            if is_safe_integer(*f) {
                write(out, &Value::Int(*f as i64));
            } else {
                write_f64(out, *f);
            }
        }
        Value::Text(s) => {
            head(out, MAJOR_TEXT, s.len() as u64);
            out.extend_from_slice(s.as_bytes());
        }
        Value::Bytes(b) => {
            head(out, MAJOR_BYTES, b.len() as u64);
            out.extend_from_slice(b);
        }
        Value::Array(items) => {
            head(out, MAJOR_ARRAY, items.len() as u64);
            for item in items {
                write(out, item);
            }
        }
        Value::Map(m) => {
            head(out, MAJOR_MAP, m.len() as u64);
            for (k, v) in m {
                match k {
                    Key::Int(n) => write(out, &Value::Int(*n)),
                    Key::Text(s) => write(out, &Value::Text(s.clone())),
                }
                write(out, v);
            }
        }
    }
}

fn write_f64(out: &mut Vec<u8>, f: f64) {
    out.push(SIMPLE_F64);
    out.extend_from_slice(&f.to_bits().to_be_bytes());
}

/// Canonical CBOR: shortest heads, sorted keys, safe integers as integers, everything else f64.
pub fn encode(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    write(&mut out, value);
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MalformedCbor {
    pub offset: usize,
    pub message: &'static str,
}

impl std::fmt::Display for MalformedCbor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "malformed cbor at {}: {}", self.offset, self.message)
    }
}

impl std::error::Error for MalformedCbor {}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn fail<T>(&self, message: &'static str) -> Result<T, MalformedCbor> {
        Err(MalformedCbor {
            offset: self.offset,
            message,
        })
    }

    fn byte(&mut self) -> Result<u8, MalformedCbor> {
        let b = *self.bytes.get(self.offset).ok_or(MalformedCbor {
            offset: self.offset,
            message: "unexpected end",
        })?;
        self.offset += 1;
        Ok(b)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], MalformedCbor> {
        if self
            .offset
            .checked_add(n)
            .is_none_or(|end| end > self.bytes.len())
        {
            return self.fail("unexpected end in payload");
        }
        let out = &self.bytes[self.offset..self.offset + n];
        self.offset += n;
        Ok(out)
    }

    fn length(&mut self, info: u8) -> Result<u64, MalformedCbor> {
        if info < 24 {
            return Ok(info as u64);
        }
        let width = match info {
            24 => 1,
            25 => 2,
            26 => 4,
            27 => 8,
            _ => return self.fail("indefinite lengths are not part of the wire"),
        };
        let mut n: u64 = 0;
        for _ in 0..width {
            n = n << 8 | self.byte()? as u64;
        }
        if n > MAX_SAFE_INTEGER as u64 {
            return self.fail("length beyond safe integer");
        }
        Ok(n)
    }

    fn value(&mut self) -> Result<Value, MalformedCbor> {
        let first = self.byte()?;
        let major = first >> 5;
        let info = first & 0x1f;
        if major == MAJOR_SIMPLE {
            return match info {
                20 => Ok(Value::Bool(false)),
                21 => Ok(Value::Bool(true)),
                22 => Ok(Value::Null),
                27 => {
                    let raw = self.take(8)?;
                    let f = f64::from_be_bytes(raw.try_into().expect("eight bytes"));
                    // a float that is a safe integer is held as one, as a JavaScript peer holds it
                    Ok(Value::number(f))
                }
                _ => self.fail("simple value is not part of the wire"),
            };
        }
        let n = self.length(info)?;
        match major {
            MAJOR_UINT => Ok(Value::Int(n as i64)),
            MAJOR_NINT => Ok(Value::Int(-1 - n as i64)),
            MAJOR_BYTES => Ok(Value::Bytes(self.take(n as usize)?.to_vec())),
            MAJOR_TEXT => {
                let raw = self.take(n as usize)?;
                match std::str::from_utf8(raw) {
                    Ok(s) => Ok(Value::Text(s.to_owned())),
                    Err(_) => self.fail("invalid utf-8"),
                }
            }
            MAJOR_ARRAY => {
                let mut items = Vec::with_capacity((n as usize).min(1024));
                for _ in 0..n {
                    items.push(self.value()?);
                }
                Ok(Value::Array(items))
            }
            MAJOR_MAP => {
                let mut m = BTreeMap::new();
                for _ in 0..n {
                    let k = match self.value()? {
                        Value::Int(i) => Key::Int(i),
                        Value::Text(s) => Key::Text(s),
                        _ => return self.fail("map keys are integers or strings"),
                    };
                    let v = self.value()?;
                    m.insert(k, v);
                }
                Ok(Value::Map(m))
            }
            _ => self.fail("tags are not part of the wire"),
        }
    }
}

/// Reads one item; anything malformed, truncated or trailing is an error value, never a panic.
pub fn decode(bytes: &[u8]) -> Result<Value, MalformedCbor> {
    let mut r = Reader { bytes, offset: 0 };
    let v = r.value()?;
    if r.offset != bytes.len() {
        return r.fail("trailing bytes");
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex::to_hex;

    #[test]
    fn heads_are_shortest_and_keys_sorted() {
        let v = Value::map([
            (Key::from("b"), Value::Int(1)),
            (Key::from(2), Value::Text("x".into())),
            (Key::from("a"), Value::Bool(true)),
            (Key::from(1), Value::Null),
        ]);
        assert_eq!(to_hex(&encode(&v)), "a401f60261786161f5616201");
        assert_eq!(to_hex(&encode(&Value::Int(23))), "17");
        assert_eq!(to_hex(&encode(&Value::Int(24))), "1818");
        assert_eq!(to_hex(&encode(&Value::Int(-1))), "20");
        assert_eq!(to_hex(&encode(&Value::Float(1.5))), "fb3ff8000000000000");
        assert_eq!(to_hex(&encode(&Value::Float(2.0))), "02");
    }

    #[test]
    fn decode_is_strict() {
        assert!(decode(&[0x9f]).is_err()); // indefinite
        assert!(decode(&[0xc0, 0x00]).is_err()); // tag
        assert!(decode(&[0x01, 0x02]).is_err()); // trailing
        assert!(decode(&[0x62, 0xff, 0xfe]).is_err()); // bad utf-8
        assert_eq!(
            decode(&[0xfb, 0x40, 0, 0, 0, 0, 0, 0, 0]).unwrap(),
            Value::Int(2)
        );
    }

    #[test]
    fn round_trips_reproduce_bytes() {
        let bytes = crate::hex::from_hex("a401f60261786161f5616201").unwrap();
        assert_eq!(encode(&decode(&bytes).unwrap()), bytes);
    }
}
