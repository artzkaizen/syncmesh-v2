import type { PeerId } from "@syncmesh/kernel";

import { parsePeerId } from "@syncmesh/kernel";
import { bytesToHex, hexToBytes } from "@syncmesh/wire";

/**
 * How a device says who it is and where to reach it, before anyone has connected.
 *
 * **The whole peer id fits here, and that is the difference from BLE.** A datagram has room for
 * it, so there is no hint and no prefix collision to reason about: what travels is the id both
 * ends will compare to decide who dials, and the id the handshake will later prove.
 *
 * Proving is still the handshake's job. Anyone on the access point can put an announcement on
 * the group claiming to be anybody, so what an announcement buys is an address worth dialling —
 * never a peer worth believing.
 *
 * The room id is here because one access point is not one mesh. A café with two apps on it has
 * two rooms, and a device that dialled across them would open a link the bridge then refuses
 * for the length of the session.
 */

/** `SMLA`, then the format version. A stray packet on the group is discarded on sight. */
const MAGIC = Uint8Array.from([0x53, 0x4d, 0x4c, 0x41]);
const VERSION = 1;
const PEER_BYTES = 32;
const HEADER = MAGIC.length + 1;

/** Room ids are config, not user input, but a length byte is a length byte. */
export const MAX_ROOM_BYTES = 64;

export interface Announcement {
  readonly peer: PeerId;
  readonly room: string;
  /** The port to dial; the host comes from where the datagram arrived, which cannot be faked as cheaply. */
  readonly port: number;
}

/** The announcement this device repeats onto the group, as bytes. */
export function announcement(peer: PeerId, room: string, port: number): Uint8Array {
  const roomBytes = new TextEncoder().encode(room);
  if (roomBytes.length > MAX_ROOM_BYTES)
    throw new RangeError(
      `the room id is ${roomBytes.length} bytes; the announcement holds ${MAX_ROOM_BYTES}`,
    );
  const id = hexToBytes(peer).unwrap();
  const out = new Uint8Array(HEADER + PEER_BYTES + 2 + 1 + roomBytes.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(id, HEADER);
  new DataView(out.buffer).setUint16(HEADER + PEER_BYTES, port);
  out[HEADER + PEER_BYTES + 2] = roomBytes.length;
  out.set(roomBytes, HEADER + PEER_BYTES + 3);
  return out;
}

/** What a datagram announced, or `undefined` for anything that is not one of ours. */
export function readAnnouncement(bytes: Uint8Array): Announcement | undefined {
  if (bytes.length < HEADER + PEER_BYTES + 3) return undefined;
  for (const [i, byte] of MAGIC.entries()) if (bytes[i] !== byte) return undefined;
  if (bytes[MAGIC.length] !== VERSION) return undefined;
  const roomLength = bytes[HEADER + PEER_BYTES + 2] ?? 0;
  if (bytes.length !== HEADER + PEER_BYTES + 3 + roomLength) return undefined;
  const peer = parsePeerId(bytesToHex(bytes.subarray(HEADER, HEADER + PEER_BYTES)));
  if (peer.isErr()) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    peer: peer.value,
    port: view.getUint16(HEADER + PEER_BYTES),
    room: new TextDecoder().decode(bytes.subarray(HEADER + PEER_BYTES + 3)),
  };
}
