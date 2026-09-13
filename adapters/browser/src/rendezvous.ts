/* oxlint-disable anti-slop/no-unknown-parameters -- this file *is* the thread boundary: a `postMessage` hands over `unknown` and the `kind` is the parse (`adapters/sqlite-wasm`'s protocol.ts disables the same rule for the same reason) */

import type { WirePort } from "@syncmesh/sqlite-wasm";

/**
 * A {@link WirePort} that can also hand a `MessagePort` over.
 *
 * The rendezvous needs the second argument to `postMessage` and an RPC never does, which is why
 * this widens `WirePort` instead of replacing it: a broker's whole job is moving ports, and the
 * conversations those ports carry do not know a broker exists. `Worker`, `MessagePort` and a
 * `SharedWorker`'s port all satisfy it.
 */
export interface CarrierPort extends WirePort {
  readonly postMessage: {
    (message: unknown): void;
    (message: unknown, transfer: Transferable[]): void;
  };
}

/** What a tab says to the rendezvous. Three sentences, and none of them names a file. */
export type RendezvousAsk =
  | { readonly kind: "host" }
  | { readonly kind: "seek" }
  | { readonly kind: "leaving" };

/**
 * What the rendezvous says back.
 *
 * `turnover` reaches every tab **except** the one that just claimed the host role, which is what
 * keeps a newly promoted tab from tearing down the link it built one turn ago. Its own
 * confirmation is `hosting`, and that is the signal it uses instead.
 */
export type RendezvousTell =
  | { readonly kind: "hosting" }
  | { readonly kind: "serve" }
  | { readonly kind: "turnover" };

/** This tab's end of the origin's rendezvous. One per page; every link goes through it. */
export interface Rendezvous {
  /** Claim the host role. Resolves once the rendezvous has this tab down as the host. */
  readonly announce: () => Promise<void>;
  /**
   * Hand a port to whoever the host is — now, or the moment one registers.
   *
   * The waiting is the point. A tab that asks during a handover is not refused and does not
   * poll; its port sits in the rendezvous until the newly elected worker announces, and is then
   * delivered. That is the re-plumbing, and it is one queue rather than a retry loop.
   */
  readonly seek: (port: MessagePort) => void;
  /** Ports this tab has been asked to serve. Only ever delivered to the host. */
  readonly onServe: (listen: (port: MessagePort) => void) => void;
  /** The host changed or went away: every link made before now is dead. */
  readonly onTurnover: (listen: () => void) => void;
  /** This tab is going away, said while it still can. */
  readonly leave: () => void;
}

/**
 * The page's end of {@link broker}.
 *
 * It brokers ports and it touches no file, which is not a design preference but the platform's
 * ruling: `FileSystemFileHandle.prototype.createSyncAccessHandle` reads `undefined` in a
 * `SharedWorker` exactly as it does on a page, because `SharedWorkerGlobalScope` is not a
 * `DedicatedWorkerGlobalScope`. Anything that owns an OPFS database is a dedicated worker; the
 * `SharedWorker` is only the one place in a browser where an origin has a singleton at all.
 */
export function rendezvousOver(bus: CarrierPort): Rendezvous {
  let hosting: (() => void) | undefined;
  let served: ((port: MessagePort) => void) | undefined;
  let turned: (() => void) | undefined;

  bus.onmessage = (event) => {
    // SAFETY: the only sender is `broker`, whose every post is a `RendezvousTell` — a `SharedWorker` is
    // reached by name within one origin, so a message from anywhere else is not addressable
    const message = event.data as RendezvousTell;
    if (message.kind === "hosting") hosting?.();
    else if (message.kind === "turnover") turned?.();
    else {
      const port = event.ports[0];
      if (port !== undefined) served?.(port);
    }
  };

  return {
    announce: () =>
      new Promise((settle) => {
        hosting = settle;
        bus.postMessage({ kind: "host" } satisfies RendezvousAsk);
      }),
    seek: (port) => bus.postMessage({ kind: "seek" } satisfies RendezvousAsk, [port]),
    onServe: (listen) => {
      served = listen;
    },
    onTurnover: (listen) => {
      turned = listen;
    },
    leave: () => bus.postMessage({ kind: "leaving" } satisfies RendezvousAsk),
  };
}
