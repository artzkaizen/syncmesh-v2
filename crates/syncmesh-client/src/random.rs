//! The one door randomness comes through. The core is deliberately free of a random source so
//! every byte in it is reproducible from the vectors; a device needs fresh bytes for its seed,
//! its ephemeral link keys and every seal nonce, and takes them from here.

/// `n` bytes from the operating system. A failure here is not one a device can do anything
/// about — the platform has no entropy — so it is the one place this crate panics on purpose.
pub fn bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("the operating system has no randomness to give");
    out
}

/// A random 24-byte nonce for the sealed link, fresh per frame.
pub fn nonce() -> [u8; syncmesh_core::handshake::NONCE_BYTES] {
    bytes()
}

/// A random identity seed.
pub fn seed() -> [u8; 32] {
    bytes()
}

/// A random session id for the ephemeral tier, as lowercase hex.
pub fn session_id() -> String {
    syncmesh_core::to_hex(&bytes::<16>())
}
