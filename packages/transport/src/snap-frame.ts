import type { Cursors, Interest } from "@syncmesh/engine";
import type { CborValue } from "@syncmesh/wire";

import { interestFrom, interestText } from "@syncmesh/engine";
import { Result } from "@syncmesh/result";
import { encodeCbor, isSafeNonNegative, isString } from "@syncmesh/wire";

import type { MalformedFrame } from "./frame-parts.js";

import { KIND, cursorPairs, decodeCursorPairs, malformedFrame } from "./frame-parts.js";

/**
 * The join exchange (RFC-0019): `snap-req → snap-manifest → snap-chunk* → snap-ack`.
 *
 * One tag with a sub-kind rather than four tags, because the four only ever mean anything
 * together — and because the relay's own vocabulary begins immediately above the session tags,
 * so the exchange stays inside a tag it owns.
 *
 * The coverage travels on the **manifest**, not on the chunks. A receiver may adopt it only once
 * every chunk it names has arrived: that ordering is the whole safety of the design, since a
 * snapshot incomplete for its scope, adopted anyway, loses the missing rows forever.
 */
export const SNAP = { req: 0, manifest: 1, chunk: 2, ack: 3 } as const;

export type SnapshotFrame =
  /** "Send me state, not history" — narrowed to what this device wants (E13). */
  | { readonly kind: "snap-req"; readonly interest?: Interest }
  /** What is about to arrive, and the coverage it will stand for once all of it has. */
  | {
      readonly kind: "snap-manifest";
      readonly id: string;
      readonly chunks: number;
      readonly rows: number;
      readonly at: Cursors;
      /** The slice these rows are complete for; absent means the sender's whole state. */
      readonly scope?: Interest;
    }
  /** One page of rows in the compact encoding, numbered so a lost one can be named. */
  | {
      readonly kind: "snap-chunk";
      readonly id: string;
      readonly index: number;
      readonly bytes: Uint8Array;
    }
  /** Installed, or the chunks that never arrived — an empty list is the completion. */
  | { readonly kind: "snap-ack"; readonly id: string; readonly missing: readonly number[] };

export const snapRequestFrame = (interest?: Interest): Uint8Array =>
  encodeCbor([KIND.snapshot, SNAP.req, interestText(interest)]);

export const snapManifestFrame = (
  id: string,
  chunks: number,
  rows: number,
  at: Cursors,
  scope?: Interest,
): Uint8Array =>
  encodeCbor([
    KIND.snapshot,
    SNAP.manifest,
    id,
    chunks,
    rows,
    cursorPairs(at),
    interestText(scope),
  ]);

export const snapChunkFrame = (id: string, index: number, bytes: Uint8Array): Uint8Array =>
  encodeCbor([KIND.snapshot, SNAP.chunk, id, index, bytes]);

export const snapAckFrame = (id: string, missing: readonly number[]): Uint8Array =>
  encodeCbor([KIND.snapshot, SNAP.ack, id, [...missing]]);

/** `[tag, sub, …]` — the sub-kind decides the rest; one this build does not know is ignored. */
export function decodeSnapshotFrame(
  outer: readonly CborValue[],
): Result<SnapshotFrame | { readonly kind: "unknown" }, MalformedFrame> {
  const [, sub, ...rest] = outer;
  if (sub === SNAP.req) {
    const interest = interestFrom(isString(rest[0]) ? rest[0] : undefined);
    return Result.ok(
      interest === undefined ? { kind: "snap-req" } : { kind: "snap-req", interest },
    );
  }
  if (sub === SNAP.manifest) return decodeManifest(rest);
  if (sub === SNAP.chunk) return decodeChunk(rest);
  if (sub === SNAP.ack) return decodeAck(rest);
  return Result.ok({ kind: "unknown" });
}

function decodeManifest(
  rest: readonly (CborValue | undefined)[],
): Result<SnapshotFrame, MalformedFrame> {
  return Result.gen(function* () {
    const [id, chunks, rows, at, scopeText] = rest;
    if (!isString(id)) return malformedFrame("snapshot id is not text");
    if (!isSafeNonNegative(chunks) || !isSafeNonNegative(rows))
      return malformedFrame("manifest counts are not integers");
    const cursors = yield* decodeCursorPairs(at);
    const scope = interestFrom(isString(scopeText) ? scopeText : undefined);
    const manifest = { kind: "snap-manifest", id, chunks, rows, at: cursors } as const;
    return Result.ok(scope === undefined ? manifest : { ...manifest, scope });
  });
}

function decodeChunk(
  rest: readonly (CborValue | undefined)[],
): Result<SnapshotFrame, MalformedFrame> {
  const [id, index, bytes] = rest;
  if (!isString(id)) return malformedFrame("snapshot id is not text");
  if (!isSafeNonNegative(index)) return malformedFrame("chunk index is not an integer");
  if (!(bytes instanceof Uint8Array)) return malformedFrame("chunk payload is not bytes");
  return Result.ok({ kind: "snap-chunk", id, index, bytes });
}

function decodeAck(
  rest: readonly (CborValue | undefined)[],
): Result<SnapshotFrame, MalformedFrame> {
  const [id, missing] = rest;
  if (!isString(id)) return malformedFrame("snapshot id is not text");
  if (!Array.isArray(missing)) return malformedFrame("missing chunks are not an array");
  const indexes: number[] = [];
  for (const index of missing) {
    if (!isSafeNonNegative(index)) return malformedFrame("missing chunk is not an integer");
    indexes.push(index);
  }
  return Result.ok({ kind: "snap-ack", id, missing: indexes });
}
