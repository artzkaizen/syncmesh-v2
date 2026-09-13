import type { Result } from "@syncmesh/result";
import type { Unsubscribe } from "@syncmesh/transport";
import type { LanAddress, LanNetwork, LanStream } from "@syncmesh/transports";
import type { AddressInfo, Socket } from "node:net";

import { Result as R } from "@syncmesh/result";
import { DEFAULT_GROUP, LanUnavailable, LanUnsupported } from "@syncmesh/transports";

/**
 * The `LanNetwork` a machine with Node's sockets can supply: `dgram` for the group, `net` for
 * the links.
 *
 * An adapter rather than part of `@syncmesh/transports` because `packages/*` are runtime-neutral
 * (D01-B): the transport is proven against a virtual network and knows nothing about sockets,
 * and this is the one place that does. A platform with other sockets — React Native, a Worker,
 * a runtime that is not Node — writes another of these and the transport does not change.
 */

export interface NodeLanOptions {
  /** The multicast group announcements go to. Default {@link DEFAULT_GROUP}. */
  readonly group?: LanAddress;
  /** The port links are accepted on. Default 0: whatever the machine has free, announced as itself. */
  readonly port?: number;
  /** The interface links are accepted on. Default every one, which is what a room wants. */
  readonly host?: string;
  /**
   * Whether to join the multicast group at all. Many managed access points drop multicast
   * between clients, and on those networks the group is silence rather than an error — `seeds`
   * is the way through, and turning this off says so out loud instead of announcing into a hole.
   */
  readonly multicast?: boolean;
  /**
   * Addresses to announce to directly, as well as (or instead of) the group. A function because
   * the list is configuration, and configuration changes while the process runs.
   */
  readonly seeds?: () => readonly LanAddress[];
  /** The port announcements are received on. Default the group's, which is what multicast needs. */
  readonly discoveryPort?: number;
  /** A socket that failed after it was open, for a log a person reads on a machine. */
  readonly onDropped?: (why: string) => void;
}

/**
 * The network, plus where its announcements arrive.
 *
 * The transport never asks: it announces and it dials, and where *this* device listens for
 * announcements is nobody else's business on a multicast group, where the group's port is the
 * answer for everyone. It is somebody's business on the `seeds` path — a device that must be
 * announced at directly has to be able to say where, which is what this is for.
 */
export interface NodeLanNetwork extends LanNetwork {
  readonly discoveryAddress: () => LanAddress;
}

const subscribe = <T>(set: Set<T>, cb: T): Unsubscribe => {
  set.add(cb);
  return () => void set.delete(cb);
};

/**
 * One accepted or dialled socket as a {@link LanStream}.
 *
 * A Node socket is paused until something reads it, which is what the port requires: the peer's
 * hello is already in flight when the connection is accepted, and a stream that dropped it would
 * refuse everything after it for the life of the link.
 */
const streamOf = (socket: Socket, onDropped?: (why: string) => void): LanStream => {
  const closes = new Set<() => void>();
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const cb of new Set(closes)) cb();
  };
  socket.on("close", end);
  socket.on("error", (cause) => {
    onDropped?.(`the link to ${socket.remoteAddress ?? "a peer"} failed: ${String(cause)}`);
    socket.destroy();
  });

  return {
    write: (bytes) => {
      // a closed socket is a frame that did not leave, and saying so is what makes it recoverable
      if (ended || socket.destroyed || !socket.writable)
        throw new LanUnavailable({
          message: "this connection is closed — the bytes did not leave",
        });
      socket.write(bytes);
    },
    onData: (cb) => {
      const listener = (chunk: Buffer): void => cb(new Uint8Array(chunk));
      socket.on("data", listener);
      return () => void socket.off("data", listener);
    },
    onClose: (cb) => subscribe(closes, cb),
    close: () => socket.destroy(),
  };
};

/**
 * Opens the sockets and hands back the network, or says which piece this machine does not have.
 *
 * Failure is a value because every one of these is an ordinary condition on a real machine: no
 * interface up, a port already taken, a group this network will not carry.
 */
export async function nodeLan(
  options: NodeLanOptions = {},
): Promise<Result<NodeLanNetwork, LanUnavailable | LanUnsupported>> {
  const loaded = await R.tryPromise({
    try: async () => ({ dgram: await import("node:dgram"), net: await import("node:net") }),
    catch: (cause) =>
      new LanUnsupported({
        adapter: "lan",
        message: `this runtime has no Node sockets: ${String(cause)}`,
      }),
  });
  if (loaded.isErr()) return loaded;
  const { dgram, net } = loaded.value;

  const group = options.group ?? DEFAULT_GROUP;
  const joins = options.multicast !== false;
  const announcements = new Set<(bytes: Uint8Array, from: LanAddress) => void>();
  const connections = new Set<(stream: LanStream) => void>();
  const drop = options.onDropped;

  const server = net.createServer();
  server.on("connection", (socket) => {
    const stream = streamOf(socket, drop);
    for (const cb of connections) cb(stream);
  });
  server.on("error", (cause) => drop?.(`the listener failed: ${String(cause)}`));

  const listening = await R.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, options.host, () => {
          // SAFETY: this server was listened on a TCP port; the `string` in `address()`'s
          // signature is the unix-socket-path case, which cannot arise from the call above
          const bound = server.address() as AddressInfo | null;
          if (bound === null) return reject(new Error("the listener bound to no port"));
          resolve(bound.port);
        });
      }),
    catch: (cause) =>
      new LanUnavailable({ message: `nothing could be listened on: ${String(cause)}` }),
  });
  if (listening.isErr()) {
    server.close();
    return listening;
  }
  const port = listening.value;

  const radio = dgram.createSocket({ type: "udp4", reuseAddr: true });
  radio.on("message", (bytes, from) => {
    for (const cb of announcements)
      cb(new Uint8Array(bytes), { host: from.address, port: from.port });
  });
  radio.on("error", (cause) => drop?.(`the discovery socket failed: ${String(cause)}`));

  const bound = await R.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        radio.once("error", reject);
        radio.bind(options.discoveryPort ?? (joins ? group.port : 0), () => {
          if (joins) {
            radio.addMembership(group.host);
            // our own announcement comes back, and the transport discards it by peer id — but
            // a device alone in a room is the one that most needs to know its socket works
            radio.setMulticastLoopback(true);
          }
          resolve();
        });
      }),
    catch: (cause) =>
      new LanUnavailable({ message: `the discovery socket could not open: ${String(cause)}` }),
  });
  if (bound.isErr()) {
    server.close();
    radio.close();
    return bound;
  }
  radio.unref(); // discovery is not a reason for a process to stay alive
  // SAFETY: a bound udp4 socket always reports an address; the call above resolved on its bind
  const discovery = radio.address() as { address: string; port: number };

  return R.ok({
    announce: (bytes) => {
      const to = [...(joins ? [group] : []), ...(options.seeds?.() ?? [])];
      for (const where of to)
        radio.send(bytes, where.port, where.host, (cause) => {
          if (cause !== null) drop?.(`an announcement did not leave: ${String(cause)}`);
        });
    },
    onAnnouncement: (cb) => subscribe(announcements, cb),
    address: () => ({ host: options.host ?? "0.0.0.0", port }),
    dial: (to) =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: to.host, port: to.port });
        socket.once("error", reject); // before `connect`, a failure is this dial's failure
        socket.once("connect", () => {
          socket.off("error", reject);
          resolve(streamOf(socket, drop));
        });
      }),
    onConnection: (cb) => subscribe(connections, cb),
    discoveryAddress: () => ({ host: options.host ?? discovery.address, port: discovery.port }),
    close: () =>
      new Promise((resolve) => {
        radio.close();
        server.close(() => resolve());
      }),
  });
}
