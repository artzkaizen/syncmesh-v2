import type { EphemeralStore } from "loro-crdt";

import { Result } from "@syncmesh/result";

/** Something that carries ephemeral bytes between devices: syncmesh's presence tier (D16), or a test's pipe. */
export interface EphemeralCarrier {
  readonly publish: (bytes: Uint8Array) => void;
  readonly subscribe: (listener: (bytes: Uint8Array) => void) => () => void;
}

/**
 * Shares a Loro `EphemeralStore` — cursors, selections, who is here — over a carrier. Nothing it
 * carries touches the document or the log: ephemeral state expires, and a device that missed it
 * misses nothing durable. Bytes the store cannot read go to `onRefused`, never thrown.
 *
 * @example
 * const cursors = new CursorEphemeralStore(doc.peerIdStr);
 * const stop = shareEphemeral(cursors, carrier);
 */
export function shareEphemeral(
  store: EphemeralStore,
  carrier: EphemeralCarrier,
  onRefused?: (cause: unknown) => void,
): () => void {
  const outbound = store.subscribeLocalUpdates((bytes) => carrier.publish(bytes));
  const inbound = carrier.subscribe((bytes) => {
    const applied = Result.try(() => store.apply(bytes));
    if (applied.isErr()) onRefused?.(applied.error);
  });
  return () => {
    outbound();
    inbound();
  };
}
