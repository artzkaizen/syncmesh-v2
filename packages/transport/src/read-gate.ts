import type { Interest } from "@syncmesh/engine";
import type { PartitionKey, PeerId, SyncEvent } from "@syncmesh/kernel";
import type { GrantRegistry } from "@syncmesh/wire";

import { entitledInterest, interestText } from "@syncmesh/engine";

/**
 * What a peer may be sent in a granted mesh (D40): the read half of a grant, asked by the sender
 * before an event becomes bytes, on every link. A receiver's own check is about who *wrote* an
 * event; this one is about who may *read* it, and only the sender can answer it, because once the
 * bytes have left there is nothing to take back.
 *
 * @example
 * ```ts
 * const gate = createReadGate({ grants, self: identity.peerId, issuer, sealed: (p) => false });
 * gate.withholds(peer, event); // true: this peer's grant does not name event.partition
 * ```
 */
export interface ReadGate {
  /**
   * Whether `peer` may not be sent `event`. Unpinned events and sealed partitions always go — an
   * unpinned event is about the mesh, and a sealed one is ciphertext a carrier cannot open — and
   * so does everything to the issuer.
   *
   * `peer` is the one a handshake proved. `undefined` is a link that runs none — a pipe the app
   * built and hands the mesh as already its own (a worker port, a tab, a test loopback) — and is
   * carried whole: the gate judges readers it can name, and every medium that faces strangers
   * names them by handshake. `linkTransport` takes the name when the app wants it judged.
   */
  readonly withholds: (peer: PeerId | undefined, event: SyncEvent) => boolean;
  /** The entitlement `peer` is judged by, as the scope text a withheld frame carries. */
  readonly scope: (peer: PeerId | undefined) => string;
  /** What a snapshot for `peer` is served under: what it asked for, cut to its grant. */
  readonly serves: (
    peer: PeerId | undefined,
    interest: Interest | undefined,
  ) => Interest | undefined;
  /** This device's own entitlement, as that text: the only scope it takes a withheld frame under. */
  readonly own: () => string;
  /**
   * Whether a withheld frame from `from` may step this device's cursor over `author`'s run: only
   * when `from` is that author, naming its own writes, or the issuer, which reads everything.
   *
   * A withheld frame carries no proof — the event it names is the one thing it does not send — so
   * it is taken only from a peer that would know. Anyone else naming another author's sequences
   * could make this device skip events it may read, for good: once the cursor stands past them, no
   * honest peer's diff offers them again. A run withheld by a forwarder instead stays a gap, which
   * the author or the issuer closes when it is next linked.
   */
  readonly attests: (from: PeerId | undefined, author: PeerId) => boolean;
  /** Whether `peer` is the issuer, which reads everything and so may hold every author's run. */
  readonly whole: (peer: PeerId | undefined) => boolean;
}

export interface ReadGateOptions {
  readonly grants: GrantRegistry;
  readonly self: PeerId;
  /** The issuer, which reads everything: the authority every grant traces back to. */
  readonly issuer?: PeerId;
  /** Whether a partition's content is sealed, and so may travel to a peer that cannot read it. */
  readonly sealed?: (partition: PartitionKey) => boolean;
}

export function createReadGate(options: ReadGateOptions): ReadGate {
  const { grants, self, issuer, sealed } = options;
  const granted = (peer: PeerId | undefined): readonly PartitionKey[] =>
    (peer === undefined ? undefined : grants.grantFor(peer)?.partitions) ?? [];
  const scope = (peer: PeerId | undefined): string =>
    interestText(entitledInterest(undefined, granted(peer)));
  const whole = (peer: PeerId | undefined): boolean => peer !== undefined && peer === issuer;
  return {
    withholds: (peer, event) => {
      const partition = event.partition;
      if (partition === undefined || sealed?.(partition) === true) return false;
      if (peer === undefined || peer === issuer) return false;
      return !granted(peer).includes(partition);
    },
    scope,
    serves: (peer, interest) =>
      peer === undefined || peer === issuer ? interest : entitledInterest(interest, granted(peer)),
    own: () => scope(self),
    attests: (from, author) => from !== undefined && (from === author || whole(from)),
    whole,
  };
}
