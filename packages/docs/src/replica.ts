import type { PeerId } from "@syncmesh/kernel";

import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@syncmesh/wire";

const DOMAIN = new TextEncoder().encode("syncmesh/doc-replica");
/** 63 bits: a replica id every library's 64-bit id holds, and JavaScript reads exactly as a bigint. */
const MASK = (1n << 63n) - 1n;

/**
 * The replica a document handle edits as: `sha256("syncmesh/doc-replica" ‖ peer ‖ nonce)`, first
 * eight bytes big-endian, top bit cleared. A fresh nonce per open means two handles of one device
 * — two tabs, a crash and a reopen — never number operations under one replica, which a CRDT
 * would read as one history forking (RFC-0023 §13, "replica ids never collide").
 *
 * @example
 * replicaId(peer, crypto.getRandomValues(new Uint8Array(16))); // 0x…n, < 2^63
 */
export function replicaId(peer: PeerId, nonce: Uint8Array): bigint {
  const hash = sha256(Uint8Array.from([...DOMAIN, ...hexToBytes(peer).unwrap(), ...nonce]));
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(hash[i] ?? 0);
  return value & MASK;
}
