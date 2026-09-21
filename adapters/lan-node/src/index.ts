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
  /**
   * The local IPv4 addresses to join the group on and send from. Default every one this machine
   * has that is not the loopback.
   *
   * **A multicast datagram has to be told which way to go.** A machine with one network card has
   * an obvious answer and the kernel picks it; a laptop has Wi-Fi, a VPN, a container bridge and
   * four virtual cards, and the kernel's answer is the default route — which on macOS is scoped,
   * so the send fails outright with `EHOSTUNREACH` and the room is silent for a reason that has
   * nothing to do with the room. Announcing on all of them costs one small datagram per card
   * every couple of seconds and removes the entire class of problem; a function, because a
   * laptop's interfaces change while the process runs.
   */
  readonly interfaces?: () => readonly string[];
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
    try: async () => ({
      dgram: await import("node:dgram"),
      net: await import("node:net"),
      os: await import("node:os"),
    }),
    catch: (cause) =>
      new LanUnsupported({
        adapter: "lan",
        message: `this runtime has no Node sockets: ${String(cause)}`,
      }),
  });
  if (loaded.isErr()) return loaded;
  const { dgram, net, os } = loaded.value;

  const group = options.group ?? DEFAULT_GROUP;
  const joins = options.multicast !== false;
  /** Every card that could carry a room: not the loopback, and IPv4 because the group is. */
  const everyCard = (): readonly string[] =>
    Object.values(os.networkInterfaces())
      .flatMap((found) => found ?? [])
      .filter((one) => one.family === "IPv4" && !one.internal)
      .map((one) => one.address);
  const cards = options.interfaces ?? everyCard;
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
  const join = (card: string | undefined): void => {
    const joined = R.try({
      try: () => radio.addMembership(group.host, card),
      catch: (cause) => String(cause),
    });
    if (joined.isErr()) drop?.(`${card ?? "this machine"} did not join the group: ${joined.error}`);
  };
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
            // per card, and each one tolerated: a virtual interface that will not carry a group
            // is an ordinary thing on a laptop, and it must not cost the socket the ones that will
            const on = cards();
            if (on.length === 0) join(undefined);
            else for (const card of on) join(card);
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

  /**
   * The group, once per card, and the seeds.
   *
   * Only a beat where **nothing** left the machine is reported. One card refusing among six is
   * the normal state of a laptop, and a line for each of them every two seconds would bury the
   * case a person actually needs to see.
   */
  const blast = (bytes: Uint8Array): void => {
    const on = joins ? cards() : [];
    let failed = 0;
    const answered = (cause: Error | null): void => {
      if (cause === null) return;
      failed += 1;
      if (failed === on.length) drop?.(`no announcement left this machine: ${cause.message}`);
    };
    for (const card of on) {
      // set immediately before the send: the option applies to the sends that follow it, and
      // the alternative is a socket per card for a datagram that repeats every two seconds anyway
      const aimed = R.try({
        try: () => radio.setMulticastInterface(card),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      if (aimed.isErr()) {
        answered(aimed.error);
        continue;
      }
      radio.send(bytes, group.port, group.host, answered);
    }
    for (const where of options.seeds?.() ?? [])
      radio.send(bytes, where.port, where.host, (cause) => {
        if (cause !== null)
          drop?.(`an announcement to ${where.host} did not leave: ${String(cause)}`);
      });
  };

  return R.ok({
    announce: blast,
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
