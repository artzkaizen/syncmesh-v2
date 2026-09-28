import { parsePeerId } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { CheckpointRow } from "../checkpoint.js";

import { checkpointHash, issueCheckpoint, verifyCheckpoint } from "../checkpoint.js";
import { createIdentity } from "../identity.js";

const authority = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 11 + i)).unwrap();
const impostor = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 99 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const rows: readonly CheckpointRow[] = [
  { table: "notes", key: "n1", record: Uint8Array.of(1, 2, 3) },
  { table: "notes", key: "n2", record: Uint8Array.of(4, 5) },
];
const coverage = new Map([[authority.peerId, 42]]);

const mint = (over: readonly CheckpointRow[] = rows) =>
  issueCheckpoint(authority, { stateHash: checkpointHash(over), coverage, now: T0 });

describe("checkpoint certificates — who vouches for a snapshot (book ch. 4)", () => {
  test("the authority's certificate verifies, and carries the coverage it claims", () => {
    const held = verifyCheckpoint(mint(), authority.peerId, rows).unwrap();
    expect(held.v).toBe(1);
    expect(held.issuer).toBe(authority.peerId);
    expect([...held.coverage]).toEqual([[authority.peerId, 42]]);
    expect(held.issuedAt.epochMilliseconds).toBe(T0.epochMilliseconds);
  });

  test("the hash does not depend on page order, because two senders may page the same state", () => {
    const reversed = [...rows].reverse();
    expect(checkpointHash(reversed)).toEqual(checkpointHash(rows));
    expect(verifyCheckpoint(mint(), authority.peerId, reversed).isOk()).toBe(true);
  });

  test("an altered row is caught even though the signature is the authority's own", () => {
    const tampered: readonly CheckpointRow[] = [
      { table: "notes", key: "n1", record: Uint8Array.of(9, 9, 9) },
      { table: "notes", key: "n2", record: Uint8Array.of(4, 5) },
    ];
    // the relaying device cannot re-sign what it changed: the signature covers the state hash
    const refused = verifyCheckpoint(mint(), authority.peerId, tampered);
    expect(refused.isErr()).toBe(true);
    const error = refused.match({ ok: () => undefined, err: (e) => e });
    expect(error?._tag).toBe("CheckpointMismatch");
  });

  test("a dropped row is a mismatch too: absence is not something a hash can be silent about", () => {
    const short = rows.slice(0, 1);
    expect(verifyCheckpoint(mint(), authority.peerId, short).isErr()).toBe(true);
  });

  test("a peer cannot mint one: the same bytes signed by anyone else are refused", () => {
    const forged = issueCheckpoint(impostor, {
      stateHash: checkpointHash(rows),
      coverage,
      now: T0,
    });
    const refused = verifyCheckpoint(forged, authority.peerId, rows);
    const error = refused.match({ ok: () => undefined, err: (e) => e });
    expect(error?._tag).toBe("BadCheckpointSignature");
  });

  test("garbage is a value, not a throw", () => {
    expect(verifyCheckpoint(Uint8Array.of(1, 2, 3), authority.peerId).isErr()).toBe(true);
    const other = parsePeerId("a".repeat(64)).unwrap();
    expect(verifyCheckpoint(mint(), other).isErr()).toBe(true);
  });
});
