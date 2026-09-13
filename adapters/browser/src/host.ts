/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the far side of a `postMessage`: every argument arrives as `unknown` and the `kind` is the parse, exactly as in protocol.ts */

import type { Mesh } from "@syncmesh/client";
import type { WriteNaming } from "@syncmesh/drizzle";
import type { Unsubscribe } from "@syncmesh/engine";
import type { AnyTaggedError } from "@syncmesh/result";

import { Result, serializeTagged } from "@syncmesh/result";

import type { ServedHandle } from "./host-handle.js";
import type { MeshInspector } from "./inspect.js";
import type {
  Answered,
  ClientMessage,
  EnterBody,
  HostMessage,
  InspectAnswer,
  InspectBody,
  OpenHandleBody,
  Topic,
  WirePort,
} from "./protocol.js";

import { answer } from "./host-calls.js";
import { serveHandle } from "./host-handle.js";
import { answerLedger } from "./ledger.js";
import { MeshCallFailed, NoInspector, NoSuchMeshHandle } from "./protocol.js";

/** Everything a host reads off the mesh it is serving, and no more. */
export type HostMesh = Pick<
  Mesh,
  | "on"
  | "engine"
  | "can"
  | "syncOf"
  | "onSyncChange"
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
>;

export interface ServeOptions {
  /**
   * What a tab may read about the device, or **nothing**, which is what a production build passes.
   *
   * See {@link MeshInspector}: a host with no inspector refuses every inspect ask, so the windows
   * of that origin can read their own data and learn nothing about the mesh carrying it.
   */
  readonly inspector?: MeshInspector | undefined;
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
const feedFor = (deps: FeedDeps, topic: Topic): Unsubscribe => {
  const { mesh, inspector, emit } = deps;
  if (topic === "fold") return mesh.engine.onFoldBatch(emit);
  if (topic === "ack") return mesh.engine.onAcknowledge(emit);
  if (topic === "sync") return mesh.onSyncChange(() => emit(null));
  if (topic === "grant") return mesh.grants.onRegistered(() => emit(null));
  if (topic === "writes") return mesh.operations?.onChange(() => emit(null)) ?? nothing;
  if (topic === "inspect") return inspector?.watch(emit) ?? nothing;
  // pushed rather than asked: a handler reads `principal` synchronously, and a port cannot answer
  // synchronously — so every window is told, and the device's session is the only one there is
  if (topic === "auth") return mesh.auth.subscribe(() => emit(mesh.auth.principal() ?? null));
  return inspector?.onForced(emit) ?? nothing;
};

/**
 * A named read of the device, or the reason there is nothing to read.
 *
 * The answer is wrapped rather than returned bare because this file never opens it: what is
 * inside is the inspector's vocabulary and the tab's to decode, and an envelope keeps
 * {@link Answered} a closed union instead of the `unknown` that would swallow it.
 */
const inspect = async (
  inspector: MeshInspector | undefined,
  body: InspectBody,
): Promise<InspectAnswer> => {
  if (inspector === undefined)
    throw new NoInspector({
      read: body.read,
      message: "this origin's host was built without an inspector, so it serves no readings",
    });
  return { inspected: await inspector.read(body.read, body.args) };
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
 * @example
 * // worker.ts, inside the elected tab's dedicated worker
 * const mesh = (await createMesh({ … })).unwrap();
 * const host = serveMesh(mesh);
 * host.accept(self);                          // this tab
 * onconnect = (e) => host.accept(e.ports[0]); // every other tab, via the rendezvous
 */
/** What the tab already knew about the write it is opening: its id, and the procedure it is in. */
const namingOf = (message: EnterBody): WriteNaming => ({
  id: message.operationId,
  label: message.label,
});

export function serveMesh(mesh: HostMesh, options: ServeOptions = {}): MeshHost {
  const { inspector } = options;
  const clients = new Set<Client>();
  const served = new Map<string, ServedHandle<Client>>();
  const feeds = new Map<Topic, { readonly off: Unsubscribe; count: number }>();

  const post = (client: Client, message: HostMessage): void => client.port.postMessage(message);

  const broadcast = (topic: Topic, payload: unknown): void => {
    for (const client of clients)
      if (client.topics.has(topic)) post(client, { kind: "event", topic, payload });
  };

  const open = (topic: Topic): Unsubscribe =>
    feedFor({ mesh, inspector, emit: (payload) => broadcast(topic, payload) }, topic);

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
      created = serveHandle<Client>(opened.value, (owner, receipt) => {
        const seat = owner.numbers.get(created);
        if (seat !== undefined) post(owner, { kind: "commit", handle: seat, payload: receipt });
      });
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

  const dispatch = async (client: Client, message: ClientMessage): Promise<Answered> => {
    if (message.kind === "bye") return null;
    if (message.kind === "call") return answer(mesh, message.path, message.args);
    if (message.kind === "ledger") return answerLedger(mesh.operations, message.path, message.args);
    if (message.kind === "inspect") return inspect(inspector, message);
    if (message.kind === "handle") return declare(client, message);
    if (message.kind === "sql")
      return handle(client, message.handle).sql(
        client,
        message.statement,
        message.params,
        message.method,
      );
    if (message.kind === "enter")
      return handle(client, message.handle).enter(client, message.mode, namingOf(message));
    if (message.kind === "leave") {
      const verdict = await handle(client, message.handle).leave(client);
      if (verdict === undefined || verdict.isOk()) return null;
      return { refused: serializeTagged(verdict.error) };
    }
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
    port.onmessage = (event) => {
      // SAFETY: the only sender is `connectMesh`, whose every post is a `ClientMessage`
      const message = event.data as ClientMessage;
      if (message.kind === "bye") {
        disconnect(client);
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
      for (const client of Array.from(clients)) disconnect(client);
      for (const entry of served.values()) entry.stop();
      served.clear();
    },
  };
}
