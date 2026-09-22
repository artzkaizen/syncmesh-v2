import type { Result } from "@syncmesh/result";

import { isTaggedError, panic } from "@syncmesh/result";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { Acting } from "./install.js";
import type { Replica, ReplicaUnavailable } from "./replica.js";

import { onWiped, watchActing } from "./install.js";
import { onReplica, openReplica } from "./replica.js";
import { router } from "./router.js";
import { COLOR, FONT, SEVERITY_COLOR, SPACE, TEXT } from "./ui.js";
import { Workspace } from "./workspace.js";

/**
 * The entry: reach the origin's mesh, then draw the app over it.
 *
 * There is exactly one await before the first pixel and it is the one that matters — this tab
 * finding whichever tab holds the engine, and on a fresh install that tab opening the database and
 * writing the seed through the log. After that the app never waits for anything again, because
 * everything it needs is on this device.
 *
 * The replica is also handed back *later*, through {@link onReplica}: the tab holding the engine
 * can close, and the survivor that is promoted rebuilds its client over a new port. That is a new
 * `Replica` object and a re-render, not a reload — which is the whole difference between a
 * handover and a cold start.
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

/**
 * A replica and which one it is, because the second one has to **replace** the first.
 *
 * Every live query in the tree is subscribed to the mesh it was built against, and the hooks key
 * a subscription on the *question* rather than on the mesh — `useLiveQuery`'s own contract, and
 * the right one for an app whose mesh outlives its screens. A handover breaks that assumption
 * once: the api is new, the old subscriptions are on a port that is closed, and a tree that
 * merely re-rendered would go on showing the last rows it was given over a database that has
 * moved on. So the epoch keys the tree and the whole of it is rebuilt.
 *
 * **What the rebuild no longer costs is the screen.** It used to take this tab's filters and its
 * open issue with it, which was the honest price of a stale screen being the worse outcome — but
 * those four values are in the address bar now rather than in React state, and the address bar is
 * not in the tree. The router is built once, outside the key; a handover tears the components
 * down, mounts them again against the new mesh and they read the same URL back. A promoted
 * follower now redraws the list it was already looking at.
 */
interface Held {
  readonly replica: Replica;
  readonly epoch: number;
}

function Boot() {
  const [held, setHeld] = useState<Held>();
  const [failure, setFailure] = useState<ReplicaUnavailable>();
  /**
   * Who this install is, asked of the worker rather than decided here.
   *
   * Beside the replica and not inside it, because the two are answers to different questions with
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

  useEffect(() => {
    let live = true;
    const settle = (opened: Result<Replica, ReplicaUnavailable>): void => {
      if (!live) return;
      // the screen renders the reason as prose; this is the live error, whose fields — which VFS
      // was refused, which directory is held — are the ones a bug report is actually written from
      // eslint-disable-next-line no-console -- the app has not started; there is no screen yet
      if (opened.isErr()) console.error("[syncmesh] the replica would not open", opened.error);
      setFailure(opened.isOk() ? undefined : opened.error);
      if (opened.isOk())
        setHeld((current) => ({ replica: opened.value, epoch: (current?.epoch ?? 0) + 1 }));
    };
    const off = onReplica(settle);
    void openReplica().then(settle);
    return () => {
      live = false;
      off();
    };
  }, []);

  const reason = failure === undefined ? undefined : because(failure);
  if (failure !== undefined)
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
          read it over a port. Where a browser has no SharedWorker there is nothing to introduce
          them through, and only the tab that won the election is live.
        </span>
      </Centered>
    );
  if (held === undefined || acting === undefined)
    return (
      <Centered>
        <span>
          Reaching this origin&rsquo;s mesh — opening SQLite over OPFS in the elected tab&rsquo;s
          worker, and seeding the workspace if this is the first run…
        </span>
      </Centered>
    );
  return (
    // the workspace's live reads are above the router and keyed with the tree, because they are
    // the mesh's; the router below is the URL's and outlives every replica this tab holds
    <Workspace acting={acting} key={held.epoch} replica={held.replica}>
      <RouterProvider router={router} />
    </Workspace>
  );
}

const host = document.querySelector("#root") ?? panic("index.html has no #root to mount into");
createRoot(host).render(<Boot />);
