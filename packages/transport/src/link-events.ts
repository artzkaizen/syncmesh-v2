import type { PeerId } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";

import type { Upgrader, UpgradeOptions } from "./upgrade.js";

/**
 * How a link ended, said out loud (book ch. 18).
 *
 * Every one of these facts already existed and none of them left the closure that held it: the
 * upgrader tells the adapter a peer was proved, refused or closed so the adapter can manage its
 * own paths, and the bridge reports a failed send to a hub nothing outside a test subscribes to.
 * So a device could be dialling the same peer every two seconds, being refused every time, and
 * the only surface that said anything was `$status` — which reads `ok`, because the radio is
 * fine. The link is what is not.
 *
 * A feed rather than a counter because the two questions a person actually asks are *why was
 * this device refused* and *why does that peer keep dropping*, and neither is answerable from a
 * number. Nothing is retained here: a reader that wants a history keeps one, and a device with
 * no reader pays a `Set` walk over an empty set.
 */

/**
 * What happened to the link, in the order a link can reach them.
 *
 * `refused` and `closed` are separate although a refusal always closes, because they are
 * different answers to *why*: a refusal is the door, and is the one ending worth remembering,
 * while a close is everything else — a failed handshake, a medium going away, a peer walking out
 * of range. `dropped` is below a link altogether: a frame or a packet that never became one.
 */
export type LinkEventKind = "proven" | "refused" | "closed" | "dropped" | "error";

/** One link-level fact, with the medium it happened on and the moment it did. */
export interface LinkEvent {
  readonly kind: LinkEventKind;
  /** The medium's name — the same one `$transports.list()` and `$status` use. */
  readonly transport: string;
  /**
   * Who, where there is a who.
   *
   * Absent below the handshake, which is most drops: a malformed frame names nobody. At a
   * refusal before a dial is spent this is what the medium *announced* — a claim, exactly as
   * `AdmissionAsk.peer` is a claim at its `dial` rung. Everywhere else the handshake has signed
   * for it.
   */
  readonly peer?: PeerId;
  /**
   * In words a person can act on; absent for a `proven` that is a link simply opening, which has
   * no why. A second `proven` on one link carries one, because that one happened for a reason.
   */
  readonly why?: string;
  readonly at: Temporal.Instant;
}

/** One link's fact before the medium and the clock are put on it. */
export type LinkFact = Omit<LinkEvent, "transport" | "at">;

/**
 * One upgrade's callbacks, with the transport listening in.
 *
 * The adapter's own callbacks still run and still run last, because they are what closes its
 * paths and backs its dials off — reporting must not change what a medium does about an ending,
 * only that somebody else hears about it.
 *
 * The proved peer is remembered for the close that follows it, which is the whole value of the
 * `closed` variant: "the session with an inbound peer failed" is a log line, and "the session
 * with 3f9a…  failed, again" is a diagnosis.
 */
const reported = (options: UpgradeOptions, note: (fact: LinkFact) => void): UpgradeOptions => {
  let proven: PeerId | undefined;
  return {
    ...options,
    onProven: (peer) => {
      proven = peer;
      note({ kind: "proven", peer });
      options.onProven?.(peer);
    },
    /**
     * `proven` again, with the reason it happened twice. It is the same fact — this peer signed
     * for this link — and a feed that said nothing here would be silent about the one ending a
     * medium never reports: the far side's half of a link dying without a close.
     */
    onSuperseded: (peer) => {
      note({ kind: "proven", peer, why: "the peer handshook again; the older session is gone" });
      options.onSuperseded?.(peer);
    },
    onRefused: (peer) => {
      note({ kind: "refused", peer, why: "the door did not admit this peer" });
      options.onRefused?.(peer);
    },
    onClosed: (why) => {
      note({ kind: "closed", ...(proven !== undefined && { peer: proven }), why });
      options.onClosed?.(why);
    },
  };
};

/**
 * The upgrader an adapter is handed, reporting every ending it passes on.
 *
 * Wrapping the seam rather than asking each adapter to emit is what stops the next medium being
 * the one that forgets: frame boundaries, the handshake and the door are already the upgrader's,
 * and an adapter cannot open a link without going through it. A medium that emitted for itself
 * would be a medium that could be written not to.
 */
export const reportingUpgrader = (
  upgrader: Upgrader,
  note: (fact: LinkFact) => void,
): Upgrader => ({
  bytes: (stream, options = {}) => upgrader.bytes(stream, reported(options, note)),
  frames: (link, options = {}) => upgrader.frames(link, reported(options, note)),
});
