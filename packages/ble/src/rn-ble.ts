import type { BleAdvertisement, BleConnected, BleRadio } from "./radio.js";

/**
 * `@syncmesh/rn-ble` as a {@link BleRadio}.
 *
 * The two interfaces are close but not the same, and the differences are all real. Typed
 * structurally rather than against the package, so this stays a pure module with no React Native
 * import in it — the mesh does not depend on a native module to be tested.
 *
 * What the translation actually does:
 *
 * - **Flattens the advertisement.** `rn-ble` nests `localName` and `serviceDataBase64` under
 *   `advertisement`; `BleRadio` reads them at the top. Left unflattened the hint is `undefined`
 *   on every scan result and **no peer is ever discovered** — the failure is total and silent.
 * - **Supplies the characteristic's properties.** `BleRadio.publishServices` names a uuid and
 *   nothing else, because the mesh only ever wants one shape: written to by whoever dialled,
 *   notified from by whoever was dialled into.
 * - **Turns subscriptions into unsubscribe functions.** `rn-ble` returns an object with
 *   `remove()`; the port takes the function.
 */

/** One `rn-ble` event subscription, which is an object rather than the function the port wants. */
interface Subscription {
  readonly remove: () => void;
}

/** Exactly what this adapter touches, and nothing else — a structural subset of `BleManager`. */
export interface RnBleManager {
  readonly startAdvertising: (options: {
    readonly serviceUuids: readonly string[];
    readonly localName?: string;
    readonly serviceDataBase64?: Readonly<Record<string, string>>;
  }) => Promise<void>;
  readonly stopAdvertising: () => Promise<void>;
  readonly publishServices: (spec: {
    readonly services: readonly {
      readonly uuid: string;
      readonly characteristics: readonly {
        readonly uuid: string;
        readonly properties: readonly string[];
        readonly permissions?: readonly string[];
      }[];
    }[];
  }) => Promise<void>;
  readonly unpublishServices: () => Promise<void>;
  readonly startScan: (options?: {
    readonly serviceUuids?: readonly string[];
    readonly allowDuplicates?: boolean;
  }) => Promise<void>;
  readonly stopScan: () => Promise<void>;
  readonly connect: (peripheralId: string) => Promise<{
    readonly connectionId: string;
    readonly mtu?: number;
  }>;
  readonly disconnect: (connectionId: string) => Promise<void>;
  readonly discoverServices: (connectionId: string) => Promise<{ readonly services: unknown }>;
  readonly subscribe: (
    connectionId: string,
    serviceUuid: string,
    characteristicUuid: string,
  ) => Promise<"notify" | "indicate">;
  readonly write: (
    connectionId: string,
    serviceUuid: string,
    characteristicUuid: string,
    valueBase64: string,
    writeType?: "withResponse" | "withoutResponse",
  ) => Promise<void>;
  readonly setCharacteristicValue: (
    serviceUuid: string,
    characteristicUuid: string,
    valueBase64: string,
    notifySubscribers?: boolean,
  ) => Promise<void>;
  readonly requestMtu?: (connectionId: string, mtu: number) => Promise<number>;
  readonly addListener: (event: string, listener: (payload: never) => void) => Subscription;
}

/** What the mesh needs of a characteristic: the dialler writes to it, the dialled notifies from it. */
const CHARACTERISTIC = {
  properties: ["write", "writeWithoutResponse", "notify"],
  permissions: ["writeable"],
} as const;

/** `rn-ble`'s scan result, whose advertisement fields sit one level down from where the port reads. */
interface RnScanResult {
  readonly peripheralId: string;
  readonly advertisement?: {
    readonly localName?: string;
    readonly serviceDataBase64?: Readonly<Record<string, string>>;
  };
}

export function bleRadioFrom(manager: RnBleManager): BleRadio {
  const on = <T>(event: string, cb: (payload: T) => void) => {
    // SAFETY: the listener is invoked with this event's own payload; `never` is rn-ble's own
    // signature for "whatever this event carries", narrowed here by the event name
    const subscription = manager.addListener(event, cb as (payload: never) => void);
    return () => subscription.remove();
  };

  const radio: BleRadio = {
    startAdvertising: (options) => manager.startAdvertising(options),
    stopAdvertising: () => manager.stopAdvertising(),
    publishServices: (spec) =>
      manager.publishServices({
        services: spec.services.map((service) => ({
          uuid: service.uuid,
          characteristics: service.characteristics.map((c) => ({
            uuid: c.uuid,
            ...CHARACTERISTIC,
          })),
        })),
      }),
    unpublishServices: () => manager.unpublishServices(),
    // duplicates off: a scan that reports the same device several times a second would rebuild
    // the link continuously, and `discovery()` above already fires once per peer
    startScan: (options) => manager.startScan({ ...options, allowDuplicates: false }),
    stopScan: () => manager.stopScan(),
    connect: async (peripheralId): Promise<BleConnected> => {
      const opened = await manager.connect(peripheralId);
      return opened.mtu === undefined
        ? { connectionId: opened.connectionId }
        : { connectionId: opened.connectionId, mtu: opened.mtu };
    },
    disconnect: (connectionId) => manager.disconnect(connectionId),
    discoverServices: async (connectionId) => void (await manager.discoverServices(connectionId)),
    subscribe: async (connectionId, serviceUuid, characteristicUuid) =>
      void (await manager.subscribe(connectionId, serviceUuid, characteristicUuid)),
    write: (connectionId, serviceUuid, characteristicUuid, valueBase64, writeType) =>
      manager.write(connectionId, serviceUuid, characteristicUuid, valueBase64, writeType),
    setCharacteristicValue: (serviceUuid, characteristicUuid, valueBase64, notifySubscribers) =>
      manager.setCharacteristicValue(
        serviceUuid,
        characteristicUuid,
        valueBase64,
        notifySubscribers,
      ),
    onScanResult: (cb) =>
      on<RnScanResult>("onScanResult", (result) => {
        // the flattening this adapter exists for
        const advert = result.advertisement;
        const seen: BleAdvertisement = { peripheralId: result.peripheralId };
        if (advert?.localName !== undefined) Object.assign(seen, { localName: advert.localName });
        if (advert?.serviceDataBase64 !== undefined)
          Object.assign(seen, { serviceDataBase64: advert.serviceDataBase64 });
        cb(seen);
      }),
    onConnectionStateChanged: (cb) => on("onConnectionStateChanged", cb),
    onCharacteristicValueChanged: (cb) => on("onCharacteristicValueChanged", cb),
    onCharacteristicWriteRequested: (cb) => on("onCharacteristicWriteRequested", cb),
    onSubscribersChanged: (cb) => on("onSubscribersChanged", cb),
  };

  // absent stays absent: a platform with no MTU exchange is a fact the sizing has to read, and a
  // stub that echoed the asked-for number back would be a lie the fragmenter then sized against
  const negotiate = manager.requestMtu;
  if (negotiate !== undefined)
    Object.assign(radio, { requestMtu: (id: string, mtu: number) => negotiate(id, mtu) });
  return radio;
}
