import type { Transport, TransportContext } from "@syncmesh/transport";

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
  readonly requestGrant: (invite?: string) => void;
  /** One ephemeral value to every transport; a transport without the capability ignores it. */
  readonly sendPresence: (wire: Uint8Array) => void;
  /** The transports that can carry bytes out of band (D18); empty when no medium here can. */
  readonly withBlobs: () => readonly Transport[];
  readonly stop: () => Promise<void>;
}

export function runTransports(
  transports: readonly Transport[],
  context: TransportContext,
): RunningTransports {
  const started = Promise.all(transports.map((t) => t.start(context)));
  let running = true;

  return {
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
      for (const t of transports) t.requestGrant?.(invite);
    },
    sendPresence: (wire) => {
      for (const t of transports) t.sendPresence?.(wire);
    },
    withBlobs: () => transports.filter((t) => t.putBlob !== undefined),
    stop: async () => {
      running = false;
      await started.catch(() => undefined);
      await Promise.all(transports.map((t) => t.stop()));
    },
  };
}
