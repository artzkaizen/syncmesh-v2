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
const fake = () => {
  const listeners = new Map<string, (payload: never) => void>();
  const calls: { name: string; args: readonly unknown[] }[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
    };
  const manager: RnBleManager = {
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

  test("scans with duplicates off, because discovery already fires once per peer", async () => {
    const rn = fake();
    await bleRadioFrom(rn.manager).startScan({ serviceUuids: ["svc"] });
    expect(rn.calls.find((c) => c.name === "startScan")?.args[0]).toEqual({
      serviceUuids: ["svc"],
      allowDuplicates: false,
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
