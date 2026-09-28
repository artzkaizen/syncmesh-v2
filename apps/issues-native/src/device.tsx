import type { Actor } from "@syncmesh/issues";

import { syncmeshReact } from "@syncmesh/react";
import { useSyncExternalStore } from "react";

import type { Device } from "./mesh";

import { openedClient, replicaSnapshot, subscribeReplica } from "./open";

/**
 * What a screen is given: the calls it makes, and who it is making them as.
 *
 * **Not "the replica".** A replica is a database — the thing `src/mesh.ts` opens, holds a file
 * for, and folds events into. No screen wants one. A screen wants to ask a question
 * (`mesh.api.issues.list({…})`, the same spelling as the browser app), and to know whose name is
 * on the answer (`useActor()`), and that is the whole of it for six of the eight screens here. The two whose subject genuinely *is* the device — settings
 * and devtools, which show the relay, the authority and how much is stored — ask for it by that
 * name.
 */

/**
 * The client, bound once, for every screen in this app.
 *
 * `mesh.Provider` is the one place that knows the database opens slowly: it sits above the
 * navigator in `app/_layout.tsx`, draws `whileOpening` until {@link openedClient} answers and the
 * tree after, so everything under it may read `mesh.api` as a property. `mesh.useStatus()` and
 * its siblings are the device's own facts as React state — what the header pill and the settings
 * screen draw by.
 *
 * **Deliberately not `use()` and not Suspense**, which is where this parts company with LiveStore
 * — whose `useStore` calls `React.use(promise)` and lets a boundary above draw the fallback.
 * Suspending reads better and was tried: it stops the *whole tree* until the promise settles, and
 * nothing at all appeared for ~500ms on the phone. The provider hands back a status instead, so
 * the frame draws now and fills in when the engine lands.
 */
export const mesh = syncmeshReact(openedClient);

/**
 * The device, read off the store the open settles into.
 *
 * Under `mesh.Provider` the store is always `ready` — the provider's own promise resolved from
 * it — so the throw is for a screen mounted above the provider, which is a wiring mistake and
 * not a state to draw.
 */
const held = (): Device => {
  const opened = useSyncExternalStore(subscribeReplica, replicaSnapshot);
  if (opened.kind !== "ready")
    throw new Error("a screen asked for the device outside <mesh.Provider>");
  return opened.replica;
};

/**
 * Who every write this device makes is attributed to.
 *
 * The one most screens actually want: a handler cannot ask the mesh who is calling — a grant
 * proves a *device* — so each write carries an `actorId`, and this is where it comes from.
 */
export const useActor = (): Actor => held().actor;

/** This device itself: where it syncs, how much it holds, and the two buttons that change that. */
export const useDevice = (): Device => held();
