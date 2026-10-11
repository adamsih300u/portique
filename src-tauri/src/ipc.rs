//! Reads secrets the page sent as raw bytes instead of JSON (see `src/secret-ipc.ts`).
//!
//! Layout: for each secret in order, a 4-byte little-endian length and then its UTF-8 bytes.
//! Each secret is copied into a `Zeroizing<String>` that wipes itself on drop. The buffer inside
//! Tauri's `Request` is owned by Tauri and is not wiped by us.

use tauri::ipc::{InvokeBody, Request};
use zeroize::Zeroizing;

/// Splits `bytes` into exactly `count` secrets. Anything left over, a missing field or text that
/// is not UTF-8 is an error, never a partial result.
pub fn decode_secrets(bytes: &[u8], count: usize) -> Result<Vec<Zeroizing<String>>, String> {
    let bad = || "malformed secret payload".to_string();
    let mut out = Vec::with_capacity(count);
    let mut rest = bytes;
    for _ in 0..count {
        let (len, tail) = rest.split_first_chunk::<4>().ok_or_else(bad)?;
        let len = u32::from_le_bytes(*len) as usize;
        if tail.len() < len {
            return Err(bad());
        }
        let (field, tail) = tail.split_at(len);
        out.push(Zeroizing::new(std::str::from_utf8(field).map_err(|_| bad())?.to_owned()));
        rest = tail;
    }
    if rest.is_empty() {
        Ok(out)
    } else {
        Err(bad())
    }
}

/// The `count` secrets in a request whose body is raw bytes.
pub fn secrets(request: &Request<'_>, count: usize) -> Result<Vec<Zeroizing<String>>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => decode_secrets(bytes, count),
        InvokeBody::Json(_) => Err("secrets must be sent as raw bytes".to_string()),
    }
}

/// A plain (non-secret) value the page sent in a header.
pub fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name)?.to_str().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bytes `encodeSecrets(["ab", "é", ""])` produces in secret-ipc.test.ts.
    const FIXTURE: &[u8] = &[2, 0, 0, 0, b'a', b'b', 2, 0, 0, 0, 0xc3, 0xa9, 0, 0, 0, 0];

    fn plain(v: Vec<Zeroizing<String>>) -> Vec<String> {
        v.into_iter().map(|s| (*s).clone()).collect()
    }

    #[test]
    fn reads_what_the_page_encodes() {
        assert_eq!(plain(decode_secrets(FIXTURE, 3).unwrap()), ["ab", "é", ""]);
        assert!(decode_secrets(&[], 0).unwrap().is_empty());
    }

    #[test]
    fn wrong_counts_are_errors() {
        assert!(decode_secrets(FIXTURE, 2).is_err(), "trailing bytes");
        assert!(decode_secrets(FIXTURE, 4).is_err(), "missing field");
    }

    #[test]
    fn truncated_and_oversized_lengths_are_errors() {
        assert!(decode_secrets(&FIXTURE[..5], 1).is_err());
        assert!(decode_secrets(&[1, 0, 0], 1).is_err(), "length cut short");
        assert!(decode_secrets(&[0xff, 0xff, 0xff, 0xff, b'x'], 1).is_err(), "length larger than the body");
    }

    #[test]
    fn invalid_utf8_is_an_error() {
        assert!(decode_secrets(&[1, 0, 0, 0, 0xff], 1).is_err());
    }
}
