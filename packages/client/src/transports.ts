import type { Transport, TransportContext } from "@syncmesh/transport";

/** The running half of the mesh: every configured transport, started once, stopped together. */
export interface RunningTransports {
  readonly ready: () => Promise<void>;
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
