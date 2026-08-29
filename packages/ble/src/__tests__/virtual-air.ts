import type {
  BleAdvertisement,
  BleRadio,
  BleSubscribers,
  BleValueChanged,
  BleWriteRequested,
} from "../radio.js";

/**
 * A virtual air: several radios that can actually hear each other.
 *
 * The fakes elsewhere in this package are one device with a test driving both sides of it. This
 * is the medium itself — advertisements reach every scanner on it, a dial reaches the device that
 * advertised, a write lands on that device as a write request, and a notification comes back to
 * whoever subscribed. That is enough for a real `bleTransport` to run against another real
 * `bleTransport`, which is the only way the dial rule, the fragmenting and the session handshake
 * are exercised together.
 *
 * Not a simulation of radio physics. Delivery is ordered and lossless unless a test says
 * otherwise, because the failures worth testing here are the protocol's, not the air's.
 */

/** What a device is putting in the air, or `undefined` when it is silent. */
interface Advertising {
  readonly localName?: string;
  readonly serviceDataBase64?: Readonly<Record<string, string>>;
}

interface Endpoint {
  readonly id: string;
  advertising: Advertising | undefined;
  scanning: boolean;
  readonly onScan: Set<(e: BleAdvertisement) => void>;
  readonly onValue: Set<(e: BleValueChanged) => void>;
  readonly onWrite: Set<(e: BleWriteRequested) => void>;
  readonly onSubscribers: Set<(e: BleSubscribers) => void>;
  readonly onConnection: Set<(e: { connectionId: string; state: string }) => void>;
  /** Centrals subscribed to this device's characteristic, by the connection they dialled on. */
  readonly subscribers: Set<string>;
}

/** One dialled connection: who dialled, who answered, and the id the dialler knows it by. */
interface Wire {
  readonly connectionId: string;
  readonly central: string;
  readonly peripheral: string;
}

export interface VirtualAir {
  /** A radio for one device; `reachable` limits who it can hear, for a chain rather than a room. */
  readonly radioFor: (id: string, reachable?: readonly string[]) => BleRadio;
  /** Everything queued has been delivered and every fold has settled. */
  readonly settle: () => Promise<void>;
  /** The next `count` packets vanish after a successful send — a radio, not a socket. */
  readonly drop: (count: number) => void;
  readonly connections: () => number;
}

export function virtualAir(mtu = 185): VirtualAir {
  const endpoints = new Map<string, Endpoint>();
  const reach = new Map<string, readonly string[] | undefined>();
  const wires: Wire[] = [];
  let inFlight: Promise<void> = Promise.resolve();
  let dropping = 0;

  const endpoint = (id: string): Endpoint => {
    const held = endpoints.get(id);
    if (held !== undefined) return held;
    const fresh: Endpoint = {
      id,
      advertising: undefined,
      scanning: false,
      onScan: new Set(),
      onValue: new Set(),
      onWrite: new Set(),
      onSubscribers: new Set(),
      onConnection: new Set(),
      subscribers: new Set(),
    };
    endpoints.set(id, fresh);
    return fresh;
  };

  const hears = (listener: string, speaker: string): boolean => {
    if (listener === speaker) return false;
    const only = reach.get(listener);
    return only === undefined || only.includes(speaker);
  };

  /** Delivery is a turn later, as a radio's is; a packet that "left" has not arrived yet. */
  const later = (deliver: () => void): void => {
    if (dropping > 0) {
      dropping -= 1;
      return;
    }
    inFlight = inFlight.then(() => deliver());
  };

  const broadcast = (from: Endpoint): void => {
    if (from.advertising === undefined) return;
    for (const to of endpoints.values()) {
      if (!to.scanning || !hears(to.id, from.id)) continue;
      const advert: BleAdvertisement = { peripheralId: from.id, ...from.advertising };
      later(() => to.onScan.forEach((cb) => cb(advert)));
    }
  };

  const sub = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => void set.delete(cb);
  };

  return {
    connections: () => wires.length,
    drop: (count) => void (dropping = count),
    settle: async () => {
      for (let round = 0; round < 12; round += 1) {
        await inFlight;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    radioFor: (id, reachable) => {
      reach.set(id, reachable);
      const self = endpoint(id);
      return {
        startAdvertising: (options) => {
          const advert: Advertising = {};
          if (options.localName !== undefined)
            Object.assign(advert, { localName: options.localName });
          if (options.serviceDataBase64 !== undefined)
            Object.assign(advert, { serviceDataBase64: options.serviceDataBase64 });
          self.advertising = advert;
          broadcast(self);
          return Promise.resolve();
        },
        stopAdvertising: () => {
          self.advertising = undefined;
          return Promise.resolve();
        },
        publishServices: () => Promise.resolve(),
        unpublishServices: () => Promise.resolve(),
        startScan: () => {
          self.scanning = true;
          // whatever is already in the air, not only what is advertised from now on
          for (const other of endpoints.values()) if (hears(id, other.id)) broadcast(other);
          return Promise.resolve();
        },
        stopScan: () => {
          self.scanning = false;
          return Promise.resolve();
        },
        connect: (peripheralId) => {
          const connectionId = `${id}->${peripheralId}#${wires.length}`;
          wires.push({ connectionId, central: id, peripheral: peripheralId });
          const target = endpoint(peripheralId);
          later(() =>
            target.onConnection.forEach((cb) => cb({ connectionId, state: "connected" })),
          );
          return Promise.resolve({ connectionId, mtu });
        },
        disconnect: (connectionId) => {
          const at = wires.findIndex((w) => w.connectionId === connectionId);
          if (at >= 0) wires.splice(at, 1);
          return Promise.resolve();
        },
        discoverServices: () => Promise.resolve(),
        subscribe: (connectionId) => {
          const wire = wires.find((w) => w.connectionId === connectionId);
          if (wire === undefined) return Promise.reject(new Error("no such connection"));
          const target = endpoint(wire.peripheral);
          target.subscribers.add(connectionId);
          const event: BleSubscribers = {
            characteristicUuid: "",
            centralIds: [wire.central],
            maximumUpdateValueLength: mtu - 3,
          };
          later(() => target.onSubscribers.forEach((cb) => cb(event)));
          return Promise.resolve();
        },
        requestMtu: (_connectionId, asked) => Promise.resolve(Math.min(asked, mtu)),
        write: (connectionId, _service, characteristicUuid, valueBase64) => {
          const wire = wires.find((w) => w.connectionId === connectionId);
          if (wire === undefined) return Promise.reject(new Error("no such connection"));
          const target = endpoint(wire.peripheral);
          // the dialled end is told which central wrote, which is how it names the peer
          const event: BleWriteRequested = {
            characteristicUuid,
            valueBase64,
            centralId: wire.central,
          };
          later(() => target.onWrite.forEach((cb) => cb(event)));
          return Promise.resolve();
        },
        setCharacteristicValue: (_service, characteristicUuid, valueBase64) => {
          // a notification goes to every central subscribed to *this* device
          for (const connectionId of self.subscribers) {
            const wire = wires.find((w) => w.connectionId === connectionId);
            if (wire === undefined) continue;
            const central = endpoint(wire.central);
            const event: BleValueChanged = { connectionId, characteristicUuid, valueBase64 };
            later(() => central.onValue.forEach((cb) => cb(event)));
          }
          return Promise.resolve();
        },
        onScanResult: (cb) => sub(self.onScan, cb),
        onConnectionStateChanged: (cb) => sub(self.onConnection, cb),
        onCharacteristicValueChanged: (cb) => sub(self.onValue, cb),
        onCharacteristicWriteRequested: (cb) => sub(self.onWrite, cb),
        onSubscribersChanged: (cb) => sub(self.onSubscribers, cb),
      };
    },
  };
}
