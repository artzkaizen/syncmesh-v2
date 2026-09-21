import type { Actor } from "@syncmesh/issues";
import type { Result } from "@syncmesh/result";

import type { Instruments, MeshUnavailable, Device } from "./mesh";

/**
 * The replica as an external store — opened once, read synchronously, never awaited by a render.
 *
 * Modelled on how React Query mounts. Its client is built outside React and the cache is a plain
 * map, so `useQuery` reads it *during* render and returns `status: "pending"` when there is nothing
 * there yet; fetching is an effect that fills the store in afterwards. What it never does is make
 * the tree wait.
 *
 * Two things here follow from that. The first is that this module is **cheap to evaluate**: every
 * import is type-only, and `./mesh` — which drags in the engine, the procedures, the relay, the
 * wire format, Drizzle and Zod, and measured **187ms** on a phone — arrives through a dynamic
 * `import()`. A route module that imported it at the top paid that before React drew a frame.
 *
 * The second is that opening starts **as early as possible and blocks nothing**: the work begins
 * when this module is first reached, so it overlaps React mounting rather than following it. React
 * Query defers its fetch to an effect because on a server each request needs its own cache and a
 * module-level start would leak between them; on one device with one log that reasoning does not
 * apply, and the earlier start is strictly better.
 *
 * **The memo lives here rather than in `./mesh`.** A memo inside a lazily-loaded module is a memo
 * per load, and two loads would be two engines over one log — events stamped below ones the relay
 * has already seen, and the loser's writes dropped as already-seen rather than refused. Holding it
 * in the module that does the loading is what makes "once" mean once.
 */
export type Opened =
  | { readonly kind: "opening" }
  | { readonly kind: "ready"; readonly replica: Device }
  | { readonly kind: "unavailable"; readonly reason: MeshUnavailable };

const OPENING: Opened = { kind: "opening" };

// one object per state, not one per read: `useSyncExternalStore` compares snapshots by identity
// and a fresh object every call is an infinite render loop
let current: Opened = OPENING;

const listeners = new Set<() => void>();

const settle = (next: Opened): void => {
  current = next;
  for (const listener of listeners) listener();
};

let started = false;

/**
 * The replica, with the two calls that change who it is routed back through this store.
 *
 * `useSyncExternalStore` compares snapshots by identity, so a `signInAs` that only registered a
 * grant would move the account with nothing on screen noticing — the list would still say "Bo" and
 * still filter "assigned to me" by the person who left. Re-settling with a fresh object is what
 * turns a change in the engine into a render, and wrapping here rather than in `./mesh` is what
 * keeps that module free of any opinion about React.
 */
const observed = (replica: Device, chosen: boolean): Device => ({
  api: replica.api,
  authority: replica.authority,
  deleted: replica.deleted,
  chosen,
  // read through rather than copied: `actor` is a getter over a value `signInAs` moves, and a
  // spread would freeze whoever was acting at the moment this wrapper was built
  get actor() {
    return replica.actor;
  },
  overTheAir: replica.overTheAir,
  relay: replica.relay,
  reset: replica.reset,
  scale: replica.scale,
  // choosing is what makes `chosen` true — that is the whole of what the flag records
  signInAs: async (actor: Actor) => {
    await replica.signInAs(actor);
    settle({ kind: "ready", replica: observed(replica, true) });
  },
  signOut: async () => {
    await replica.signOut();
    settle({ kind: "ready", replica: observed(replica, false) });
  },
});

/** Begins the open, once. Safe to call from anywhere; every call after the first does nothing. */
/**
 * The loaded module, kept so the one thing outside this file that needs the engine's own
 * instruments can have them **without importing the engine to ask**.
 *
 * `app/devtools.tsx` is that caller. A static `import { meshInstruments } from "./mesh"` there
 * would evaluate the whole engine at startup — route modules are evaluated eagerly — and undo
 * the dynamic import below entirely.
 */
interface MeshModule {
  readonly openMesh: () => Promise<Result<Device, MeshUnavailable>>;
  readonly meshInstruments: () => Instruments | undefined;
}

let engine: MeshModule | undefined;

/** What the running mesh says about itself; `undefined` before it opens, and after a reset. */
export const meshInstruments = (): Instruments | undefined => engine?.meshInstruments();

export function startReplica(): void {
  if (started) return;
  started = true;
  // `./mesh` drags in the engine, the procedures, the relay, the wire format, Drizzle and Zod —
  // **187ms of evaluation on a phone**, before React can draw a frame. A static import here paid
  // it on the way *to* the first render; a dynamic one pays it beside the render instead, which
  // is the whole reason this module is cheap enough to import from a route
  void import("./mesh")
    .then(async (loaded) => {
      engine = loaded;
      return loaded.openMesh();
    })
    .then((opened) => {
      settle(
        opened.isOk()
          ? { kind: "ready", replica: observed(opened.value, opened.value.chosen) }
          : { kind: "unavailable", reason: opened.error },
      );
    });
}

export const subscribeReplica = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const replicaSnapshot = (): Opened => current;

// the work starts here rather than in an effect, so it overlaps React mounting instead of queueing
// behind it — see the note above on why React Query's reason for deferring does not apply
startReplica();
