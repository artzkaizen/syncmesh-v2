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
}

/**
 * ATT's own overhead: three bytes of every negotiated MTU belong to the opcode and the handle,
 * so a payload never gets the whole of it.
 */
export const ATT_OVERHEAD = 3;

/** What every BLE stack must support before anyone negotiates upward, minus ATT's own bytes. */
export const MINIMUM_PAYLOAD = 23 - ATT_OVERHEAD;

/**
 * What one direction can actually put in a packet.
 *
 * Sized from the negotiated MTU rather than a constant, and separately per direction — a
 * notification is capped at the subscriber's own limit and cannot be split across packets the
 * way a long write can, so the two ends of one link routinely differ.
 */
export const payloadLimit = (mtu: number | undefined): number =>
  mtu === undefined ? MINIMUM_PAYLOAD : Math.max(MINIMUM_PAYLOAD, mtu - ATT_OVERHEAD);
