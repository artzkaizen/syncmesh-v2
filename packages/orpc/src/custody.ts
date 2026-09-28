import type {
  BunWebSocketHandlers,
  RelayHost,
  RelayHostOptions,
  SocketData,
  StartRelayOptions,
} from "@syncmesh/relay";

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
  /**
   * A port of custody's own: a device dials `ws://host:port/<room>`, and procedures answer
   * elsewhere. Absent, custody rides the server's own port — `fetch` takes the upgrade and
   * `websocket` drives the sockets — which is the single-port recipe, and the ordinary one.
   */
  readonly port?: number;
  /**
   * How one room's log is opened, on a runtime other than Bun: `nodeRoomStore` from
   * `@syncmesh/relay-node`. Absent, Bun's own SQLite under `dataDir`.
   */
  readonly openRoomStore?: RelayHostOptions["openRoomStore"];
}

/** What a server that serves custody on its own port answers with, beside the rest of its surface. */
export interface Serving {
  readonly port: number;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

/** Bun's `server.upgrade`, as the one call the single-port fetch needs of it. */
export interface Upgrading {
  readonly upgrade: (request: Request, options: { readonly data: SocketData }) => boolean;
}

/**
 * Custody served through the server's own fetch: the room host, the part of a request that is
 * custody's to answer, and Bun's socket callbacks.
 *
 * `take` is `undefined` for a request that is not custody's — a procedure call — so the server's
 * fetch tries custody first and falls through. An upgrade is custody's; so is a plain `GET` on a
 * room's path, which is answered with the room described rather than a 426 nobody asked for.
 */
export interface InlineCustody {
  readonly host: RelayHost;
  readonly take: (
    request: Request,
    upgrading: Upgrading | undefined,
  ) => Promise<Response | undefined> | undefined;
  readonly websocket: BunWebSocketHandlers;
  readonly stop: () => Promise<void>;
}

const NO_UPGRADER =
  "syncmesh: custody is served on this port; hand Bun's server to fetch as its second argument so the socket can be upgraded";

export const serveCustody = async ({ port, ...options }: Custody): Promise<Serving> => {
  const { startRelay } = await import("@syncmesh/relay");
  if (port === undefined)
    throw new Error("serveCustody needs a port; inline custody is inlineCustody's");
  return startRelay(port, options);
};

export const inlineCustody = async ({
  port: _port,
  openRoomStore,
  ...options
}: Custody): Promise<InlineCustody> => {
  const relay = await import("@syncmesh/relay");
  const open =
    openRoomStore ??
    relay.bunRoomStore(options.dataDir ?? ".syncmesh/relay", options.blobs !== false);
  const host = relay.createRelayHost(relay.hostTuning(options, open));
  return {
    host,
    take: (request, upgrading) => {
      if (relay.asksUpgrade(request))
        return upgrading === undefined
          ? Promise.resolve(new Response(NO_UPGRADER, { status: 426 }))
          : relay.upgradeRoom(host, request, (r, o) => upgrading.upgrade(r, o));
      if (request.method === "GET") return relay.describeRoom(host, request);
      return undefined;
    },
    websocket: relay.bunWebSocket(host),
    stop: () => host.close(),
  };
};
