import type { CarrierPort, RendezvousAsk, RendezvousTell } from "./rendezvous.js";

/**
 * The half of `SharedWorkerGlobalScope` this broker uses, which is one member.
 *
 * `lib.dom.d.ts` does not declare that scope, so the shape has to be named here — the same reason
 * `WirePort` exists one package over.
 */
export interface ConnectScope {
  onconnect: ((event: MessageEvent) => void) | null;
}

/**
 * The origin's rendezvous: it introduces tabs to the one that holds the mesh, and does nothing else.
 *
 * **It never touches a file, and cannot.** `createSyncAccessHandle` reads `undefined` here just
 * as it does on a page. What it has instead is the only thing a browser gives an origin exactly
 * one of — so it is where a follower's port is addressed to "the host" rather than to a tab it
 * has no way to name.
 *
 * **A port that arrives with no host waits rather than failing.** That queue is the whole of the
 * failover story on this side: while a leader's tab is closing and the next worker is being
 * granted the lock, seekers pile up, and the newly elected tab's `host` flushes them in one turn.
 * Nothing here polls, nothing times out, and nothing here decides who the leader is — the lock
 * does that, in the workers, and this only learns the outcome.
 *
 * `turnover` goes to every connection except the new host, because the new host built its link
 * from `hosting` and tearing it down again would be this broker undoing the handover it just
 * brokered.
 *
 * @example
 * // rendezvous-worker.ts — the SharedWorker entry
 * broker(globalThis);
 */
export function broker(scope: ConnectScope): void {
  const connections = new Set<CarrierPort>();
  const waiting: MessagePort[] = [];
  let host: CarrierPort | undefined;

  const handOver = (to: CarrierPort, port: MessagePort) =>
    to.postMessage({ kind: "serve" } satisfies RendezvousTell, [port]);

  const turnover = (except: CarrierPort | undefined) => {
    for (const connection of connections)
      if (connection !== except)
        connection.postMessage({ kind: "turnover" } satisfies RendezvousTell);
  };

  /**
   * A first host turns over nobody, because nothing was talking to a previous one. A *second*
   * turns over everybody but itself — including the case where the one before it died without
   * saying so, which is what a crash or a kill looks like from here.
   */
  const hosted = (from: CarrierPort) => {
    const before = host;
    host = from;
    from.postMessage({ kind: "hosting" } satisfies RendezvousTell);
    for (const waiter of waiting.splice(0)) handOver(from, waiter);
    if (before !== undefined && before !== from) turnover(from);
  };

  const sought = (port: MessagePort | undefined) => {
    if (port === undefined) return;
    if (host === undefined) waiting.push(port);
    else handOver(host, port);
  };

  /**
   * A tab saying goodbye is best effort and the only *fast* notice there is: `pagehide` fires on
   * an ordinary close, and nothing fires on a crash. The slow notice always arrives — the lock is
   * granted to the next worker and its tab announces — so a lost message costs latency, never
   * correctness.
   */
  const left = (from: CarrierPort) => {
    connections.delete(from);
    if (from !== host) return;
    host = undefined;
    turnover(undefined);
  };

  scope.onconnect = (event) => {
    const port = event.ports[0];
    if (port === undefined) return;
    connections.add(port);
    port.onmessage = (message) => {
      // SAFETY: every sender is `rendezvousOver`, whose every post is a `RendezvousAsk`
      const ask = message.data as RendezvousAsk;
      if (ask.kind === "host") hosted(port);
      else if (ask.kind === "seek") sought(message.ports[0]);
      else left(port);
    };
  };
}
