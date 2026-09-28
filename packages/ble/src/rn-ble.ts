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

/**
 * The two vocabularies a GATT characteristic is declared in, spelled out rather than left as
 * `string`.
 *
 * They are unions in `@syncmesh/rn-ble` and were `string[]` here, which made this interface a
 * *wider* claim than the module it describes — so the module did not satisfy it, and the file's
 * own promise that "the real `BleManager` satisfies it by structure" was false at the one call
 * that matters. Narrowing is what makes the promise true; it costs nothing, because the only
 * characteristic this adapter ever publishes is the one below.
 */
type Property = "read" | "write" | "writeWithoutResponse" | "notify" | "indicate";
type Permission = "readable" | "writeable";

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
  /** The adapter as it is right now — `unknown` until CoreBluetooth has finished starting up. */
  readonly getState: () => Promise<string>;
  readonly publishServices: (spec: {
    readonly services: readonly {
      readonly uuid: string;
      readonly characteristics: readonly {
        readonly uuid: string;
        readonly properties: readonly Property[];
        readonly permissions?: readonly Permission[];
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

  /**
   * Waits for the adapter to actually be on before doing anything that needs it.
   *
   * **`unknown` is not an error, it is "ask me in a moment".** A freshly constructed
   * `CBCentralManager`/`CBPeripheralManager` reports `unknown` until CoreBluetooth has finished
   * starting and called back with the real answer, which is a handful of milliseconds later and on
   * a queue nobody here controls. Every call that needs the radio refuses in that window — the
   * native module is right to refuse, and its message says exactly this: *"Listen for
   * onStateChanged and retry once state == 'poweredOn'."*
   *
   * Nothing was listening. The transport published its services the moment it started, lost the
   * race, and the rejection surfaced as `RNBleNotPoweredOnException: state=unknown` — which reads
   * like "this phone has no Bluetooth" and is nothing of the sort.
   *
   * A terminal state resolves too rather than hanging: `unsupported` (a simulator), `unauthorized`
   * (permission refused) and `poweredOff` are all answers, and the caller's own
   * `RNBleNotPoweredOnException` is the honest thing to raise for them. Only `unknown` and
   * `resetting` are worth waiting through, because only those become something else on their own.
   */
  const settled = new Set(["poweredOn", "poweredOff", "unauthorized", "unsupported"]);
  const powered = (): Promise<void> =>
    // subscribe *first*, then ask. The other order has a gap: `getState` is a round trip to the
    // native side, and a state that settles while it is in flight fires its event before anything
    // is listening — so the answer is missed and the wait never ends. A test caught exactly that.
    new Promise<void>((resolve) => {
      let done = (): void => undefined;
      const finish = () => {
        done();
        resolve();
      };
      done = on<{ readonly state: string }>("onStateChanged", ({ state }) => {
        if (settled.has(state)) finish();
      });
      void manager.getState().then((state) => {
        if (settled.has(state)) finish();
      });
    });

  const radio: BleRadio = {
    startAdvertising: async (options) => {
      await powered();
      return manager.startAdvertising(options);
    },
    stopAdvertising: () => manager.stopAdvertising(),
    publishServices: async (spec) => {
      await powered();
      return manager.publishServices({
        services: spec.services.map((service) => ({
          uuid: service.uuid,
          characteristics: service.characteristics.map((c) => ({
            uuid: c.uuid,
            ...CHARACTERISTIC,
          })),
        })),
      });
    },
    unpublishServices: () => manager.unpublishServices(),
    /**
     * **Duplicates on, and this is not a tuning knob.**
     *
     * Core Bluetooth reports each peripheral *once per scan session* unless asked otherwise, and
     * `bleTransport`'s whole recovery model is the next advertisement: a link that drops calls
     * `seen.forget(hint)` precisely so the peer's next sighting is a fresh one that re-dials, and
     * the dial backoff is a wait for a later sighting that a one-shot scan never delivers. With
     * duplicates off, the first drop is permanent — the radio reports `ok`, reaches nobody, and
     * two phones a foot apart never find each other again until the app is relaunched.
     *
     * This was off, on the reasoning that repeated reports would rebuild the link continuously
     * and that `discovery()` already fires once per peer. The second half is true and is what
     * makes the first half cost nothing: a sighting inside its TTL is dropped by `seen.sighted`
     * before it reaches a dial. What the reasoning missed is that the dedupe it was relying on is
     * exactly what makes a *re*-sighting necessary, and the platform was the only thing that
     * could still supply one.
     *
     * Not a knob. iOS ignores the request while an app is backgrounded whatever it says, and a
     * foreground scan that does not repeat is one this transport cannot recover from — so there
     * is no caller for whom `false` is the right answer.
     */
    startScan: async (options) => {
      await powered();
      return manager.startScan({ ...options, allowDuplicates: true });
    },
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
    // the module's own `onStateChanged`, unwrapped from its envelope: callers want the state, and
    // the envelope is an implementation detail of this bridge rather than of the port
    onAdapterStateChanged: (cb) =>
      on<{ readonly state: string }>("onStateChanged", ({ state }) => cb(state)),
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
