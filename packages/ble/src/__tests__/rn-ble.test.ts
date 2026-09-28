import { describe, expect, test } from "bun:test";

import type { BleAdvertisement } from "../radio.js";
import type { RnBleManager } from "../rn-ble.js";

/**
 * The rn-ble event payloads this fake emits, in rn-ble's own shape rather than the port's. A
 * union rather than a dictionary, so a test that writes the *port's* shape by mistake — which is
 * precisely the bug this file exists to catch — fails to compile instead of passing.
 */
type RnEventPayload =
  | {
      readonly peripheralId: string;
      readonly name?: string;
      readonly rssi?: number;
      readonly discoveredAt?: number;
      readonly advertisement?: {
        readonly localName?: string;
        readonly serviceUuids?: readonly string[];
        readonly serviceDataBase64?: Readonly<Record<string, string>>;
      };
    }
  | { readonly connectionId: string; readonly state: string }
  | {
      readonly connectionId: string;
      readonly characteristicUuid: string;
      readonly valueBase64: string;
    };

import { hintOf } from "../advert.js";
import { bleRadioFrom } from "../rn-ble.js";

/**
 * A stand-in for `@syncmesh/rn-ble`, shaped like the real one rather than like the port.
 *
 * That is the whole point: the two interfaces are close enough to look interchangeable and are
 * not, and every difference between them is a silent failure rather than a type error, because
 * the module is loaded at runtime on a device.
 */
const fake = (state = "poweredOn") => {
  const listeners = new Map<string, (payload: never) => void>();
  let adapter = state;
  const calls: { name: string; args: readonly unknown[] }[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
    };
  const manager: RnBleManager = {
    getState: async () => adapter,
    startAdvertising: record("startAdvertising"),
    stopAdvertising: record("stopAdvertising"),
    publishServices: record("publishServices"),
    unpublishServices: record("unpublishServices"),
    startScan: record("startScan"),
    stopScan: record("stopScan"),
    connect: async (peripheralId) => {
      calls.push({ name: "connect", args: [peripheralId] });
      return { connectionId: `conn-${peripheralId}`, peripheralId, mtu: 185, state: "connected" };
    },
    disconnect: record("disconnect"),
    discoverServices: async (connectionId) => {
      calls.push({ name: "discoverServices", args: [connectionId] });
      return { services: [] };
    },
    subscribe: async (...args) => {
      calls.push({ name: "subscribe", args });
      return "notify" as const;
    },
    write: record("write"),
    setCharacteristicValue: record("setCharacteristicValue"),
    requestMtu: async (connectionId, mtu) => {
      calls.push({ name: "requestMtu", args: [connectionId, mtu] });
      return 512;
    },
    addListener: (event, listener) => {
      listeners.set(event, listener);
      return { remove: () => void listeners.delete(event) };
    },
  };
  return {
    manager,
    calls,
    listening: () => [...listeners.keys()],
    /** The adapter settling, as CoreBluetooth reports it a moment after the managers are built. */
    settle: (next: string) => {
      adapter = next;
      const listener = listeners.get("onStateChanged");
      // SAFETY: the fake stores rn-ble's listener under its event name and hands it that event's
      // own payload, which is exactly the contract `never` stands in for on the real module
      listener?.({ state: next } as never);
    },
    /** Fires an event with rn-ble's own payload shape, not the port's. */
    emit: (event: string, payload: RnEventPayload) => {
      const listener = listeners.get(event);
      // SAFETY: the fake stores rn-ble's listener under its event name and hands it that event's
      // own payload, which is exactly the contract `never` stands in for on the real module
      listener?.(payload as never);
    },
  };
};

describe("rn-ble as a BleRadio", () => {
  test("flattens the advertisement, which is the difference the whole adapter exists for", () => {
    const rn = fake();
    const radio = bleRadioFrom(rn.manager);
    const seen: BleAdvertisement[] = [];
    radio.onScanResult((advert) => void seen.push(advert));

    // rn-ble's real shape: the fields the mesh reads sit one level down
    rn.emit("onScanResult", {
      peripheralId: "phone-b",
      name: "Someone's iPhone",
      rssi: -54,
      discoveredAt: 1,
      advertisement: { localName: "a1b2c3d4", serviceUuids: ["svc"] },
    });

    // read unflattened this is `undefined`, the hint is unreadable, and no peer is ever dialled
    expect(seen[0]?.localName).toBe("a1b2c3d4");
    expect(seen[0]?.peripheralId).toBe("phone-b");
  });

  test("a peer id's hint survives the round trip, which is what discovery compares", () => {
    const rn = fake();
    const radio = bleRadioFrom(rn.manager);
    const hint = hintOf(
      // SAFETY: a 64-character lowercase hex string is what a peer id is
      "c".repeat(64) as Parameters<typeof hintOf>[0],
    );
    let saw: string | undefined;
    radio.onScanResult((advert) => void (saw = advert.localName));
    rn.emit("onScanResult", { peripheralId: "p", advertisement: { localName: hint } });
    expect(saw).toBe(hint);
  });

  test("an advertisement with nothing in it is not an error, it is a peer we cannot name", () => {
    const rn = fake();
    const radio = bleRadioFrom(rn.manager);
    const seen: BleAdvertisement[] = [];
    radio.onScanResult((advert) => void seen.push(advert));
    rn.emit("onScanResult", { peripheralId: "headphones" });
    expect(seen[0]).toEqual({ peripheralId: "headphones" });
  });

  test("supplies the characteristic properties the mesh needs, which the port does not name", async () => {
    const rn = fake();
    await bleRadioFrom(rn.manager).publishServices({
      services: [{ uuid: "svc", characteristics: [{ uuid: "chr" }] }],
    });
    const spec = rn.calls.find((c) => c.name === "publishServices")?.args[0];
    expect(spec).toEqual({
      services: [
        {
          uuid: "svc",
          characteristics: [
            {
              uuid: "chr",
              // written to by whoever dialled, notified from by whoever was dialled into
              properties: ["write", "writeWithoutResponse", "notify"],
              permissions: ["writeable"],
            },
          ],
        },
      ],
    });
  });

  test("turns a subscription object into the unsubscribe function the port takes", () => {
    const rn = fake();
    const radio = bleRadioFrom(rn.manager);
    const off = radio.onCharacteristicValueChanged(() => undefined);
    expect(rn.listening()).toEqual(["onCharacteristicValueChanged"]);
    off();
    expect(rn.listening()).toEqual([]);
  });

  /**
   * **This test used to assert the opposite, and that is the bug it now guards.**
   *
   * Core Bluetooth reports each peripheral once per scan session unless duplicates are asked
   * for, and `bleTransport` recovers a dropped link by waiting for the peer's next
   * advertisement — `seen.forget(hint)` on close exists to make the next sighting count, and the
   * dial backoff is a wait for a later one. Off, the first drop is permanent: the radio says
   * `ok`, reaches nobody, and two phones in a room never find each other again.
   *
   * `discovery()` firing once per peer is what makes duplicates cheap, not what makes them
   * unnecessary — a sighting inside its TTL never reaches a dial.
   */
  test("scans with duplicates on, because a dropped link recovers on the next sighting", async () => {
    const rn = fake();
    await bleRadioFrom(rn.manager).startScan({ serviceUuids: ["svc"] });
    expect(rn.calls.find((c) => c.name === "startScan")?.args[0]).toEqual({
      allowDuplicates: true,
      serviceUuids: ["svc"],
    });
  });

  test("the negotiated MTU is what comes back, never what was asked for", async () => {
    const radio = bleRadioFrom(fake().manager);
    expect(await radio.requestMtu?.("conn", 517)).toBe(512);
  });

  test("a platform with no MTU exchange declares none rather than echoing the request", () => {
    const rn = fake();
    const { requestMtu: _gone, ...without } = rn.manager;
    expect(bleRadioFrom(without).requestMtu).toBeUndefined();
  });
});

/**
 * The window between constructing a manager and CoreBluetooth answering with a real state.
 *
 * Worth a test because the failure is a race and reads like a hardware fault: publishing in that
 * window rejects with `RNBleNotPoweredOnException: state=unknown`, which sounds like "this phone
 * has no Bluetooth" and is actually "ask again in ten milliseconds". It was found on a real phone,
 * where the transport published the instant it started and lost the race every time.
 */
describe("an adapter that has not reported its state yet", () => {
  test("holds the call until the radio is on, rather than refusing", async () => {
    const rn = fake("unknown");
    const radio = bleRadioFrom(rn.manager);

    const publishing = radio.publishServices({
      services: [{ uuid: "1234", characteristics: [{ uuid: "5678" }] }],
    });
    // nothing may reach the module while the adapter is still starting up
    await Promise.resolve();
    expect(rn.calls.map((call) => call.name)).not.toContain("publishServices");

    rn.settle("poweredOn");
    await publishing;
    expect(rn.calls.map((call) => call.name)).toContain("publishServices");
  });

  test("stops waiting on a state that will never become poweredOn, and lets the module refuse", async () => {
    const rn = fake("unknown");
    const radio = bleRadioFrom(rn.manager);

    const scanning = radio.startScan({ serviceUuids: ["1234"] });
    rn.settle("unsupported");
    await scanning;
    // `unsupported` is an answer, not a wait: the call goes through and the module raises the
    // refusal a caller can act on, which is what a simulator with no radio should produce
    expect(rn.calls.map((call) => call.name)).toContain("startScan");
  });
});
