/**
 * The fixed inputs the session frame vectors are built from: two identities from fixed seeds and
 * the payloads other vectors already froze. Kept apart from the cases so each file reads alone.
 */
import type { PeerId, SeqNum } from "@syncmesh/kernel";
import type { RouteAdWire } from "@syncmesh/transport";

import { parsePartitionKey, type ColumnName } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, encodeCbor, hexToBytes, signPresence } from "@syncmesh/wire";

import { grantVectors } from "./generate-grant-vectors.js";
import { receiptVectors } from "./generate-receipt-vectors.js";
import { refusalVectors } from "./generate-refusal-vectors.js";
import { wireVectors } from "./vectors.js";

const DEVICE_SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 + i);
const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 121 + i);
export const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
export const ACME = parsePartitionKey("org:acme").unwrap();

/** The fixed inputs the session frames are built from: two identities, and the frozen payloads. */
export function frameInputs() {
  const device = createIdentity(DEVICE_SEED).unwrap();
  const other = createIdentity(OTHER_SEED).unwrap();
  /* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- sequences are branded integers and columns branded text; documented literals */
  const cursors = new Map<PeerId, SeqNum>([
    [device.peerId, 7 as SeqNum],
    [other.peerId, 3 as SeqNum],
  ]);
  const ahead = new Map<PeerId, readonly SeqNum[]>([[other.peerId, [5 as SeqNum, 6 as SeqNum]]]);
  const floor = new Map<PeerId, SeqNum>([[other.peerId, 2 as SeqNum]]);
  const value = new Map<ColumnName, number>([
    ["x" as ColumnName, 12],
    ["y" as ColumnName, 40],
  ]);
  /* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

  // the payloads other vectors already froze, carried here under their frame tags
  const event = wireVectors.vectors[0];
  if (event === undefined) throw new Error("the event vectors are empty");
  const eventWire = encodeCbor([
    hexToBytes(event.coreHex).unwrap(),
    hexToBytes(event.sigHex).unwrap(),
  ]);
  const grantWire = hexToBytes(grantVectors().vectors[0]?.wireHex ?? "").unwrap();
  const receiptWire = hexToBytes(receiptVectors().vectors[0]?.wireHex ?? "").unwrap();
  const refusalWire = hexToBytes(refusalVectors().vectors[0]?.wireHex ?? "").unwrap();
  const presence = signPresence(
    {
      v: 1,
      peerId: device.peerId,
      topic: "cursor",
      partition: ACME,
      session: "s-1",
      count: 3,
      value,
      expires: NOW.epochMilliseconds + 60_000,
    },
    device,
  ).wire;
  const ads: RouteAdWire[] = [
    { to: String(other.peerId), hops: 2, expiresAtMs: NOW.epochMilliseconds + 60_000 },
  ];
  const digests = new Map<string, bigint>([["notes", 0xdeadbeefn]]);
  const certificate = Uint8Array.from({ length: 4 }, (_, i) => 0xc0 + i);
  return {
    device,
    other,
    cursors,
    ahead,
    floor,
    eventWire,
    grantWire,
    receiptWire,
    refusalWire,
    presence,
    ads,
    digests,
    certificate,
  };
}
