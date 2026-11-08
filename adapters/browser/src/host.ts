/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the far side of a `postMessage`: every argument arrives as `unknown` and the `kind` is the parse, exactly as in protocol.ts */

import type { Mesh } from "@syncmesh/client";
import type { WriteNaming } from "@syncmesh/drizzle";
import type { Unsubscribe } from "@syncmesh/engine";
import type { AnyTaggedError } from "@syncmesh/result";

import { Result, serializeTagged } from "@syncmesh/result";

import type { DeviceSource } from "./device.js";
import type { ServedHandle } from "./host-handle.js";
import type { MeshInspector } from "./inspect.js";
import type { TabPhases } from "./phases.js";
import type {
  Answered,
  Ask,
  ClientMessage,
  EnterBody,
  HostMessage,
  LeaveBody,
  OpenHandleBody,
  SqlBody,
  Topic,
  WirePort,
} from "./protocol.js";

import { deviceFeed } from "./device.js";
import { answer } from "./host-calls.js";
import { serveHandle } from "./host-handle.js";
import { answerInspect } from "./inspect.js";
import { answerLedger } from "./ledger.js";
import { createWindowCount } from "./phases.js";
import { MeshCallFailed, NoSuchMeshHandle } from "./protocol.js";

/** Everything a host reads off the mesh, and no more; {@link DeviceSource} is what windows are *told*. */
export type HostMesh = Pick<
  Mesh,
  | "on"
  | "engine"
  | "can"
  // the one fact the app's tables cannot hold: a deleted row is gone from them, tombstone and all
  | "deletedAt"
  | "grants"
  | "flush"
  | "ready"
  | "settled"
  | "running"
  | "query"
  | "operations"
  // the device's session, pushed to every window: a handler is handed `principal` synchronously
  // and a port cannot answer that way, so the origin tells rather than being asked
  | "auth"
> &
  DeviceSource;

export interface ServeOptions {
  /**
   * What a tab may read about the device, or **nothing**, which is what a production build passes.
   *
   * See {@link MeshInspector}: a host with no inspector refuses every inspect ask, so the windows
   * of that origin can read their own data and learn nothing about the mesh carrying it.
   */
  readonly inspector?: MeshInspector | undefined;
  /**
   * How long one tab's rehearsal may hold this origin's handle, in milliseconds.
   *
   * Only a test has a reason to say: the default is tuned for a body running across a port
   * (`host-handle.ts`), and shortening it is how a test stands in the state a torn-down window
   * leaves behind without waiting five seconds to do it.
   */
  readonly spanLimit?: number | undefined;
  /**
   * Where the origin's phase goes: `background` once no window this host serves is shown, and
   * `foreground` when one is again (D39, U32). A window that has not said counts as shown, and a
   * window that leaves stops counting at all. Pass the same {@link TabPhases} whose `knock` the
   * mesh was built with; without it the mesh in a worker hears no lifecycle.
   */
  readonly phases?: TabPhases | undefined;
}

/** What the host is holding for its clients. A subscription left behind after a tab closes shows here. */
export interface HostCensus {
  readonly clients: number;
  /** Standing interests across every client — the sum, so one tab's leak is visible against four tabs. */
  readonly topics: number;
  /** Subscriptions the host holds on the mesh itself; zero once the last interested tab is gone. */
  readonly feeds: number;
  readonly handles: number;
  /**
   * Whether some tab still has the inspector open.
   *
   * Here because it is the one held thing that is not counted above and is the most expensive:
   * the origin's `DevtoolsSource` is several engine subscriptions and one telemetry listener, and
   * `true` after the last panel closed would be the leak this census exists to find.
   */
  readonly inspecting: boolean;
}

export interface MeshHost {
  /** Serves one client over a port. The returned function disconnects it, as its tab closing would. */
  readonly accept: (port: WirePort) => () => void;
  readonly census: () => HostCensus;
  /** Disconnects every client and releases every feed. The mesh itself is not stopped: it is not ours. */
  readonly stop: () => void;
}

interface Client {
  readonly port: WirePort;
  readonly topics: Set<Topic>;
  readonly handles: Map<number, ServedHandle<Client>>;
  readonly numbers: Map<ServedHandle<Client>, number>;
  /** Pairs `mesh.on` refused for this tab, kept so the statement that follows says why. */
  readonly refused: Map<number, AnyTaggedError>;
}

/** A feed this host cannot supply: subscribed, counted and silent, so nothing else has to branch. */
const nothing: Unsubscribe = () => undefined;

interface FeedDeps {
  readonly mesh: HostMesh;
  readonly inspector: MeshInspector | undefined;
  readonly emit: (payload: unknown) => void;
}

/**
 * The one mesh subscription behind a {@link Topic}, however many tabs asked for it.
 *
 * Opening is the acquisition as well as the wiring, which is what the last two arms are for: the
 * inspector's feeds are the only ones whose *cost* is paid on subscribe — the origin's
 * `DevtoolsSource` takes several engine hooks and one telemetry listener — so they are opened
 * here and released by the same refcount that releases `fold`.
 */
const openFeed = (deps: FeedDeps, topic: Topic): Unsubscribe => {
  const { mesh, inspector, emit } = deps;
  if (topic === "fold") return mesh.engine.onFoldBatch(emit);
  if (topic === "ack") return mesh.engine.onAcknowledge(emit);
  if (topic === "grant") return mesh.grants.onRegistered(() => emit(null));
  if (topic === "writes") return mesh.operations?.onChange(() => emit(null)) ?? nothing;
  if (topic === "inspect") return inspector?.watch(emit) ?? nothing;
  // pushed rather than asked: a handler reads `principal` synchronously, and a port cannot answer
  // synchronously — so every window is told, and the device's session is the only one there is
  if (topic === "auth") return mesh.auth.subscribe(() => emit(mesh.auth.principal() ?? null));
  // the device's facts, whole, on any of the feeds that move one of them; and each link event
  if (topic === "device" || topic === "links") return deviceFeed(mesh, topic, emit);
  return inspector?.onForced(emit) ?? nothing;
};

/**
 * Serves this thread's mesh to every tab of the origin.
 *
 * Call it from the dedicated worker `navigator.locks` elected — the one place a durable database
 * can be opened at all — with a mesh built there. Every tab, the leader's own included, then talks
 * to it over a port, so there is **one** engine per origin: one identity, one log, one allocation
 * of `(author, seq)`. Two engines over one log is the silent corruption this whole arrangement
 * exists to prevent (E04's "Watch out"), and the only way to be sure there is one is for there to
 * be one.
 *
 * The host speaks first as well as answering: a fold on this thread is broadcast to every tab that
 * subscribed, and that broadcast is what makes a `useLiveQuery` in tab B re-render because tab A
 * wrote. Standing interests are refcounted, so the last tab closing releases the host's own
 * subscription on the mesh rather than leaving it fed by nobody.
 *
 * **The host hears every window's phase**, which the mesh cannot: a worker has no `document`. Pass
 * `phases` (see {@link TabPhases}) and the mesh goes to the background once no window is shown —
 * marking its log's session clean (D39) — and back with the first one shown, waking its media.
 *
 * @example
 * // worker.ts, inside the elected tab's dedicated worker
 * const phases = createTabPhases();
 * const client = createClient({ schema, storage, knocks: [phases.knock] });
 * await client.$ready; // `$mesh` throws until the mesh has opened
 * const host = serveMesh(client.$mesh, { phases });
 * host.accept(self);                          // this tab
 * onconnect = (e) => host.accept(e.ports[0]); // every other tab, via the rendezvous
 */
/** What the tab already knew about the write it is opening: its id, and the procedure it is in. */
const writeNaming = (message: EnterBody): WriteNaming => ({
  id: message.operationId,
  label: message.label,
});

/**
 * The three messages that speak to one handle: a statement, and the two ends of a span.
 *
 * Out here rather than inside `serveMesh` because it needs nothing of the mesh — only the handle
 * the caller already resolved and the tab that sent it. `span` travels on all three: it is what
 * lets the handle place a statement by the sink it came through rather than by who sent it
 * (`host-handle.ts`).
 */
const onHandle = async <Owner>(
  served: ServedHandle<Owner>,
  owner: Owner,
  message: SqlBody | EnterBody | LeaveBody,
): Promise<Answered> => {
  if (message.kind === "sql")
    return served.sql(owner, message.statement, message.params, message.method, message.span);
  if (message.kind === "enter")
    return served.enter(owner, message.mode, message.span, writeNaming(message));
  const verdict = await served.leave(owner);
  if (verdict === undefined || verdict.isOk()) return null;
  return { refused: serializeTagged(verdict.error) };
};

export function serveMesh(mesh: HostMesh, options: ServeOptions = {}): MeshHost {
  const { inspector, spanLimit } = options;
  const clients = new Set<Client>();
  const windows = createWindowCount<Client>(options.phases);
  const served = new Map<string, ServedHandle<Client>>();
  const feeds = new Map<Topic, { readonly off: Unsubscribe; count: number }>();

  const post = (client: Client, message: HostMessage): void => client.port.postMessage(message);

  const broadcast = (topic: Topic, payload: unknown): void => {
    for (const client of clients)
      if (client.topics.has(topic)) post(client, { kind: "event", topic, payload });
  };

  const open = (topic: Topic): Unsubscribe =>
    openFeed({ mesh, inspector, emit: (payload) => broadcast(topic, payload) }, topic);

  const subscribe = (client: Client, topic: Topic): void => {
    if (client.topics.has(topic)) return;
    client.topics.add(topic);
    const held = feeds.get(topic);
    if (held === undefined) feeds.set(topic, { off: open(topic), count: 1 });
    else held.count += 1;
  };

  const unsubscribe = (client: Client, topic: Topic): void => {
    if (!client.topics.delete(topic)) return;
    const held = feeds.get(topic);
    if (held === undefined) return;
    held.count -= 1;
    if (held.count > 0) return;
    feeds.delete(topic);
    held.off();
  };

  /**
   * One `ServedHandle` per `(instance, principal)` for the whole origin, because `mesh.on` already
   * hands every caller the same `Handle` for that pair — two tabs are two clients of one
   * connection, and the turn inside is what keeps their transactions apart.
   */
  const declare = (client: Client, body: OpenHandleBody): null => {
    const { handle: number, instance } = body;
    const as = body.as;
    const key = JSON.stringify([instance ?? null, as ?? null]);
    let entry = served.get(key);
    if (entry === undefined) {
      // SAFETY: `as` is the `Principal` the client's own `on({ as })` took; the mesh validates the instance
      const opened = mesh.on(instance, as === undefined ? {} : { as: as as never });
      if (opened.isErr()) {
        // remembered rather than thrown away: the declaration's reply goes nowhere, and the
        // statement that follows it deserves the real reason rather than "no such handle"
        client.refused.set(number, opened.error);
        throw opened.error;
      }
      // the receipt's route is the entry itself, which does not exist until `serveHandle` returns
      let created!: ServedHandle<Client>;
      created = serveHandle<Client>(
        opened.value,
        (owner, receipt) => {
          const seat = owner.numbers.get(created);
          if (seat !== undefined) post(owner, { kind: "commit", handle: seat, payload: receipt });
        },
        spanLimit,
      );
      served.set(key, created);
      entry = created;
    }
    client.handles.set(number, entry);
    // the first tab to ask for a pair owns the receipt route for it; a second tab's writes travel
    // back under its own number, which is why this is per client and not per served handle
    if (!client.numbers.has(entry)) client.numbers.set(entry, number);
    return null;
  };

  const handle = (client: Client, number: number): ServedHandle<Client> => {
    const refusal = client.refused.get(number);
    if (refusal !== undefined) throw refusal;
    const found = client.handles.get(number);
    if (found === undefined)
      throw new NoSuchMeshHandle({ handle: number, message: "this handle was never opened here" });
    return found;
  };

  const dispatch = async (client: Client, message: Ask): Promise<Answered> => {
    if (message.kind === "call") return answer(mesh, message.path, message.args);
    if (message.kind === "ledger") return answerLedger(mesh.operations, message.path, message.args);
    if (message.kind === "inspect") return answerInspect(inspector, message);
    if (message.kind === "handle") return declare(client, message);
    if (message.kind === "sql" || message.kind === "enter" || message.kind === "leave")
      return onHandle(handle(client, message.handle), client, message);
    if (message.kind === "subscribe") subscribe(client, message.topic);
    else unsubscribe(client, message.topic);
    return null;
  };

  /** A tagged failure keeps its tag across the port; anything else becomes one that names the call. */
  const wrap =
    (path: string) =>
    (cause: unknown): AnyTaggedError => {
      if (cause instanceof Error && "_tag" in cause) {
        // SAFETY: a tagged error is an `Error` carrying `_tag`, which is exactly what was read off it
        return cause as AnyTaggedError;
      }
      return new MeshCallFailed({
        path,
        message: cause instanceof Error ? cause.message : `the mesh refused ${path}`,
      });
    };

  const disconnect = (client: Client): void => {
    if (!clients.delete(client)) return;
    for (const topic of Array.from(client.topics)) unsubscribe(client, topic);
    for (const entry of client.handles.values()) entry.abandon(client);
    client.handles.clear();
    client.numbers.clear();
    client.refused.clear();
    client.port.onmessage = null;
    windows.leave(client);
  };

  const accept = (port: WirePort): (() => void) => {
    const client: Client = {
      port,
      topics: new Set(),
      handles: new Map(),
      numbers: new Map(),
      refused: new Map(),
    };
    clients.add(client);
    windows.arrive(client);
    port.onmessage = (event) => {
      // SAFETY: the only sender is `connectMesh`, whose every post is a `ClientMessage`
      const message = event.data as ClientMessage;
      if (message.kind === "bye") {
        disconnect(client);
        return;
      }
      if (message.kind === "phase") {
        windows.say(client, message.phase);
        return;
      }
      const { id } = message;
      void Result.tryPromise({ try: () => dispatch(client, message), catch: wrap(message.kind) })
        .then((result) =>
          post(
            client,
            result.isErr()
              ? { id, ok: false, error: serializeTagged(result.error) }
              : { id, ok: true, value: result.value },
          ),
        )
        .catch(() => undefined);
    };
    return () => disconnect(client);
  };

  return {
    accept,
    census: () => ({
      clients: clients.size,
      topics: Array.from(clients).reduce((total, client) => total + client.topics.size, 0),
      feeds: feeds.size,
      handles: Array.from(served.values()).filter((entry) => !entry.idle()).length,
      inspecting: feeds.has("inspect"),
    }),
    stop: () => {
      windows.stop();
      for (const client of Array.from(clients)) disconnect(client);
      for (const entry of served.values()) entry.stop();
      served.clear();
    },
  };
}
