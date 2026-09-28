/**
 * The radio this transport needs, and nothing more.
 *
 * `@syncmesh/rn-ble` satisfies this structurally, and is not imported: taking it by injection is
 * what lets everything here be tested with no radio, no simulator and no React Native — the same
 * reason `packages/relay` takes a `dial` rather than opening its own socket. It also means this
 * package holds no opinion about which module supplies the bytes, only about their shape.
 *
 * The methods are a strict subset of what that module exposes. Reads, descriptors, bonding and
 * RSSI are all absent because a transport that carries frames has no use for them, and a port
 * that names them would have to be satisfied by anything standing in for the radio in a test.
 */

/** Base64, because that is the boundary the module presents. See {@link BleRadio}. */
export type Base64 = string;

export interface BleAdvertisement {
  readonly peripheralId: string;
  readonly localName?: string | undefined;
  readonly serviceDataBase64?: Readonly<Record<string, Base64>> | undefined;
}

export interface BleConnected {
  readonly connectionId: string;
  /** What the two ends agreed on; absent when the platform does not say. */
  readonly mtu?: number | undefined;
}

export interface BleValueChanged {
  readonly connectionId: string;
  readonly characteristicUuid: string;
  readonly valueBase64: Base64;
}

/** A central wrote to the characteristic this device publishes. */
export interface BleWriteRequested {
  readonly characteristicUuid: string;
  readonly valueBase64: Base64;
  /** Who wrote it, when the platform says; absent means the peripheral cannot tell them apart. */
  readonly centralId?: string | undefined;
}

export interface BleSubscribers {
  readonly characteristicUuid: string;
  readonly centralIds: readonly string[];
  /** The smallest value a notification may carry across every subscriber, when known. */
  readonly maximumUpdateValueLength?: number | undefined;
}

export type Unsubscribe = () => void;

/**
 * Both roles, because a phone-to-phone mesh needs both in one process: a device advertises so it
 * can be found and scans so it can find, and which of the two carries a given frame depends only
 * on which end dialled.
 */
export interface BleRadio {
  readonly startAdvertising: (options: {
    readonly serviceUuids: readonly string[];
    readonly localName?: string;
    readonly serviceDataBase64?: Readonly<Record<string, Base64>>;
  }) => Promise<void>;
  readonly stopAdvertising: () => Promise<void>;
  readonly publishServices: (spec: {
    readonly services: readonly {
      readonly uuid: string;
      readonly characteristics: readonly { readonly uuid: string }[];
    }[];
  }) => Promise<void>;
  readonly unpublishServices: () => Promise<void>;
  readonly startScan: (options?: { readonly serviceUuids?: readonly string[] }) => Promise<void>;
  readonly stopScan: () => Promise<void>;
  readonly connect: (peripheralId: string) => Promise<BleConnected>;
  readonly disconnect: (connectionId: string) => Promise<void>;
  readonly discoverServices: (connectionId: string) => Promise<void>;
  readonly subscribe: (
    connectionId: string,
    serviceUuid: string,
    characteristicUuid: string,
  ) => Promise<void>;
  /** Central → peripheral. Rejects when the write did not leave, which is what `send` needs. */
  readonly write: (
    connectionId: string,
    serviceUuid: string,
    characteristicUuid: string,
    valueBase64: Base64,
    writeType?: "withResponse" | "withoutResponse",
  ) => Promise<void>;
  /** Peripheral → its subscribers. There is no response to wait on; backpressure is the module's. */
  readonly setCharacteristicValue: (
    serviceUuid: string,
    characteristicUuid: string,
    valueBase64: Base64,
    notifySubscribers?: boolean,
  ) => Promise<void>;
  /** Negotiates upward where the platform allows it; the agreed value is what sizing must use. */
  readonly requestMtu?: (connectionId: string, mtu: number) => Promise<number>;

  readonly onScanResult: (cb: (event: BleAdvertisement) => void) => Unsubscribe;
  readonly onConnectionStateChanged: (
    cb: (event: { readonly connectionId: string; readonly state: string }) => void,
  ) => Unsubscribe;
  readonly onCharacteristicValueChanged: (cb: (event: BleValueChanged) => void) => Unsubscribe;
  readonly onCharacteristicWriteRequested: (cb: (event: BleWriteRequested) => void) => Unsubscribe;
  readonly onSubscribersChanged: (cb: (event: BleSubscribers) => void) => Unsubscribe;
  /**
   * The adapter itself turning off, on, or being refused — the one event a radio cannot infer.
   *
   * **Its absence was a real bug.** Every other event here reports something about a *peer*; none
   * of them fires when the radio under them is switched off, because from the stack's point of
   * view nothing happened to any link — the medium simply stopped existing. So a phone whose
   * Bluetooth was toggled off and on again never recovered: scanning and advertising had been
   * torn down by the OS and nothing told this transport to start them again. It is the same shape
   * as a Wi-Fi drop leaving a socket abandoned rather than closed, and it wants the same answer.
   *
   * `state` is CoreBluetooth's own vocabulary — `poweredOn`, `poweredOff`, `unauthorized`,
   * `unsupported`, `resetting`, `unknown` — passed through rather than reduced, because
   * "unauthorized" and "poweredOff" call for different things from a person and folding them into
   * a boolean throws away the only part worth acting on.
   *
   * Optional because a medium with no such notion (a test double, a virtual air) is not obliged to
   * invent one; a radio that cannot say is simply one nothing will wake.
   */
  readonly onAdapterStateChanged?: (cb: (state: string) => void) => Unsubscribe;
}

/**
 * ATT's own overhead: three bytes of every negotiated MTU belong to the opcode and the handle,
 * so a payload never gets the whole of it.
 */
export const ATT_OVERHEAD = 3;

/** What every BLE stack must support before anyone negotiates upward, minus ATT's own bytes. */
export const MINIMUM_PAYLOAD = 23 - ATT_OVERHEAD;

/** An attribute value is at most this, whatever the MTU (Core spec, Vol 3 Part F §3.2.9). */
export const ATT_MAX_ATTRIBUTE_LENGTH = 512;

/**
 * What a notification may carry, from the negotiated MTU. Bounded by the PDU alone: a
 * notification is not an attribute write, so the attribute maximum below does not apply to it.
 */
export const notifyLimit = (mtu: number | undefined): number =>
  mtu === undefined ? MINIMUM_PAYLOAD : Math.max(MINIMUM_PAYLOAD, mtu - ATT_OVERHEAD);

/**
 * What a characteristic write may carry — bounded by the **attribute**, which is smaller than the
 * PDU at any MTU above 515.
 *
 * Measured rather than reasoned about (`rn-ble`'s netsim harness): at a 517-byte MTU the PDU has
 * room for 514 and a real stack refuses that write with `INVALID_ATTRIBUTE_LENGTH`. Sizing both
 * directions off the MTU alone makes every packet at the default MTU a write that never lands.
 */
export const writeLimit = (mtu: number | undefined): number =>
  Math.min(notifyLimit(mtu), ATT_MAX_ATTRIBUTE_LENGTH);

/**
 * A subscriber's own stated limit, which is **already a payload length and not an MTU** — iOS
 * reports what a notification may carry, with ATT's bytes taken off for you. Subtracting them
 * again is three bytes of every notification spent on nothing.
 */
export const subscriberLimit = (maximumUpdateValueLength: number | undefined): number =>
  maximumUpdateValueLength === undefined
    ? MINIMUM_PAYLOAD
    : Math.max(MINIMUM_PAYLOAD, maximumUpdateValueLength);
