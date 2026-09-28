//! Lowercase hex, an even count of characters. The form every id travels as in text.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidHex {
    pub input: String,
}

impl std::fmt::Display for InvalidHex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "expected an even count of lowercase hex characters, got {:?}",
            self.input
        )
    }
}

impl std::error::Error for InvalidHex {}

fn nibble(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

/// Lowercase only, like the TypeScript: an uppercase digit is not a byte on this wire.
pub fn from_hex(hex: &str) -> Result<Vec<u8>, InvalidHex> {
    let bytes = hex.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err(InvalidHex {
            input: hex.to_owned(),
        });
    }
    bytes
        .chunks(2)
        .map(|pair| match (nibble(pair[0]), nibble(pair[1])) {
            (Some(hi), Some(lo)) => Ok(hi << 4 | lo),
            _ => Err(InvalidHex {
                input: hex.to_owned(),
            }),
        })
        .collect()
}

pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_refuses_uppercase_and_odd() {
        assert_eq!(to_hex(&from_hex("00ff7a").unwrap()), "00ff7a");
        assert!(from_hex("0F").is_err());
        assert!(from_hex("abc").is_err());
        assert_eq!(from_hex("").unwrap(), Vec::<u8>::new());
    }
}
