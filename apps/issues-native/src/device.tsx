import type { Actor } from "@syncmesh/issues";

import { createContext, useContext, useSyncExternalStore } from "react";

import type { Device, MeshUnavailable } from "./mesh";

import { replicaSnapshot, subscribeReplica } from "./open";

/**
 * What a screen is given: the calls it makes, and who it is making them as.
 *
 * **Not "the replica".** A replica is a database — the thing `src/mesh.ts` opens, holds a file
 * for, and folds events into. No screen wants one. A screen wants to ask a question
 * (`useApi()`), and to know whose name is on the answer (`useActor()`), and that is the whole of
 * it for six of the eight screens here. The two whose subject genuinely *is* the device — settings
 * and devtools, which show the relay, the authority and how much is stored — ask for it by that
 * name.
 *
 * Every one of these used to be spelled `replica={useReplica()}` handed into a component that
 * destructured two fields off it. That is prop-drilling a bag one level to avoid naming what was
 * wanted, and it put a storage noun in the type signature of every screen in the app.
 */

const DeviceHeld = createContext<Device | undefined>(undefined);

const held = (): Device => {
  const device = useContext(DeviceHeld);
  if (device === undefined) throw new Error("a screen asked for the mesh outside <MeshGate>");
  return device;
};

/** The procedures, bound to this device's own database. `api.issues.list({…})` and nothing else. */
export const useApi = (): Device["api"] => held().api;

/**
 * Who every write this device makes is attributed to.
 *
 * The one most screens actually want: a handler cannot ask the mesh who is calling — a grant
 * proves a *device* — so each write carries an `actorId`, and this is where it comes from.
 */
export const useActor = (): Actor => held().actor;

/** This device itself: where it syncs, how much it holds, and the two buttons that change that. */
export const useDevice = (): Device => held();

/**
 * The one place in this app that knows the database opens slowly.
 *
 * Above the navigator, asked once. It used to be asked in all eight screens, each of which
 * re-answered "is it ready yet" before it could draw, in four different spellings of the same
 * card — one question, one answer, changing once per launch, answered eight times.
 *
 * **Deliberately not `use()` and not Suspense**, which is where this parts company with LiveStore
 * — whose `useStore` calls `React.use(promise)` and lets a boundary above draw the fallback.
 * Suspending reads better and was tried: it stops the *whole tree* until the promise settles, and
 * nothing at all appeared for ~500ms on the phone. `useSyncExternalStore` hands back a status
 * instead, so the frame draws now and fills in when the engine lands — and that only costs a
 * branch because there is exactly one of them, here.
 */
export function MeshGate({
  children,
  whileOpening,
  whenUnavailable,
}: {
  readonly children: React.ReactNode;
  readonly whileOpening: React.ReactNode;
  readonly whenUnavailable: (reason: MeshUnavailable) => React.ReactNode;
}) {
  const opened = useSyncExternalStore(subscribeReplica, replicaSnapshot);
  if (opened.kind === "opening") return whileOpening;
  if (opened.kind === "unavailable") return whenUnavailable(opened.reason);
  return <DeviceHeld value={opened.replica}>{children}</DeviceHeld>;
}
