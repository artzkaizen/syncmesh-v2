import type { Engine, Parked, StoredEvent } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { CustodyReceipt, Identity, RefusalReceipt } from "@syncmesh/wire";

import { heldRuns, wireReason } from "@syncmesh/engine";
import { issueReceipt, issueRefusal, verifyReceipt, verifyRefusal } from "@syncmesh/wire";

import type { BridgeOptions } from "./bridge.js";
import type { FrameClass } from "./frame-parts.js";
import type { Frame } from "./frame.js";
import type { BridgeError } from "./outbound.js";

import { KIND } from "./frame-parts.js";
import { receiptFrame, refusalFrame } from "./frame.js";

/**
 * Custody, signed (book ch. 10). A cursor says "I have your events" and proves none of it, so a
 * device counting copies off cursors is counting claims. A receipt is that claim signed, and it
 * names the holder's storage lineage — which is what lets an author tell "still holding" from
 * "holding again, having lost what it had".
 *
 * Delivery, never approval: every receiver runs the same rules on the event itself, and holding
 * one is not accepting it.
 */
export interface Custody {
  /**
   * Signs what this device now holds of `author`'s log and hands it back down the link. A receipt
   * claims the whole run, so while the coverage is scoped it signs the run folded here
   * (`Coverage.held`), never the cursor: a scoped cursor stands past events this device was never
   * sent. Whether a receipt went out.
   */
  readonly vouch: (author: PeerId) => boolean;
  /** One arriving receipt: verified, and kept only when it is about this device's own writes. */
  readonly receive: (wire: Uint8Array) => void;
  /**
   * Signs one refusal per event of `batch` that the quarantine now holds and that was not yet said
   * to its author's current seating, and hands each back down the link (D32). Idempotent on
   * `(refuser, author, seq, verdict)` at the author, so a batch offered twice costs nothing more.
   */
  readonly refuse: (batch: readonly StoredEvent[]) => void;
  /**
   * The same, for every event of `author` still parked and not yet said to `author`'s current
   * seating: what a cursor exchange repeats, because a peer told we hold the event above our
   * cursor never offers it again. Once per refusal per seating, however many exchanges it lasts.
   */
  readonly repeat: (author: PeerId) => void;
  /**
   * `author` sat down again (U38): what was said to its last seating may never have reached it,
   * so its parked refusals are said once more on the next {@link Custody.repeat}. A link's whole
   * life is one seating; a relay room says when another begins.
   */
  readonly reseat: (author: PeerId) => void;
  /** One arriving refusal: verified, and kept only when it is about this device's own writes. */
  readonly receiveRefusal: (wire: Uint8Array) => void;
}

export interface CustodyDeps {
  readonly engine: Engine;
  readonly identity: Identity;
  readonly now: () => Temporal.Instant;
  readonly send: (cls: FrameClass, what: string, frame: Uint8Array) => void;
  readonly errors: (error: BridgeError) => void;
  /**
   * This device's storage lineage. Absent, nothing is signed: vouching for custody without being
   * able to say *which* store held it proves less than nothing.
   */
  readonly incarnation?: string;
  readonly onReceipt?: (receipt: CustodyReceipt) => void;
  readonly onRefusal?: (refusal: RefusalReceipt) => void;
  /**
   * How a signed refusal is framed on this link. Default the session frame, kind 9; a relay socket
   * carries it under a control tag of its own, because 9 is the relay's `hello` (D32).
   */
  readonly refusalFrame?: (wire: Uint8Array) => Uint8Array;
}

export function createCustody(deps: CustodyDeps): Custody {
  const { engine, identity, now, send, errors, incarnation, onReceipt, onRefusal } = deps;
  const framed = deps.refusalFrame ?? refusalFrame;
  // per author, the refusals said to its current seating: one signature per refusal per seating,
  // not one per cursor exchange — a holder would otherwise re-sign every parked write of an
  // author each time that author folded anything
  const said = new Map<PeerId, Set<string>>();
  const unsaid = (parked: readonly Parked[]): readonly Parked[] =>
    parked.filter((p) => said.get(p.entry.event.peerId)?.has(refusalKey(p)) !== true);
  const report = (parked: readonly Parked[]): void => {
    for (const each of parked) {
      const { entry, reason, verdict } = each;
      const { peerId: author, seqNum: seq } = entry.event;
      const keys = said.get(author) ?? new Set<string>();
      said.set(author, keys.add(refusalKey(each)));
      const wire = issueRefusal(identity, {
        author,
        seq,
        // a bucket only this build has goes out as `refused`, its verdict tag naming it (D31)
        reason: wireReason(reason),
        verdict: verdict._tag,
        now: now(),
      });
      send(KIND.refusal, "refusal", framed(wire));
    }
  };
  return {
    vouch: (author) => {
      if (incarnation === undefined) return false;
      // a scoped cursor (D23) says "everything below N that I may read"; a receipt says everything
      // below N, so a scoped device signs the run it folded, which stops below what was withheld
      const held = heldRuns(engine.coverage()).get(author);
      if (held === undefined) return false;
      send(
        KIND.receipt,
        "receipt",
        receiptFrame(issueReceipt(identity, { author, throughSeq: held, incarnation, now: now() })),
      );
      return true;
    },
    receive: (wire) => {
      const verified = verifyReceipt(wire);
      if (verified.isErr()) {
        errors(verified.error);
        return;
      }
      // only this device's own writes: a receipt about somebody else's log is not ours to keep
      if (verified.value.author === identity.peerId) onReceipt?.(verified.value);
    },
    refuse: (batch) => {
      const offered = new Set(batch.map((entry) => entry.event.id));
      report(unsaid(engine.quarantine().filter((p) => offered.has(p.entry.event.id))));
    },
    repeat: (author) => {
      const parked = engine.quarantine().filter((p) => p.entry.event.peerId === author);
      // what is no longer parked is forgotten, so the set never outgrows the quarantine
      const current = new Set(parked.map(refusalKey));
      for (const key of said.get(author) ?? [])
        if (!current.has(key)) said.get(author)?.delete(key);
      report(unsaid(parked));
    },
    reseat: (author) => void said.delete(author),
    receiveRefusal: (wire) => {
      const verified = verifyRefusal(wire);
      if (verified.isErr()) {
        errors(verified.error);
        return;
      }
      // the same rule as a receipt: a refusal of somebody else's write is not ours to keep
      if (verified.value.author === identity.peerId) onRefusal?.(verified.value);
    },
  };
}

/** One refusal as a seating hears it: the event, and the verdict this build reached on it. */
const refusalKey = (parked: Parked): string => `${parked.entry.event.id}:${parked.verdict._tag}`;

/** The frames that carry credentials rather than data: grants, the ask for one, and custody. */
export function controlFrames(
  options: BridgeOptions,
  deps: { readonly custody: Custody; readonly errors: (error: BridgeError) => void },
): (frame: Frame) => void {
  return (frame) => {
    switch (frame.kind) {
      case "grant": {
        const registered = options.grants.register(frame.wire);
        if (registered.isErr()) deps.errors(registered.error);
        return;
      }
      case "grant-request": {
        const request = { peerId: frame.peerId };
        if (frame.invite !== undefined) Object.assign(request, { invite: frame.invite });
        options.onGrantRequest?.(request);
        return;
      }
      case "receipt":
        return deps.custody.receive(frame.wire);
      case "refusal":
        return deps.custody.receiveRefusal(frame.wire);
      default:
        return; // a tag this build does not know is ignored, never an error
    }
  };
}

/** The custody signer this bridge runs, with the optional halves assigned rather than spread. */
export function createBridgeCustody(
  options: BridgeOptions,
  wiring: Pick<CustodyDeps, "now" | "send" | "errors">,
): Custody {
  const deps = { engine: options.engine, identity: options.identity, ...wiring };
  if (options.incarnation !== undefined) Object.assign(deps, { incarnation: options.incarnation });
  if (options.onReceipt !== undefined) Object.assign(deps, { onReceipt: options.onReceipt });
  if (options.onRefusal !== undefined) Object.assign(deps, { onRefusal: options.onRefusal });
  return createCustody(deps);
}
