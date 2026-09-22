import type { Handle, Mesh, MeshSchema, OnOptions } from "@syncmesh/client";
import type { LiveSource } from "@syncmesh/drizzle";
import type { FoldBatch, Principal, ValidatorSchema } from "@syncmesh/engine";
import type { InvalidPartitionKey, PeerId } from "@syncmesh/kernel";
import type { Api, Router } from "@syncmesh/orpc";
import type { Result as ResultType } from "@syncmesh/result";
import type { SqlRow, SqlValue } from "@syncmesh/storage";

import { parsePartitionKey } from "@syncmesh/kernel";
import { meshApi } from "@syncmesh/orpc/internal";
import { Result } from "@syncmesh/result";

import type { RemoteDevice } from "./device.js";
import type { RemoteInspect } from "./inspect.js";
import type { RemoteOperations } from "./ledger.js";
import type { MeshLink } from "./link.js";

import { createAsked } from "./asked.js";
import { remoteDevice } from "./device.js";
import { remoteInspect } from "./inspect.js";
import { remoteLedger } from "./ledger.js";
import { remoteHandle } from "./remote-handle.js";
import { openWire } from "./wire.js";

/**
 * The mesh as a tab that does not hold it can honestly answer.
 *
 * Narrower than `Mesh`, and the line it draws is **facts cross, controls do not**. `recovery`,
 * `accounts`, `blobs`, `presence`, and the `add`/`remove`/`force` half of `transports` are
 * controls of **the device**, and a follower tab is not a device — it is one of several windows
 * onto one. A radio toggled in tab three is the origin's radio, and deciding what that means is a
 * product question (`research/browser-durability.md` §4 settles identity, not settings). The
 * *facts* on those same surfaces — {@link FollowerMesh.status}, the media and who they reach,
 * {@link FollowerMesh.peers}, {@link FollowerMesh.routes}, the session — are read in windows and
 * nowhere else, so they cross as one pushed reading (`device.ts`) and answer synchronously from it.
 *
 * Two more cross as what they are. {@link FollowerMesh.operations} is the origin's **one** write
 * ledger, because a write made in any window becomes the same row; and {@link FollowerMesh.inspect}
 * is a door onto the device's own feeds that exists only where the host was handed an inspector.
 * The device's *controls* still reach through that door rather than sitting on this interface,
 * because a radio held from tab three is held for the device — which is a sentence a caller should
 * have to read.
 *
 * It satisfies `@syncmesh/orpc`'s `ApiMesh` structurally, so `meshApi(mesh, router)` builds the
 * same api here that it builds on the leader — one implementation of the app's surface, not two.
 * No scope is bound at construction, here or there: a call carries the replica it is about in its
 * own input (book ch. 3), which is what lets one api answer for every workspace a window opens.
 */
export interface FollowerMesh extends Pick<
  Mesh,
  "can" | "query" | "flush" | "ready" | "settled" | "schema"
> {
  /** Whether this tab's own worker is the host. For the header, the way the storage badge is. */
  readonly role: MeshLink["role"];
  /** The fold feed a live query re-runs on — here, batches that arrived over the port. */
  readonly engine: LiveSource;
  readonly on: (instance?: string, options?: OnOptions) => ResultType<Handle, InvalidPartitionKey>;
  /** Only the subscription; issuing and revoking grants is the device's business, not a window's. */
  readonly grants: { readonly onRegistered: (listener: () => void) => () => void };
  /**
   * The origin's durable write ledger (book ch. 10), read across the port.
   *
   * Always here, because a window cannot ask synchronously whether the leader was built over a
   * store — so the object exists and its reads answer `NoWriteLedger` where there is none, which
   * is a sentence rather than an empty table.
   */
  readonly operations: RemoteOperations;
  /**
   * Who the origin acts as, and until when. A window has no session of its own to differ with
   * (ch. 14): `principal` is pushed for a handler to read mid-render, `status` and `subscribe`
   * are the reading a session screen draws.
   */
  readonly auth: RemoteDevice["session"] & { readonly principal: () => Principal | undefined };
  /** Per-source condition and one overall health, as the device last said (ch. 18). */
  readonly status: RemoteDevice["status"];
  /** The device's media as facts — name, kind, who each reaches — with no control attached. */
  readonly transports: RemoteDevice["transports"];
  /** Who the device can reach, over what (ch. 17). */
  readonly peers: RemoteDevice["peers"];
  /** Every destination the device knows a way to, and how far (ch. 17). */
  readonly routes: RemoteDevice["routes"];
  /** The device's first reading has landed; what `$ready` waits on beside {@link selfId}. */
  readonly heard: () => Promise<void>;
  /** This origin's peer id; the one fact a window must await before it can build a `syncOf`. */
  readonly selfId: () => Promise<PeerId>;
  /**
   * Whether the origin holds a tombstone for that row — what separates *deleted* from *never
   * heard of*, which every query answers identically.
   *
   * The boolean rather than the `Stamp` the origin's `Engine.deletedAt` returns, for the reason
   * the protocol's own `"deleted"` path states: the stamp names the deleting **device** and
   * carries that device's clock, so neither half is something a window may put on screen, and a
   * `Temporal.Instant` does not survive a structured clone as itself in any case.
   */
  readonly deleted: (table: string, key: string) => Promise<boolean>;
  /**
   * What a tab may read about the **device**, where the host was given an inspector.
   *
   * A door and not a surface: the names that go through it are the inspector's, this file never
   * learns one, and a host built without one refuses every read with `NoInspector`. See
   * `@syncmesh/devtools`' `createRemoteSource`, which is the only intended caller.
   */
  readonly inspect: RemoteInspect;
  /** Whether this tab still reaches the host. Not whether the origin's transports are running. */
  readonly running: () => boolean;
  /**
   * Drops this tab's link. It does **not** stop the mesh: the engine belongs to the origin, and
   * four other tabs are reading from it. A tab closing is a client leaving, never a shutdown.
   */
  readonly stop: () => Promise<void>;
}

export interface ConnectOptions<R extends Router> {
  readonly link: MeshLink;
  /**
   * The app's procedures, so this returns the surface a component calls rather than the plumbing
   * under it: `client.issues.list(…)`, the same names the leader's `createClient` hands back.
   *
   * Bundled like {@link ConnectOptions.schema} and for the same reason — procedures are code, and
   * a tab that asked the host for them would be asking for the bundle it is already running.
   */
  readonly procedures: R;
  /**
   * The manifest this tab already bundles — the same value the host was built with.
   *
   * Never fetched across the port, and that is the rule the whole client follows: **static things
   * are local, state crosses.** A manifest carries Drizzle tables, which no `postMessage` can
   * clone, and a tab that asked for one would be asking the host to send it the bundle it is
   * already running.
   */
  readonly schema: ValidatorSchema & MeshSchema;
}

/** The port half of {@link connectMesh}: everything a window can honestly answer, and no api. */
function followerMesh(options: ConnectOptions<Router>): FollowerMesh {
  const { link, schema } = options;
  const wire = openWire(link);

  const grantListeners = new Set<() => void>();
  const fire = (listeners: ReadonlySet<() => void>) => (): void => {
    for (const listener of listeners) listener();
  };
  const canAnswers = createAsked<boolean>(fire(grantListeners));

  /**
   * Held for the life of the link rather than per listener, because it is what *invalidates a
   * cached answer* as well as what notifies: a grant landing has to drop `can`'s answers whether
   * or not anything is currently watching for it.
   */
  wire.listen("grant", () => {
    canAnswers.clear();
    fire(grantListeners)();
  });

  /**
   * Who the origin is acting as, cached here so a handler can be handed it synchronously.
   *
   * Asked once at connect and pushed on every change after, because the read has to answer *now*
   * — a handler that had to await this would be a handler that could not read a table. `undefined`
   * until the first answer lands is the honest gap and the same one the device itself has before
   * its first session.
   */
  let acting: Principal | undefined;
  wire.listen("auth", (payload) => {
    // SAFETY: the host sends what its own `auth.principal()` returned, or null for nobody
    acting = (payload ?? undefined) as Principal | undefined;
  });
  void wire
    .ask<Principal | null>({ kind: "call", path: "principal", args: [] })
    .then((answer) => (acting = answer ?? undefined))
    .catch(() => undefined);

  const source: LiveSource = {
    // SAFETY: the host broadcasts the batch its own engine emitted; `Set` and `Map` cross a
    // structured clone whole, so `writeTables` and `writeKeys` arrive as themselves
    onFoldBatch: (listener) => wire.listen("fold", (payload) => listener(payload as FoldBatch)),
    // SAFETY: the host broadcasts the peer id its own engine named
    onAcknowledge: (listener) => wire.listen("ack", (payload) => listener(payload as PeerId)),
  };

  const handles = new Map<string, Handle>();
  let next = 0;
  const on = (instance?: string, opts: OnOptions = {}) =>
    Result.gen(function* () {
      const partition = instance === undefined ? undefined : yield* parsePartitionKey(instance);
      const acting = opts.as;
      const key = JSON.stringify([instance ?? null, acting ?? null]);
      const held = handles.get(key);
      if (held !== undefined) return Result.ok(held);
      const number = (next += 1);
      const body = { kind: "handle" as const, handle: number };
      if (instance !== undefined) Object.assign(body, { instance });
      if (acting !== undefined) Object.assign(body, { as: acting });
      // the declaration's reply goes nowhere on purpose: the port is ordered, so the first
      // statement is behind it, and a refusal reaches the caller as that statement's failure
      void wire.ask(body).catch(() => undefined);
      const deps = { wire, handle: number, schema, source };
      if (partition !== undefined) Object.assign(deps, { partition });
      if (acting !== undefined) Object.assign(deps, { actor: acting });
      const handle = remoteHandle(deps);
      handles.set(key, handle);
      return Result.ok(handle);
    });

  let alive = true;
  link.onLost(() => (alive = false));

  // the device's facts, asked once now and pushed on change once something watches
  const device = remoteDevice(wire);

  return {
    role: link.role,
    engine: source,
    schema,
    on,
    operations: remoteLedger(wire),
    auth: { ...device.session, principal: () => acting },
    status: device.status,
    transports: device.transports,
    peers: device.peers,
    routes: device.routes,
    heard: device.heard,
    /**
     * This origin's peer id, awaited once.
     *
     * A window needs it before it can build a query that selects `syncOf`, because the column is
     * SQL correlated on *this device's* author id and the SQL is built here. Asynchronous because
     * a port is, and asked exactly once because a device's name does not change while it runs.
     */
    selfId: () => wire.ask<PeerId>({ kind: "call", path: "self", args: [] }),
    deleted: (table, key) =>
      wire.ask<boolean>({ kind: "call", path: "deleted", args: [table, key] }),
    inspect: remoteInspect(wire),
    can: (what, row, instance) =>
      canAnswers.read(JSON.stringify([what, row ?? null, instance ?? null]), () =>
        wire.ask<boolean>({
          kind: "call",
          path: "can",
          args: [what, row ?? null, instance ?? null],
        }),
      ) ?? false,
    grants: {
      onRegistered: (listener) => {
        grantListeners.add(listener);
        return () => void grantListeners.delete(listener);
      },
    },
    query: (sql: string, params?: readonly SqlValue[]) =>
      wire.ask<readonly SqlRow[]>({ kind: "call", path: "query", args: [sql, params ?? null] }),
    flush: () => wire.ask({ kind: "call", path: "flush", args: [] }),
    ready: () => wire.ask({ kind: "call", path: "ready", args: [] }),
    settled: () => wire.ask({ kind: "call", path: "settled", args: [] }),
    running: () => alive,
    stop: () => {
      alive = false;
      handles.clear();
      grantListeners.clear();
      device.close();
      wire.close();
      return Promise.resolve();
    },
  };
}

/**
 * What a tab gets back: the app's procedures at the top level, and the few controls a *window* is
 * entitled to under `$`.
 *
 * The same shape `createClient` hands the leader (book ch. 30), which is the whole point — a
 * component calls `client.issues.list(…)` and cannot tell which tab holds the engine. It is
 * deliberately **not** the same list of controls: `$recovery`, `$accounts`, `$blobs`, `$presence`
 * and the toggles on `$transports` are settings of the **device**, and a window is not a device.
 * A radio toggled in tab three is the origin's radio, and that is a sentence a caller should have
 * to read — so those reach through {@link FollowerClient.$mesh} rather than sitting here. The
 * five `$` surfaces `@syncmesh/react`'s diagnostic hooks read — `$status`, `$transports`,
 * `$peers`, `$routes`, `$auth` — are here in their read-only form, because a header pill is drawn
 * in a window and nowhere else; each answers from the reading the device last pushed.
 */
export type FollowerClient<R extends Router> = Api<R> & {
  /** The window's own view of the origin's mesh, for what a `$` control here does not cover. */
  readonly $mesh: FollowerMesh;
  /** The origin's **one** write ledger: a write made in any window becomes the same row. */
  readonly $operations: FollowerMesh["operations"];
  /** Per-source condition and one overall health, as the device last said (ch. 18). */
  readonly $status: FollowerMesh["status"];
  /** The device's media as facts, with `onLinkEvent` and `forced` beside them; no toggles. */
  readonly $transports: FollowerMesh["transports"];
  /** Who the device can reach, over what (ch. 17). */
  readonly $peers: FollowerMesh["peers"];
  /** Every destination the device knows a way to, and how far (ch. 17). */
  readonly $routes: FollowerMesh["routes"];
  /** Who is signed in on the device, and until when (ch. 14). */
  readonly $auth: FollowerMesh["auth"];
  /** The device's own feeds, where the host was handed an inspector. */
  readonly $inspect: FollowerMesh["inspect"];
  readonly $flush: FollowerMesh["flush"];
  /** Resolves when this window knows who the origin is — a query selecting `syncOf` needs it. */
  readonly $ready: Promise<void>;
  readonly $close: FollowerMesh["stop"];
};

/**
 * A tab's thin client of the origin's one mesh (`research/browser-durability.md` §4).
 *
 * Every tab calls this, the elected one included, so there is exactly one code path: the leader's
 * link is a port to its own worker and a follower's is a port the rendezvous forwarded, and
 * nothing here can tell which. That is what stops the two from drifting apart, which is the
 * failure a second implementation of a seventeen-surface client would eventually be.
 *
 * **It binds the router itself, and that is why it takes one.** An app used to be handed the mesh
 * and left to bind its own api, which put the builder — internal to `createClient` everywhere else
 * — in application code, and made the follower's surface a thing each app assembled by hand. One
 * call makes a client here exactly as one call makes one on the leader.
 *
 * No scope is bound at construction, here or there: a call carries the replica it is about in its
 * own input (book ch. 3), which is what lets one client answer for every workspace a window opens.
 *
 * @example
 * const client = connectMesh({ link: await meshLink(), schema, procedures });
 * client.issues.list({ workspaceId });   // the scope rides here, and nowhere else
 */
export function connectMesh<R extends Router>(options: ConnectOptions<R>): FollowerClient<R> {
  const mesh = followerMesh(options);
  /**
   * The api is built now and the peer id arrives later, which is the shape `meshApi` already has
   * for `createClient`: a lazy source, so a component can hold a descriptor before the port has
   * answered. Asking synchronously is not available — a window cannot know the origin's name
   * without a round trip — and awaiting here would make every tab's boot wait on one.
   */
  let self: PeerId | undefined;
  // and the device's first reading, so nothing drawn under `$ready` sees "not heard yet"
  const ready = Promise.all([mesh.selfId(), mesh.heard()]).then(([id]) => {
    self = id;
  });
  // a window that never awaits `$ready` still must not turn a dead port into an unhandled rejection
  ready.catch(() => undefined);
  const api = meshApi<R>(
    {
      current: () => (self === undefined ? undefined : { ...mesh, self }),
      ready,
      schema: options.schema,
    },
    options.procedures,
  );
  return {
    ...api,
    $mesh: mesh,
    $operations: mesh.operations,
    $status: mesh.status,
    $transports: mesh.transports,
    $peers: mesh.peers,
    $routes: mesh.routes,
    $auth: mesh.auth,
    $inspect: mesh.inspect,
    $flush: mesh.flush,
    $ready: ready,
    $close: mesh.stop,
  };
}
