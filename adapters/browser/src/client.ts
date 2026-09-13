import type { Handle, Mesh, MeshSchema, OnOptions } from "@syncmesh/client";
import type { LiveSource } from "@syncmesh/drizzle";
import type { FoldBatch, Principal, ValidatorSchema } from "@syncmesh/engine";
import type { InvalidPartitionKey, PeerId } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type { SqlRow, SqlValue } from "@syncmesh/storage";

import { parsePartitionKey } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { RemoteInspect } from "./inspect.js";
import type { RemoteOperations } from "./ledger.js";
import type { MeshLink } from "./link.js";

import { createAsked } from "./asked.js";
import { remoteInspect } from "./inspect.js";
import { remoteLedger } from "./ledger.js";
import { remoteHandle } from "./remote-handle.js";
import { openWire } from "./wire.js";

/**
 * The mesh as a tab that does not hold it can honestly answer.
 *
 * Narrower than `Mesh`, and the omissions are the argument rather than a to-do list: `transports`,
 * `routes`, `recovery`, `auth`, `accounts`, `blobs` and `presence` are facts and controls of **the
 * device**, and a follower tab is not a device — it is one of several windows onto one. A radio
 * toggled in tab three is the origin's radio, and deciding what that means is a product question
 * (`research/browser-durability.md` §4 settles identity, not settings). What is here is what a
 * *window* needs: the data, the live queries over it, and the two synchronous questions a
 * component asks while it renders.
 *
 * Two of those omissions have since been answered rather than argued away, and both cross as what
 * they are. {@link FollowerMesh.operations} is the origin's **one** write ledger, because a write
 * made in any window becomes the same row; and {@link FollowerMesh.inspect} is a door onto the
 * device's own feeds that exists only where the host was handed an inspector. The device's
 * *controls* still reach through that door rather than sitting on this interface, because a radio
 * held from tab three is held for the device — which is a sentence a caller should have to read.
 *
 * It satisfies `@syncmesh/orpc`'s `ApiMesh` structurally, so `meshApi(mesh, router, { instance })`
 * builds the same api here that it builds on the leader — one implementation of the app's surface,
 * not two.
 */
export interface FollowerMesh extends Pick<
  Mesh,
  "can" | "syncOf" | "query" | "flush" | "ready" | "settled" | "schema"
> {
  /** Whether this tab's own worker is the host. For the header, the way the storage badge is. */
  readonly role: MeshLink["role"];
  /** The fold feed a live query re-runs on — here, batches that arrived over the port. */
  readonly engine: LiveSource;
  readonly on: (instance?: string, options?: OnOptions) => ResultType<Handle, InvalidPartitionKey>;
  /** Fires when a fold, a write or an ack may have changed what `syncOf` answers. */
  readonly onSyncChange: (listener: () => void) => () => void;
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
  /** Who the origin acts as. A window has no session of its own to differ with (ch. 14). */
  readonly auth: { readonly principal: () => Principal | undefined };
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

export interface ConnectOptions {
  readonly link: MeshLink;
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

/**
 * A tab's thin client of the origin's one mesh (`research/browser-durability.md` §4).
 *
 * Every tab calls this, the elected one included, so there is exactly one code path: the leader's
 * link is a port to its own worker and a follower's is a port the rendezvous forwarded, and
 * nothing here can tell which. That is what stops the two from drifting apart, which is the
 * failure a second implementation of a seventeen-surface client would eventually be.
 *
 * @example
 * const mesh = connectMesh({ link: await meshLink(), schema });
 * export const api = meshApi(mesh, router, { instance: "org:acme" });
 */
export function connectMesh(options: ConnectOptions): FollowerMesh {
  const { link, schema } = options;
  const wire = openWire(link);

  const syncListeners = new Set<() => void>();
  const grantListeners = new Set<() => void>();
  const fire = (listeners: ReadonlySet<() => void>) => (): void => {
    for (const listener of listeners) listener();
  };
  const syncAnswers = createAsked<Mesh["syncOf"] extends (...args: never) => infer R ? R : never>(
    fire(syncListeners),
  );
  const canAnswers = createAsked<boolean>(fire(grantListeners));

  /**
   * Both feeds are held for the life of the link rather than per listener, because both are what
   * *invalidates a cached answer* as well as what notifies: a grant landing has to drop `can`'s
   * answers whether or not anything is currently watching for it.
   */
  wire.listen("sync", () => {
    syncAnswers.clear();
    fire(syncListeners)();
  });
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

  return {
    role: link.role,
    engine: source,
    schema,
    on,
    operations: remoteLedger(wire),
    auth: { principal: () => acting },
    inspect: remoteInspect(wire),
    can: (what, row, instance) =>
      canAnswers.read(JSON.stringify([what, row ?? null, instance ?? null]), () =>
        wire.ask<boolean>({
          kind: "call",
          path: "can",
          args: [what, row ?? null, instance ?? null],
        }),
      ) ?? false,
    syncOf: (table, key) =>
      syncAnswers.read(JSON.stringify([table, key]), () =>
        wire.ask({ kind: "call", path: "syncOf", args: [table, key] }),
      ),
    onSyncChange: (listener) => {
      syncListeners.add(listener);
      return () => void syncListeners.delete(listener);
    },
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
      syncListeners.clear();
      grantListeners.clear();
      wire.close();
      return Promise.resolve();
    },
  };
}
