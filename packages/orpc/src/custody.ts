import type { StartRelayOptions } from "@syncmesh/relay";

/**
 * The pure-custody configuration: a node that keeps a copy and is always on, and decides nothing.
 *
 * **A relay is not a tier** (book ch. 22). It is `createServer` with no `handlers` — the same
 * construction as the authority, minus the one thing an authority has: a body for a decision. It
 * verifies signatures and judges nothing, holds no issuer key, and every device on it holds the
 * whole room; what it adds over a phone is an address and an uptime.
 *
 * Saying that with a second entry point — `startRelay(port, …)` beside `createServer(…)` — made
 * it look like a different kind of thing, and the question it invited ("do I need a relay or a
 * server?") has no answer, because the difference is whether you passed `handlers`.
 *
 * The machinery is unchanged and is not re-implemented here; this is the door it is now behind.
 * It is loaded with a dynamic import so that a browser bundle that constructs a client never
 * pulls a WebSocket room host it can never run.
 */
export interface Custody extends StartRelayOptions {
  /** The port rooms are served on. A device dials `ws://host:port/<room>`. */
  readonly port: number;
}

/** What a server that serves custody answers with, beside the rest of its surface. */
export interface Serving {
  readonly port: number;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

export const serveCustody = async ({ port, ...options }: Custody): Promise<Serving> => {
  const { startRelay } = await import("@syncmesh/relay");
  return startRelay(port, options);
};
