import type { DocLimits, DocumentAdapter } from "@syncmesh/docs";

import { DEFAULT_LIMITS, UpdateRejected } from "@syncmesh/docs";
import { parseAdapterId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { LoroDoc, VersionVector } from "loro-crdt";

/** `loro@1`: the major is the compatibility contract (RFC-0023 §10), Loro's own 1.x encoding. */
export const LORO_ID = parseAdapterId("loro@1").unwrap();

const reject = (message: string, cause?: unknown) =>
  new UpdateRejected({ adapter: LORO_ID, message, ...(cause !== undefined && { cause }) });

const VERSION_FORMAT = 1;
const PEER_BYTES = 8;
const ENTRY_BYTES = PEER_BYTES + 4;

/**
 * `loro@1`'s version: `0x01`, then per peer in ascending order its id (u64) and end counter (u32),
 * both big-endian. Not Loro's own `VersionVector.encode()`, which writes peers in hash-map order —
 * an order native 64-bit Rust and wasm32 do not share — so one version would have two encodings.
 */
export function encodeVersion(vv: VersionVector): Uint8Array {
  const peers = [...vv.toJSON()].map(([peer, end]) => [BigInt(peer), end] as const);
  peers.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out = new Uint8Array(1 + peers.length * ENTRY_BYTES);
  const view = new DataView(out.buffer);
  out[0] = VERSION_FORMAT;
  peers.forEach(([peer, end], i) => {
    view.setBigUint64(1 + i * ENTRY_BYTES, peer);
    view.setUint32(1 + i * ENTRY_BYTES + PEER_BYTES, end);
  });
  return out;
}

/** The inverse of {@link encodeVersion}; anything else is refused. */
export function decodeVersion(bytes: Uint8Array): Result<VersionVector, UpdateRejected> {
  if (bytes[0] !== VERSION_FORMAT || (bytes.length - 1) % ENTRY_BYTES !== 0)
    return Result.err(reject("not a loro@1 version"));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<`${number}`, number>();
  for (let at = 1; at < bytes.length; at += ENTRY_BYTES) {
    const peer = view.getBigUint64(at);
    // SAFETY: a decimal u64 is exactly what Loro's PeerID template type spells
    entries.set(String(peer) as `${number}`, view.getUint32(at + PEER_BYTES));
  }
  return Result.try({
    try: () => VersionVector.parseJSON(entries),
    catch: (cause) => reject("not a loro@1 version", cause),
  });
}

/**
 * Builds the `loro@1` adapter over `loro-crdt` (WASM on the web, Bun and Node). `limits` narrows
 * RFC-0023's defaults; nothing widens the inline bound past what a frame carries.
 *
 * The Rust side is `syncmesh-loro` over the `loro` crate at the same version. Both write one
 * `version` for one history, byte for byte; snapshots and updates agree as documents — they import
 * to the same version and value — and byte for byte only between builds of one word size
 * (`conformance/loro-vectors.json`).
 *
 * @example
 * const documents = createDocuments({ engine, adapters: [loro()], docs: DOCS, procedure });
 */
export function loro(limits: Partial<DocLimits> = {}): DocumentAdapter<LoroDoc> {
  const bounds = { ...DEFAULT_LIMITS, ...limits };
  return {
    id: LORO_ID,
    limits: bounds,
    create: (replica) => {
      const doc = new LoroDoc();
      doc.setPeerId(replica);
      return doc;
    },
    apply: (doc, updates) => {
      const oversized = updates.find((u) => u.length > bounds.maxSnapshotBytes);
      if (oversized !== undefined)
        return Result.err(
          reject(`an update of ${String(oversized.length)} bytes is over the bound`),
        );
      if (updates.length === 0) return Result.ok(false);
      const before = doc.oplogVersion();
      return Result.try({
        // an op whose deps this replica lacks waits inside Loro's pending set and is applied the
        // moment they land; the log keeps its bytes, so nothing is lost when a handle closes (D38)
        try: () => {
          doc.importBatch([...updates]);
          return before.compare(doc.oplogVersion()) !== 0;
        },
        catch: (cause) => reject("loro could not import the update", cause),
      });
    },
    snapshot: (doc) => doc.export({ mode: "snapshot" }),
    version: (doc) => encodeVersion(doc.oplogVersion()),
    since: (doc, version) =>
      decodeVersion(version).andThen((from) =>
        Result.try({
          try: () => doc.export({ mode: "update", from }),
          catch: (cause) => reject("loro could not export past that version", cause),
        }),
      ),
    watchLocal: (doc, listener) => doc.subscribeLocalUpdates(() => listener()),
  };
}

export type { EphemeralCarrier } from "./ephemeral.js";
export { shareEphemeral } from "./ephemeral.js";
