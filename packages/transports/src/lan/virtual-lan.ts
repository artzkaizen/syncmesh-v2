import type { LanAddress, LanNetwork, LanStream, Unsubscribe } from "./network.js";

/**
 * A virtual local network: several devices that can actually reach each other.
 *
 * Not a simulation of a network stack. Delivery is ordered and lossless unless a test says
 * otherwise, because the failures worth testing here are the protocol's, not the wire's — what
 * this supplies is a group that carries announcements, an address that can be dialled, and a
 * stream that splits its bytes wherever it likes, which is the one thing a real TCP connection
 * is guaranteed to do and the one thing a fake usually forgets.
 *
 * `hears` is what makes a chain possible: a device only sees the announcements of the devices
 * named to it, so the outer two of three can reach each other only through the middle. A room is
 * what a pair proves; a chain is what catches a hop that quietly stops forwarding.
 */

export interface VirtualLan {
  /** A network for one device. `hears` names the devices whose announcements reach it. */
  readonly networkFor: (name: string, hears?: readonly string[]) => LanNetwork;
  /** Bytes in flight settle. */
  readonly settle: () => Promise<void>;
  /** The next `count` writes vanish in transit — written successfully, never delivered. */
  readonly drop: (count: number) => void;
}

interface Device {
  readonly name: string;
  readonly address: LanAddress;
  readonly hears: ReadonlySet<string> | undefined;
  readonly announcements: Set<(bytes: Uint8Array, from: LanAddress) => void>;
  readonly connections: Set<(stream: LanStream) => void>;
  open: boolean;
}

const subscribe = <T>(set: Set<T>, cb: T): Unsubscribe => {
  set.add(cb);
  return () => void set.delete(cb);
};

export function virtualLan(): VirtualLan {
  const devices = new Map<string, Device>();
  const byAddress = new Map<string, Device>();
  let inFlight: Promise<void> = Promise.resolve();
  let dropping = 0;
  let nextHost = 0;

  const later = (deliver: () => void): void => {
    inFlight = inFlight.then(deliver);
  };
  const key = (address: LanAddress) => `${address.host}:${address.port}`;

  /**
   * Two ends of one connection. Bytes are handed over in the chunks they were written in, which
   * is generous: a real stream may split or join them, and {@link framed} is what makes that
   * the same protocol either way.
   */
  const connect = (): readonly [LanStream, LanStream] => {
    const data: [Set<(b: Uint8Array) => void>, Set<(b: Uint8Array) => void>] = [
      new Set(),
      new Set(),
    ];
    /**
     * What arrived before anyone was reading. Accepting a connection and attaching a reader
     * cannot be one step, and the peer's hello is already on its way — a real socket starts
     * paused for exactly this reason.
     */
    const waiting: [Uint8Array[], Uint8Array[]] = [[], []];
    const closes: [Set<() => void>, Set<() => void>] = [new Set(), new Set()];
    let closed = false;

    const shut = (): void => {
      if (closed) return;
      closed = true;
      // both ends of a connection see it end; only one of them asked
      for (const side of closes) for (const cb of new Set(side)) cb();
    };

    /**
     * A chunk arrives.
     *
     * **Anything already waiting goes first.** A chunk that arrived before there was a reader is
     * older than one that arrives after, and handing the newer one over first would deliver a
     * peer's sealed frames ahead of the hello that makes them readable — which a real socket
     * never does, and which a session cannot recover from because the frames it dropped are
     * already gone.
     */
    const arrive = (side: 0 | 1, chunk: Uint8Array): void => {
      if (data[side].size === 0 || waiting[side].length > 0) return void waiting[side].push(chunk);
      for (const cb of data[side]) cb(chunk);
    };

    const drain = (side: 0 | 1): void => {
      while (waiting[side].length > 0 && data[side].size > 0) {
        const chunk = waiting[side].shift();
        if (chunk === undefined) return;
        for (const cb of data[side]) cb(chunk);
      }
    };

    const end = (mine: 0 | 1, theirs: 0 | 1): LanStream => ({
      write: (bytes) => {
        if (closed) throw new Error("this connection is closed — the bytes did not leave");
        if (dropping > 0) {
          dropping -= 1;
          return;
        }
        const copy = Uint8Array.from(bytes);
        later(() => arrive(theirs, copy));
      },
      onData: (cb) => {
        const off = subscribe(data[mine], cb);
        // on the queue, not here: a socket hands bytes over on a later tick, and delivering them
        // inside the subscribe call would reach whoever was mid-construction and nobody above them
        if (waiting[mine].length > 0) later(() => drain(mine));
        return off;
      },
      onClose: (cb) => subscribe(closes[mine], cb),
      close: shut,
    });

    return [end(0, 1), end(1, 0)];
  };

  return {
    networkFor: (name, hears) => {
      nextHost += 1;
      const device: Device = {
        name,
        address: { host: `10.0.0.${nextHost}`, port: 47_100 + nextHost },
        hears: hears === undefined ? undefined : new Set(hears),
        announcements: new Set(),
        connections: new Set(),
        open: true,
      };
      devices.set(name, device);
      byAddress.set(key(device.address), device);

      return {
        announce: (bytes) => {
          if (!device.open) throw new Error(`${name} has closed its network`);
          const copy = Uint8Array.from(bytes);
          later(() => {
            for (const other of devices.values()) {
              if (other === device || !other.open) continue;
              if (other.hears !== undefined && !other.hears.has(name)) continue;
              for (const cb of other.announcements) cb(copy, device.address);
            }
          });
        },
        onAnnouncement: (cb) => subscribe(device.announcements, cb),
        address: () => device.address,
        dial: (to) => {
          const target = byAddress.get(key(to));
          if (target === undefined || !target.open)
            return Promise.reject(new Error(`nothing is listening on ${key(to)}`));
          const [near, far] = connect();
          // the accept happens on the far device, after the dial returns, as it does for real
          later(() => {
            for (const cb of target.connections) cb(far);
          });
          return Promise.resolve(near);
        },
        onConnection: (cb) => subscribe(device.connections, cb),
        close: () => {
          device.open = false;
          return Promise.resolve();
        },
      };
    },
    settle: async () => {
      // a delivery can queue the next one, so settling is draining until nothing new is chained
      for (let round = 0; round < 4; round += 1) await inFlight;
    },
    drop: (count) => void (dropping += count),
  };
}
