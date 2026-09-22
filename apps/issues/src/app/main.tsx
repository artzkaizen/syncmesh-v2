import { isTaggedError, panic } from "@syncmesh/result";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import type { Acting } from "./install.js";
import type { ReplicaUnavailable } from "./replica.js";

import { onWiped, watchActing } from "./install.js";
import { mesh } from "./mesh.js";
import { onReplica, replicaState } from "./replica.js";
import { router } from "./router.js";
import { COLOR, FONT, SEVERITY_COLOR, SPACE, TEXT } from "./ui.js";
import { Workspace } from "./workspace.js";

/**
 * The entry: reach the origin's mesh, then draw the app over it.
 *
 * There is exactly one await before the first pixel and it is the one that matters — this tab
 * finding whichever tab holds the engine, and on a fresh install that tab opening the database and
 * writing the seed through the log. `<mesh.Provider>` is that gate: it draws `whileOpening` until
 * the first link is held and the tree after, which is what makes `mesh.api` a property every
 * screen underneath can read. After that the app never waits for anything again, because
 * everything it needs is on this device.
 *
 * The replica is also handed back *later*, through {@link onReplica}: the tab holding the engine
 * can close, and the survivor that is promoted rebuilds its client over a new port. `mesh.api`
 * reads through to whichever link is held, and the tree is keyed on the link's epoch so that every
 * subscription is retaken on the new port — a re-render, not a reload, which is the whole
 * difference between a handover and a cold start.
 *
 * Deliberately **not** wrapped in `<StrictMode>`. Strict mode's double-invoked effects are a good
 * thing and this app would survive them at the React level; what it would not survive is the
 * second `openReplica()` — the election is the tab's, and a second worker under one tab would be
 * a second contender wearing the same face. `openReplica` is memoised for that reason, and strict
 * mode is left off so the counter that `Detail` bumps on open counts views rather than renders.
 */

/**
 * One cause as a line.
 *
 * JSON rather than `String` for what is not an error, so a value reads as itself instead of
 * `[object Object]` — the one thing a diagnostic must never say. A cause that crossed the port is
 * prose by then (`serializeTagged` flattens it) and comes back quoted, which is the honest shape:
 * those are somebody else's words.
 */
const said = (cause: unknown): string =>
  cause instanceof Error ? cause.message : JSON.stringify(cause);

/**
 * The worker's own words for a failure, which is what the sentence above it cannot be.
 *
 * `openMeshLink` and the boot round trip each wrap what they caught in a sentence about the mesh,
 * so the part a person can act on — `OpfsUnavailable`, a `DOMException` name, SQLite's own
 * refusal — sits one or two `cause` hops under it and was reaching the screen nowhere. The tag
 * leads because it is the part that says *which* failure this is, and a bug report that has it
 * starts in the right file.
 *
 * At most two deep, and that is a property of the boundary rather than a limit chosen here:
 * `serializeTagged` flattens a cause to its message on the way across the port, so whatever the
 * worker was holding arrives as prose one level down.
 */
const because = (failure: ReplicaUnavailable): string | undefined => {
  const { cause } = failure;
  if (cause === undefined) return undefined;
  if (!isTaggedError(cause)) return said(cause);
  const tagged = `${cause._tag}: ${cause.message}`;
  return cause.cause === undefined ? tagged : `${tagged} — ${said(cause.cause)}`;
};

const Centered = ({ children }: { readonly children: React.ReactNode }) => (
  <div
    style={{
      alignItems: "center",
      background: COLOR.surface,
      color: COLOR.textDim,
      display: "flex",
      flexDirection: "column",
      fontFamily: FONT.sans,
      gap: SPACE.sm,
      height: "100vh",
      justifyContent: "center",
      ...TEXT.sm,
    }}
  >
    {children}
  </div>
);

/** The link this tab holds and the last reason it could not, as React state. */
const useReplica = () => useSyncExternalStore(onReplica, replicaState);

/** The replica would not open: the sentence, the worker's own words under it, and what that means. */
function Unavailable({ failure }: { readonly failure: ReplicaUnavailable }) {
  const reason = because(failure);
  return (
    <Centered>
      <strong style={{ color: SEVERITY_COLOR.critical }}>The replica would not open</strong>
      <span>{failure.message}</span>
      {reason !== undefined && (
        <code
          style={{
            ...TEXT.xs,
            color: COLOR.textDim,
            fontFamily: FONT.mono,
            maxWidth: "68ch",
            textAlign: "center",
          }}
        >
          {reason}
        </code>
      )}
      <span style={{ ...TEXT.xs, color: COLOR.textFaint }}>
        This tab holds no database of its own: one tab of this origin owns the engine and the rest
        read it over a port. Where a browser has no SharedWorker there is nothing to introduce them
        through, and only the tab that won the election is live.
      </span>
    </Centered>
  );
}

const REACHING = (
  <Centered>
    <span>
      Reaching this origin&rsquo;s mesh — opening SQLite over OPFS in the elected tab&rsquo;s
      worker, and seeding the workspace if this is the first run…
    </span>
  </Centered>
);

/**
 * What the gate draws before the first link is held: the sentence, or the reason there is none.
 *
 * The failure is drawn here rather than by the factory's `whenUnavailable`, because a first open
 * that fails is not final in this app — a tab told there is no rendezvous can be promoted later,
 * and `openClient` resolves the moment it is.
 */
function Reaching() {
  const { failure } = useReplica();
  return failure === undefined ? REACHING : <Unavailable failure={failure} />;
}

/**
 * The app over the link this tab holds, rebuilt whole when the link changes — see `Held.epoch`.
 *
 * A reopen that fails after a first success is drawn over everything, as it always was: a tab
 * whose leader went and whose reconnect was refused has nothing honest to show underneath.
 */
function App({ acting }: { readonly acting: Acting | undefined }) {
  const { held, failure } = useReplica();
  if (failure !== undefined) return <Unavailable failure={failure} />;
  if (acting === undefined) return REACHING;
  const epoch = held?.epoch ?? panic("the app drew before a link was held");
  return (
    // the workspace's live reads are above the router and keyed with the tree, because they are
    // the mesh's; the router below is the URL's and outlives every link this tab holds
    <Workspace acting={acting} key={epoch}>
      <RouterProvider router={router} />
    </Workspace>
  );
}

function Boot() {
  /**
   * Who this install is, asked of the worker rather than decided here.
   *
   * Beside the link and not inside it, because the two are answers to different questions with
   * different lifetimes — `replica.ts` says which — and because this subscription must outlive a
   * handover: the tab holding the engine can close without anybody changing who they are.
   */
  const [acting, setActing] = useState<Acting>();
  useEffect(() => watchActing(setActing), []);

  /**
   * The database this page was reading has been deleted, so the page is reloaded.
   *
   * Every window hears it, not only the one whose button was pressed: they were all reading the
   * file that just went, and a tab left drawing the last rows of a replica that no longer exists
   * is exactly the stale screen the rest of this app spends its effort avoiding. A reload here is
   * a cold join, which is the thing a person asked for.
   */
  useEffect(() => onWiped(() => location.reload()), []);

  return (
    // one gate, at the root: the tree under it may read `mesh.api` as a property, and the open
    // it waits on started at import time, overlapping React mounting rather than queueing behind it
    <mesh.Provider whileOpening={<Reaching />}>
      <App acting={acting} />
    </mesh.Provider>
  );
}

const host = document.querySelector("#root") ?? panic("index.html has no #root to mount into");
createRoot(host).render(<Boot />);
