import type { PeerId } from "@syncmesh/kernel";
import type { Result as ResultType } from "@syncmesh/result";
import type {
  RouteCandidate,
  RouteMessage,
  Transport,
  TransportContext,
} from "@syncmesh/transport";

import { Result, TaggedError } from "@syncmesh/result";
import { KIND, ORDINARY_LINK, pickRoutes } from "@syncmesh/transport";

import { boundable, enforceBudget } from "./admission.js";

/** The medium refused to start, or the set had already stopped; the mesh runs on without it. */
export class TransportAddFailed extends TaggedError("TransportAddFailed")<{
  readonly transport: string;
  message: string;
  cause?: unknown;
}> {}

/** The running half of the mesh: every configured transport, started once, stopped together. */
export interface RunningTransports {
  readonly ready: () => Promise<void>;
  /**
   * Every source that could still fill a scope has finished its first pass — the question an app
   * must answer before it draws an empty state. Sources are awaited nearest first (RFC-0019), so
   * a radio holding nothing never resolves ahead of the relay that holds everything.
   *
   * The device's own storage is not among them: boot replays the log before a mesh exists, so by
   * the time this can be called it has already answered.
   */
  readonly settled: () => Promise<void>;
  readonly running: () => boolean;
  /**
   * The transports that should carry this message, best first (RFC-0012 §2). Offline ones are
   * gone, and a class a medium refuses outright — presence, to a dormant expensive radio — is
   * gone with them.
   */
  readonly route: (message: RouteMessage, among?: readonly Transport[]) => readonly Transport[];
  readonly requestGrant: (invite?: string) => void;
  /** One ephemeral value to every transport worth putting it on; the rest ignore or refuse it. */
  readonly sendPresence: (wire: Uint8Array) => void;
  /** The transports that can carry bytes out of band (D18); empty when no medium here can. */
  readonly withBlobs: () => readonly Transport[];
  /** The mediums currently running, in attach order. */
  readonly list: () => readonly Transport[];
  /** Starts one more medium mid-life — a settings toggle, a diagnostic pane (book ch. 8, 16). */
  readonly add: (transport: Transport) => Promise<ResultType<void, TransportAddFailed>>;
  /**
   * Stops one medium by name and takes its route away; `drain` flushes its queue first.
   * Removing a transport removes a route, never replica data. `false` when no such name runs.
   */
  readonly remove: (name: string, options?: { readonly drain?: boolean }) => Promise<boolean>;
  readonly stop: () => Promise<void>;
}

export function runTransports(
  transports: readonly Transport[],
  context: TransportContext,
): RunningTransports {
  /**
   * Whether each medium is up, from the one place that says so. A transport that has not spoken
   * yet is assumed up: a send that turns out to be wrong fails loudly and resyncs, where
   * assuming down would keep a working link idle until it happened to announce itself.
   *
   * Subscribed before anything is started, so a medium that fails while opening is heard.
   */
  const online = new Map<Transport, boolean>();
  /** The live set: construction seeds it, `add`/`remove` reshape it, everything reads it. */
  const active: Transport[] = [...transports];
  const watching = new Map<Transport, () => void>();
  const watch = (t: Transport): void =>
    void watching.set(t, t.onStatus?.((up) => void online.set(t, up)) ?? (() => undefined));
  for (const t of active) watch(t);

  // the context each transport actually starts with: the caller's, plus the routing question
  // only this set can answer — a transport started by a test gets the caller's own and carries
  // everything, which is the behaviour every transport had before link admission
  const routed: TransportContext = {
    ...context,
    carries: (name, message) => carries(name, message),
  };
  const starts = new Map<Transport, Promise<void>>(active.map((t) => [t, t.start(routed)]));
  const started = Promise.all(starts.values());
  let running = true;

  /**
   * Holds each radio to the links it says it sustains (E28).
   *
   * Run when the facts it selects on change — an acknowledgement moves a peer's cursor, a grant
   * changes which partitions are shared — rather than on a timer. There is no clock in this file,
   * and adding one to ask a question whose inputs announce themselves would be a worse answer.
   */
  const sweep = (): void => {
    if (!running) return;
    const facts = {
      acks: () => context.engine.acks(),
      held: () => context.engine.coverage().synced,
      partitionsOf: (device: PeerId) => context.grants.grantFor(device)?.partitions.map(String),
      self: context.identity.peerId,
    };
    for (const transport of active) enforceBudget(transport, facts);
  };
  /**
   * Nothing to enforce, nothing to watch: a set whose transports cannot close a link is not one a
   * budget applies to, and subscribing anyway would be work done for no possible outcome — which
   * is also why a transport driven with no mesh behind it never touches the engine at all. A
   * transport added later can be the first boundable one, so this is asked again on `add`.
   */
  const offAdmission: (() => void)[] = [];
  const watchAdmission = (): void => {
    if (offAdmission.length > 0 || !active.some(boundable)) return;
    offAdmission.push(context.engine.onAcknowledge(sweep), context.grants.onRegistered(sweep));
  };
  watchAdmission();

  /**
   * Score the candidates and hand back the transports behind the survivors.
   *
   * Candidates are matched to their transport by identity rather than by name, so two mediums
   * configured under one name cannot collapse into each other — the name is the scorer's
   * tie-break, and a tie-break is not an identifier.
   */
  /**
   * Whether one transport is among the links this frame should go on (E28).
   *
   * Asked per link rather than decided centrally, because each bridge already owns its own send:
   * the mesh says which links a frame belongs on and the links do the rest, which is a smaller
   * change than moving every send into one dispatcher and leaves a transport able to run with no
   * mesh at all — which is how every transport test drives one.
   */
  const carries = (transport: string, message: RouteMessage): boolean =>
    route(message).some((picked) => picked.name === transport);

  const route = (
    message: RouteMessage,
    among: readonly Transport[] = active,
  ): readonly Transport[] => {
    const owners = new Map<RouteCandidate, Transport>();
    const candidates = among.map((t) => {
      const candidate = {
        id: t.name,
        online: online.get(t) ?? true,
        ...(t.route?.() ?? ORDINARY_LINK),
      };
      // a medium that cannot enumerate its links stays absent, which reads as "cannot say"
      const reaches = t.reaches?.();
      if (reaches !== undefined) Object.assign(candidate, { reaches });
      owners.set(candidate, t);
      return candidate;
    });
    return pickRoutes(candidates, message).flatMap((c) => owners.get(c) ?? []);
  };

  /**
   * Every transport worth putting this on, in order — not the single best one.
   *
   * The scorer as a filter, because a broadcast is what these two calls are. Which one link
   * reaches a given peer is a question nothing here can answer, since no transport publishes a
   * per-peer link list, so narrowing to the winner would silently stop talking to whoever was
   * only reachable down the link that lost. Choosing arrives with link admission (RFC-0012 §1).
   * What the scoring settles today is which links are worth trying at all.
   */
  const every = (message: Omit<RouteMessage, "redundancy">): readonly Transport[] =>
    route({ ...message, redundancy: active.length });

  return {
    route,
    ready: async () => {
      await started;
      await Promise.all([...starts.values()].map((p) => p.catch(() => undefined)));
      await Promise.all(active.map((t) => t.whenReady()));
    },
    running: () => running,
    settled: async () => {
      await Promise.all(active.map((t) => t.whenReady()));
      const nearestFirst = [...active].sort((x, y) => (x.priority ?? 1) - (y.priority ?? 1));
      // sequentially, and in that order: waiting on them together would let the furthest source
      // decide when the answer is ready, which is exactly the race this exists to lose
      for (const transport of nearestFirst) await transport.caughtUp?.();
    },
    requestGrant: (invite) => {
      // every link that is up, not the best one: this is the ask that gets a device admitted at
      // all, and whoever can answer it may be reachable on only one of them
      for (const t of every({ cls: KIND.grantRequest, bytes: 0 })) t.requestGrant?.(invite);
    },
    sendPresence: (wire) => {
      for (const t of every({ cls: KIND.presence, bytes: wire.length })) t.sendPresence?.(wire);
    },
    withBlobs: () => active.filter((t) => t.putBlob !== undefined),
    list: () => [...active],
    add: async (transport) => {
      if (!running)
        return Result.err(
          new TransportAddFailed({ transport: transport.name, message: "the mesh has stopped" }),
        );
      watch(transport);
      active.push(transport);
      const opening = transport.start(routed);
      starts.set(transport, opening);
      const outcome = await Result.tryPromise({
        try: () => opening,
        catch: (cause) =>
          new TransportAddFailed({
            transport: transport.name,
            message: `${transport.name} failed to start`,
            cause,
          }),
      });
      if (outcome.isErr()) {
        const at = active.indexOf(transport);
        if (at >= 0) active.splice(at, 1);
        watching.get(transport)?.();
        watching.delete(transport);
        starts.delete(transport);
        return Result.err(outcome.error);
      }
      watchAdmission(); // the newcomer may be the first medium a budget applies to
      sweep();
      return Result.ok(undefined);
    },
    remove: async (name, options = {}) => {
      const held = active.find((t) => t.name === name);
      if (held === undefined) return false;
      // out of the set first, so no new frame routes onto a medium that is going away
      active.splice(active.indexOf(held), 1);
      watching.get(held)?.();
      watching.delete(held);
      online.delete(held);
      starts.delete(held);
      if (options.drain === true) await held.flush?.().catch(() => undefined);
      await held.stop();
      return true;
    },
    stop: async () => {
      running = false;
      for (const stopWatching of watching.values()) stopWatching();
      watching.clear();
      for (const off of offAdmission) off();
      await started.catch(() => undefined);
      await Promise.all(active.map((t) => t.stop()));
    },
  };
}
