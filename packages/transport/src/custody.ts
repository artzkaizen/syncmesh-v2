import type { Engine } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { CustodyReceipt, Identity } from "@syncmesh/wire";

import { issueReceipt, verifyReceipt } from "@syncmesh/wire";

import type { BridgeOptions } from "./bridge.js";
import type { Frame } from "./frame.js";
import type { BridgeError } from "./outbound.js";

import { receiptFrame } from "./frame.js";

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
  /** Signs what this device now holds of `author`'s log and hands it back down the link. */
  readonly vouch: (author: PeerId) => void;
  /** One arriving receipt: verified, and kept only when it is about this device's own writes. */
  readonly receive: (wire: Uint8Array) => void;
}

export interface CustodyDeps {
  readonly engine: Engine;
  readonly identity: Identity;
  readonly now: () => Temporal.Instant;
  readonly send: (frame: Uint8Array) => void;
  readonly errors: (error: BridgeError) => void;
  /**
   * This device's storage lineage. Absent, nothing is signed: vouching for custody without being
   * able to say *which* store held it proves less than nothing.
   */
  readonly incarnation?: string;
  readonly onReceipt?: (receipt: CustodyReceipt) => void;
}

export function createCustody(deps: CustodyDeps): Custody {
  const { engine, identity, now, send, errors, incarnation, onReceipt } = deps;
  return {
    vouch: (author) => {
      if (incarnation === undefined) return;
      const held = engine.coverage().synced.get(author);
      if (held === undefined) return;
      send(
        receiptFrame(issueReceipt(identity, { author, throughSeq: held, incarnation, now: now() })),
      );
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
  };
}

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
      default:
        return; // a tag this build does not know is ignored, never an error
    }
  };
}

/** The custody signer this bridge runs, with the two optional halves assigned rather than spread. */
export function custodyFor(
  options: BridgeOptions,
  wiring: Pick<CustodyDeps, "now" | "send" | "errors">,
): Custody {
  const deps = { engine: options.engine, identity: options.identity, ...wiring };
  if (options.incarnation !== undefined) Object.assign(deps, { incarnation: options.incarnation });
  if (options.onReceipt !== undefined) Object.assign(deps, { onReceipt: options.onReceipt });
  return createCustody(deps);
}
