import type { Transport, TransportContext } from "@syncmesh/transport";

/** The running half of the mesh: every configured transport, started once, stopped together. */
export interface RunningTransports {
  readonly ready: () => Promise<void>;
  readonly running: () => boolean;
  readonly requestGrant: (invite?: string) => void;
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
    requestGrant: (invite) => {
      for (const t of transports) t.requestGrant?.(invite);
    },
    stop: async () => {
      running = false;
      await started.catch(() => undefined);
      await Promise.all(transports.map((t) => t.stop()));
    },
  };
}
