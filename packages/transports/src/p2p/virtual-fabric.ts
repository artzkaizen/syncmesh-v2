import type { ByteStream, Unsubscribe } from "@syncmesh/transport";

import type { P2pFabric, P2pPeer, P2pProtocol } from "./fabric.js";

/**
 * A virtual peer-to-peer Wi-Fi: several devices that can actually find each other.
 *
 * Not a simulation of a radio. Discovery is instant and delivery is ordered, because the
 * failures worth testing here are the protocol's — who opens the path, what happens to the
 * hello, what a lost peer does to a link — and not the air's.
 *
 * The fabric enforces the one rule the real ones enforce and a fake usually forgets: **a device
 * only ever sees peers on its own protocol.** An AWDL fabric and a Wi-Fi Aware fabric on the
 * same virtual room are two rooms, exactly as two phones in one café are.
 */

export interface VirtualFabric {
  /** A fabric for one device. `hears` names the devices whose service it is reported. */
  readonly fabricFor: (name: string, protocol: P2pProtocol, hears?: readonly string[]) => P2pFabric;
  readonly settle: () => Promise<void>;
  /** The next `count` writes vanish in transit — written successfully, never delivered. */
  readonly drop: (count: number) => void;
  /** The peer walks out of range: every device that could see it is told, and paths die. */
  readonly leaves: (name: string) => void;
}

interface Device {
  readonly name: string;
  readonly protocol: P2pProtocol;
  readonly hears: ReadonlySet<string> | undefined;
  readonly found: Set<(peer: P2pPeer) => void>;
  readonly lost: Set<(id: string) => void>;
  readonly paths: Set<(stream: ByteStream, from: string) => void>;
  service: string | undefined;
  announces: Uint8Array;
  open: boolean;
}

const subscribe = <T>(set: Set<T>, cb: T): Unsubscribe => {
  set.add(cb);
  return () => void set.delete(cb);
};

export function virtualFabric(): VirtualFabric {
  const devices = new Map<string, Device>();
  let inFlight: Promise<void> = Promise.resolve();
  let dropping = 0;

  const later = (deliver: () => void): void => {
    inFlight = inFlight.then(deliver);
  };

  /** Whether `watcher` is told about `subject`: same protocol, same service, and within earshot. */
  const sees = (watcher: Device, subject: Device): boolean =>
    watcher !== subject &&
    watcher.open &&
    subject.open &&
    watcher.protocol === subject.protocol &&
    watcher.service !== undefined &&
    watcher.service === subject.service &&
    (watcher.hears === undefined || watcher.hears.has(subject.name));

  const connect = (): readonly [ByteStream, ByteStream] => {
    const data: [Set<(b: Uint8Array) => void>, Set<(b: Uint8Array) => void>] = [
      new Set(),
      new Set(),
    ];
    /** What arrived before anyone was reading; a real data path starts paused for this reason. */
    const waiting: [Uint8Array[], Uint8Array[]] = [[], []];
    const closes: [Set<() => void>, Set<() => void>] = [new Set(), new Set()];
    let closed = false;

    const shut = (): void => {
      if (closed) return;
      closed = true;
      for (const side of closes) for (const cb of new Set(side)) cb();
    };

    /**
     * A chunk arrives.
     *
     * **Anything already waiting goes first.** A chunk that arrived before there was a reader is
     * older than one that arrives after, and handing the newer one over first would deliver a
     * peer's sealed frames ahead of the hello that makes them readable — which a real data path
     * never does, and which a session cannot recover from because what it dropped is gone.
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

    const end = (mine: 0 | 1, theirs: 0 | 1): ByteStream => ({
      write: (bytes) => {
        if (closed) throw new Error("this path is closed — the bytes did not leave");
        if (dropping > 0) {
          dropping -= 1;
          return;
        }
        const copy = Uint8Array.from(bytes);
        later(() => arrive(theirs, copy));
      },
      onData: (cb) => {
        const off = subscribe(data[mine], cb);
        // on the queue, not here: delivering inside the subscribe call would reach whoever was
        // mid-construction and nobody above them
        if (waiting[mine].length > 0) later(() => drain(mine));
        return off;
      },
      onClose: (cb) => subscribe(closes[mine], cb),
      close: shut,
    });

    return [end(0, 1), end(1, 0)];
  };

  /** Tells everyone who can see this device that it is there — and it, about them. */
  const introduce = (device: Device): void => {
    later(() => {
      for (const other of devices.values()) {
        if (sees(other, device))
          for (const cb of other.found) cb({ id: device.name, announces: device.announces });
        if (sees(device, other))
          for (const cb of device.found) cb({ id: other.name, announces: other.announces });
      }
    });
  };

  return {
    fabricFor: (name, protocol, hears) => {
      const device: Device = {
        name,
        protocol,
        hears: hears === undefined ? undefined : new Set(hears),
        found: new Set(),
        lost: new Set(),
        paths: new Set(),
        service: undefined,
        announces: new Uint8Array(0),
        open: true,
      };
      devices.set(name, device);

      return {
        protocol,
        publish: (service, announced) => {
          device.service = service;
          device.announces = announced;
          introduce(device);
          return Promise.resolve();
        },
        onPeerFound: (cb) => subscribe(device.found, cb),
        onPeerLost: (cb) => subscribe(device.lost, cb),
        connect: (id) => {
          const target = devices.get(id);
          if (target === undefined || !sees(device, target))
            return Promise.reject(new Error(`${id} is not in range`));
          const [near, far] = connect();
          later(() => {
            for (const cb of target.paths) cb(far, device.name);
          });
          return Promise.resolve(near);
        },
        onPath: (cb) => subscribe(device.paths, cb),
        stop: () => {
          device.open = false;
          return Promise.resolve();
        },
      };
    },
    settle: async () => {
      for (let round = 0; round < 4; round += 1) await inFlight;
    },
    drop: (count) => void (dropping += count),
    leaves: (name) => {
      const device = devices.get(name);
      if (device === undefined) return;
      device.open = false;
      later(() => {
        for (const other of devices.values())
          if (other !== device && other.open) for (const cb of other.lost) cb(name);
      });
    },
  };
}
