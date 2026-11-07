import type { PeerId } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { Transport, TransportCondition } from "@syncmesh/transport";

import { omitUndefined, Result, TaggedError } from "@syncmesh/result";

import type { TransportAddFailed } from "./transports.js";

/**
 * Holding one medium in a named condition on purpose, so a developer can reach a state a laptop
 * cannot otherwise produce (book ch. 18).
 *
 * You cannot turn off a real Bluetooth radio from JavaScript, put a LAN peer out of range, or
 * make a relay flap, and those are exactly the states a diagnostic screen exists to draw — so a
 * screen that renders four of them has, on a developer's machine, no way to reach three. This is
 * the way: the real medium is stopped and kept, and something that says what an off radio says
 * takes its seat.
 *
 * **A stand-in is a medium, not a mask.** It goes in the set at the position the real one held,
 * so `$status`, `$peers` and every panel see a device that is genuinely running a medium named
 * `ble` which is genuinely carrying nothing and genuinely says `radio-off` — which is what a
 * device with its Bluetooth off is running. Nothing downstream has to know a person is behind it,
 * and nothing downstream gets a special case; the one surface that knows is
 * `RunningTransports.forced`, which exists so a UI can tell *your radio is off* from *you turned
 * this radio off*.
 *
 * The capability shape is copied rather than invented, and that is the part worth reading twice.
 * A stand-in for a medium that could enumerate its links enumerates none; a stand-in for one that
 * never could still cannot, and is still reported as **cannot say** rather than as zero peers.
 * Manufacturing an answer the real medium would never have given is how a forced state teaches a
 * developer something untrue about the medium they forced.
 */

/** Allocated once: every stand-in that can enumerate its links enumerates the same nobody. */
const NOBODY = new Set<PeerId>();

/** No medium of that name is in this set — or, asked of a release, none of that name is held. */
export class NoSuchTransport extends TaggedError("NoSuchTransport")<{
  readonly transport: string;
  message: string;
}> {}

/** One medium held in a condition by hand, and the condition it is being held in. */
export interface ForcedMedium {
  readonly name: string;
  /** What it says about itself while it is held — `ok` is the one value this can never be. */
  readonly as: TransportCondition;
}

/**
 * The medium that sits in the set while the real one is held.
 *
 * `start`, `stop` and `whenReady` all resolve immediately, because there is nothing to open: a
 * radio that is off is ready in the only sense the mesh needs, which is that it will never be the
 * thing that wedges a boot.
 *
 * `onStatus` answers **false on subscribe** rather than staying quiet. The difference matters:
 * `undefined` from a medium's status hub means *has not said*, and a medium a person has just
 * switched off has said, and said no. A stand-in that stayed silent would leave the route scorer
 * treating it as up — `online.get(t) ?? true` — and put frames on a radio that cannot carry them.
 */
export function standInFor(real: Transport, as: TransportCondition): Transport {
  return {
    name: real.name,
    start: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    condition: () => as,
    onStatus: (cb) => {
      cb(false);
      return () => undefined;
    },
    ...omitUndefined({
      kind: real.kind,
      priority: real.priority,
      maxLinks: real.maxLinks,
      reaches: real.reaches !== undefined ? () => NOBODY : undefined,
    }),
  };
}

/** What {@link createForcing} needs from the set it is holding mediums in, and nothing more. */
export interface ForcingDeps {
  /** The medium of that name currently in the set, stand-in included; `undefined` for a stranger. */
  readonly find: (name: string) => Transport | undefined;
  /** One medium out and another in **at the same index**, stopping the one that leaves. */
  readonly swap: (out: Transport, into: Transport) => Promise<void>;
  /** Starts a medium already in the set, undoing the set if it will not open. */
  readonly open: (transport: Transport) => Promise<ResultType<void, TransportAddFailed>>;
}

export interface Forcing {
  readonly force: (
    name: string,
    as: TransportCondition,
  ) => Promise<ResultType<void, NoSuchTransport>>;
  readonly release: (
    name: string,
  ) => Promise<ResultType<void, NoSuchTransport | TransportAddFailed>>;
  readonly list: () => readonly ForcedMedium[];
  /** Forgets a name without giving it back its seat — what `remove` does to a held medium. */
  readonly forget: (name: string) => void;
  readonly clear: () => void;
}

/**
 * The held mediums, by name, each with the instance it stands for.
 *
 * **In memory and nowhere else.** A held medium is something a person did thirty seconds ago, and
 * a set of them restored from storage at the next boot would be a device that syncs nothing for a
 * reason nobody on the machine can see. A reload is the way out of every state this can reach.
 */
export function createForcing(deps: ForcingDeps): Forcing {
  const held = new Map<
    string,
    { readonly real: Transport; readonly standIn: Transport; readonly as: TransportCondition }
  >();
  return {
    force: async (name, as) => {
      const already = held.get(name);
      const real = already?.real ?? deps.find(name);
      if (real === undefined)
        return Result.err(
          new NoSuchTransport({ transport: name, message: `no medium named ${name} is running` }),
        );
      const standIn = standInFor(real, as);
      held.set(name, { real, standIn, as });
      // the seat is taken over from whatever holds it: the real medium the first time, and the
      // previous stand-in when the condition of an already-held medium is being changed
      await deps.swap(already?.standIn ?? real, standIn);
      return Result.ok(undefined);
    },
    release: async (name) => {
      const forced = held.get(name);
      if (forced === undefined)
        return Result.err(
          new NoSuchTransport({ transport: name, message: `no medium named ${name} is held` }),
        );
      held.delete(name);
      await deps.swap(forced.standIn, forced.real);
      return deps.open(forced.real);
    },
    list: () => [...held].map(([name, { as }]) => ({ name, as })),
    forget: (name) => void held.delete(name),
    clear: () => held.clear(),
  };
}
