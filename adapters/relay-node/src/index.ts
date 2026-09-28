import type {
  RelayHost,
  RelaySocket,
  RoomStore,
  RunningRelay,
  SendOutcome,
  SocketSession,
  StartRelayOptions,
} from "@syncmesh/relay";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";

import { createRelayHost, durableRoomStore, hostTuning, roomOf } from "@syncmesh/relay";
import { panic } from "@syncmesh/result";
import { defaultStore } from "@syncmesh/sqlite-node";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

/**
 * D09-A on Node: the same host `startRelay` mounts over `Bun.serve`, over `node:http` and `ws`.
 *
 * Nothing of the room is here. `createRelayHost` owns the rooms, the posture gate, the socket
 * sessions and the connection ceiling; this file turns Node's upgrade event into the gate's
 * `Request`, and a `ws` socket into the `RelaySocket` a room drives. Bun's mount is the same
 * sixty lines against Bun's socket, which is what D09 meant by "hosts, not rewrites".
 */

/**
 * How much `ws` may hold for one socket before a send counts as dropped.
 *
 * `ws` never refuses a send: everything the kernel will not take at once is queued in the
 * library's own buffer, without limit. Left alone, that is a relay assuming it can outrun a
 * client (RFC-0010's rule), with the backlog growing where the room cannot see it. Past this
 * mark a send is reported `dropped`, the room's own sender queues it, and at the room's ceiling
 * the socket is closed rather than the process growing — the same outcome Bun's `-1`/`0` gives.
 */
export const HIGH_WATER_BYTES = 4 * 1024 * 1024;

/** The Node log opener: one SQLite file per room under `dataDir`, epoch persisted with the log. */
export const nodeRoomStore =
  (dataDir: string, serveBlobs = true) =>
  async (name: string): Promise<RoomStore> => {
    const stores = (await defaultStore({ name: `relay-${name}`, dir: dataDir })).match({
      ok: (value) => value,
      err: (failure) => panic(`the relay's log failed to open: ${failure.message}`),
    });
    return durableRoomStore(stores, { blobs: serveBlobs });
  };

/**
 * Node's upgrade request as the `Request` the posture gate reads: the URL, the `Origin`, the
 * cookies and whatever else `verifyJoin` looks at. Only the head — there is no body on an upgrade.
 */
export const requestOf = (message: IncomingMessage): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const each of value) headers.append(name, each);
    else headers.set(name, value);
  }
  const host = message.headers.host ?? "localhost";
  return new Request(`http://${host}${message.url ?? "/"}`, { headers });
};

/** A refusal written straight onto the raw socket, which is all there is before an upgrade. */
const refuse = async (socket: Duplex, refused: Response): Promise<void> => {
  const body = await refused.text();
  socket.write(
    `HTTP/1.1 ${String(refused.status)} ${refused.statusText || "Refused"}\r\n` +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
      "Connection: close\r\n\r\n" +
      body,
  );
  socket.destroy();
};

/** Whatever `ws` hands a message listener, as the one shape a room reads. */
const bytesOf = (data: Buffer | ArrayBuffer | Buffer[]): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};

/** One accepted `ws` socket bound to its room: frames in, backpressure out, exactly one close. */
const bind = (host: RelayHost, ws: WebSocket, room: string): SocketSession => {
  let session: SocketSession | undefined;
  const socket: RelaySocket = {
    send: (frame): SendOutcome => {
      if (ws.readyState !== ws.OPEN) return "dropped";
      if (ws.bufferedAmount > HIGH_WATER_BYTES) return "dropped";
      // the callback is `ws`'s only word that a frame left: it is the drain the room flushes on
      ws.send(frame, { binary: true }, () => session?.drain());
      return ws.bufferedAmount > 0 ? "buffered" : "sent";
    },
    close: (reason) => ws.close(1000, reason),
  };
  session = host.accept(socket, room);
  ws.on("message", (data, isBinary) => {
    // the protocol is binary; a text frame is noise
    if (!isBinary) return;
    session?.receive(bytesOf(data));
  });
  ws.on("close", () => session?.closed());
  return session;
};

/**
 * Mounts a relay host on an `http.Server` you already run: every upgrade on it is gated and, if
 * admitted, becomes a socket on the room its path names. Plain requests are untouched, so the
 * server keeps answering whatever it answered before.
 *
 * @example
 * const server = createServer(app);
 * attachRelay(server, createRelayHost({ openRoomStore: nodeRoomStore(".syncmesh/relay") }));
 * server.listen(5241);
 */
export function attachRelay(server: Server, host: RelayHost): () => void {
  const sockets = new WebSocketServer({ noServer: true });
  const onUpgrade = (message: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void (async () => {
      const request = requestOf(message);
      const room = host.roomFor(roomOf(request));
      // refused before a socket exists: a client the posture turns away costs the room nothing
      const refused = await host.gate(request, room);
      if (refused !== undefined) return refuse(socket, refused);
      sockets.handleUpgrade(message, socket, head, (ws) => void bind(host, ws, room));
    })();
  };
  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    for (const ws of sockets.clients) ws.close(1001, "the relay is stopping");
    sockets.close();
  };
}

/**
 * D09-A: the embedded host on Node — the relay in the process you already run, one durable
 * SQLite log per room under `dataDir`. Port 0 picks a free port. The same options and the same
 * answer as `@syncmesh/relay`'s `startRelay`; the runtime is the only difference.
 */
export async function startRelay(
  port: number,
  options: StartRelayOptions = {},
): Promise<RunningRelay> {
  const dataDir = options.dataDir ?? ".syncmesh/relay";
  const host = createRelayHost(
    hostTuning(options, nodeRoomStore(dataDir, options.blobs !== false)),
  );
  const server = createServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain", upgrade: "websocket" });
    response.end("syncmesh relay: WebSocket only");
  });
  const detach = attachRelay(server, host);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  // SAFETY: `listen(port)` binds a TCP port, and a TCP server's address is an `AddressInfo`,
  // never the path string a pipe would answer with
  const { port: boundPort } = server.address() as AddressInfo;
  return {
    port: boundPort,
    url: `ws://localhost:${String(boundPort)}`,
    peerId: host.peerId,
    stop: async () => {
      detach();
      await host.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
