import type {
  RouteCandidate,
  RouteMessage,
  Transport,
  TransportContext,
} from "@syncmesh/transport";

import { KIND, ORDINARY_LINK, pickRoutes } from "@syncmesh/transport";

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
  const watching = transports.map(
    (t) => t.onStatus?.((up) => void online.set(t, up)) ?? (() => undefined),
  );

  // the context each transport actually starts with: the caller's, plus the routing question
  // only this set can answer — a transport started by a test gets the caller's own and carries
  // everything, which is the behaviour every transport had before link admission
  const routed: TransportContext = {
    ...context,
    carries: (name, message) => carries(name, message),
  };
  const started = Promise.all(transports.map((t) => t.start(routed)));
  let running = true;

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

  const route = (message: RouteMessage, among = transports): readonly Transport[] => {
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
    route({ ...message, redundancy: transports.length });

  return {
    route,
    ready: async () => {
      await started;
      await Promise.all(transports.map((t) => t.whenReady()));
    },
    running: () => running,
    settled: async () => {
      await Promise.all(transports.map((t) => t.whenReady()));
      const nearestFirst = [...transports].sort((x, y) => (x.priority ?? 1) - (y.priority ?? 1));
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
    withBlobs: () => transports.filter((t) => t.putBlob !== undefined),
    stop: async () => {
      running = false;
      for (const stopWatching of watching) stopWatching();
      await started.catch(() => undefined);
      await Promise.all(transports.map((t) => t.stop()));
    },
  };
}
