import type { BleRadio, RnBleManager } from "@syncmesh/ble";

import { bleRadioFrom } from "@syncmesh/ble";
import { requireOptionalNativeModule } from "expo";

/**
 * The phone's Bluetooth radio, as the mesh's {@link BleRadio} — or nothing, with a reason.
 *
 * Everything here is about *this platform*: whether a native module was compiled into this build,
 * what the adapter is currently doing, and how an Expo module's methods have to be taken hold of.
 * What is deliberately **not** here is which service, which characteristic and which group — those
 * are one app's identifiers and belong to the app that owns them. A library that shipped a service
 * uuid would be deciding who two strangers' phones will talk to.
 */

/**
 * Why this build has no radio, when it has none — or `undefined` when it does.
 *
 * **"no radio in this build" was wrong for almost every case it was shown for.** Two completely
 * different situations produced it: a config switch left off, and a native module that was never
 * compiled in. Only the second is about the build; the first is about a decision somebody made and
 * can unmake. A settings screen that says the wrong one of these sends a person to check the wrong
 * thing — and a third case, the OS refusing the radio, is not an absence at all: the module is
 * there, it answers, and what it says is {@link radioState}.
 */
export type NoRadio = "not-in-this-build" | "switched-off-in-config";

let absent: NoRadio | undefined;

/**
 * The adapter as it last reported itself — the reading that says what is actually wrong.
 *
 * `unauthorized` (the Bluetooth prompt was declined), `poweredOff` (the Control Centre toggle),
 * `unsupported` (no radio at all) and `poweredOn` are four different situations with four different
 * answers, and until this was surfaced a screen could only say "Bluetooth is present", which is
 * true of all four and useful in none. Kept as the platform's own word rather than reduced to an
 * enum of this package's making, because the distinction *is* the value and CoreBluetooth and
 * Android's adapter do not agree on a vocabulary worth inventing a third one over.
 */
let adapter: string | undefined;

/** What the radio last said about itself, or `undefined` if it has never been asked. */
export const radioState = (): string | undefined => adapter;

/** Why the radio is missing, for a screen that would otherwise have to guess. */
export const radioAbsence = (): NoRadio | undefined => absent;

/**
 * MTU negotiation, present only where the platform offers it.
 *
 * Optional on both sides of the port, and lifted out so the delegation below stays a flat list: a
 * radio that will not negotiate still links, it simply fragments into smaller packets, which
 * `packages/ble/src/fragment.ts` sizes from whatever it actually got rather than from what it
 * asked for.
 */
const negotiator = (module: RnBleManager): Pick<RnBleManager, "requestMtu"> => {
  const ask = module.requestMtu?.bind(module);
  return ask === undefined ? {} : { requestMtu: (connection, mtu) => ask(connection, mtu) };
};

/**
 * The native module, bound a method at a time, with the adapter's state read on the way past.
 *
 * **Written out rather than spread, and that is not style.** An Expo module is a class instance and
 * its methods live on the prototype, so `{ ...module }` copies *none* of them — and it type-checks,
 * because the empty result is compared against a structural type it satisfies in name only. The
 * list below is also the honest inventory of what the mesh asks of a radio.
 *
 * `getState` is the one method that does more than delegate. Two phones a foot apart reporting
 * "Bluetooth is present" and exchanging nothing is the case this exists for: the adapter's own word
 * is the fact that explains it, and a reading taken only when something happened to ask would be
 * stale exactly when a settings screen is being read.
 */
const watched = (module: RnBleManager): RnBleManager => ({
  connect: (peripheral) => module.connect(peripheral),
  getState: async () => {
    const state = await module.getState();
    adapter = state;
    return state;
  },
  disconnect: (connection) => module.disconnect(connection),
  discoverServices: (connection) => module.discoverServices(connection),
  publishServices: (spec) => module.publishServices(spec),
  ...negotiator(module),
  setCharacteristicValue: (service, characteristic, value, notify) =>
    module.setCharacteristicValue(service, characteristic, value, notify),
  startAdvertising: (options) => module.startAdvertising(options),
  startScan: (options) => module.startScan(options),
  stopAdvertising: () => module.stopAdvertising(),
  stopScan: () => module.stopScan(),
  subscribe: (connection, service, characteristic) =>
    module.subscribe(connection, service, characteristic),
  unpublishServices: () => module.unpublishServices(),
  write: (connection, service, characteristic, value, writeType) =>
    module.write(connection, service, characteristic, value, writeType),
  addListener: (event, listener) => module.addListener(event, listener),
});

/**
 * Is there a radio on this client at all — asked without throwing to find out.
 *
 * `@syncmesh/rn-ble` resolves its native module the moment it loads, with `requireNativeModule`,
 * which *reports and throws* when there is none: a static import takes the whole app down on Expo
 * Go, and wrapping the import in a `try` still leaves the red screen behind, because the report
 * happens before the throw. `requireOptionalNativeModule` is the same question asked properly — it
 * answers `null` for a module that was never compiled in — and it hands back the very object
 * `@syncmesh/rn-ble` exports as `BleManager`, so nothing here needs to reach for that package at
 * all. The name is the native registration, not the npm one.
 */
const radioModule = (): RnBleManager | null =>
  // SAFETY: `requireOptionalNativeModule` is declared over `any`, so the type argument is this
  // file's claim about what the native module is rather than a check of it. `RnBleManager` is
  // `@syncmesh/ble`'s own statement of exactly what the mesh touches, and `RNBle` implements every
  // member of it — which is the claim the FFI boundary exists to make in one place.
  requireOptionalNativeModule<RnBleManager>("RNBle");

/** What this build has decided about its own radio, before the platform is asked anything. */
export interface RadioOptions {
  /**
   * Whether this build may reach for a radio at all. Default `true`.
   *
   * An ordinary switch for turning the radio off in a build that does not want one — a kiosk, a
   * fleet on a site that forbids Bluetooth, a test build. It is reported as
   * `switched-off-in-config` rather than as "no radio", because the two send a person to check
   * completely different things.
   *
   * It is **no longer load-bearing**, and the history is worth knowing: it existed because
   * constructing a `CBCentralManager` used to abort the process on a simulator, so the absence of a
   * radio had to be *declared* rather than detected — asking the question was itself fatal. That is
   * fixed, and the constructor now returns normally with the adapter reporting `unsupported` like
   * any other state.
   */
  readonly enabled?: boolean;
}

/**
 * The platform's radio, if this build has the native module and this config will allow it.
 *
 * Returns nothing rather than throwing when there is none, because a simulator has no Bluetooth and
 * an Expo Go client has no native module — and neither is a broken app. The mesh simply has one
 * fewer source, which is a sentence the transport surface already knows how to say: `$status`
 * reports the condition per source, and every read is still answered out of this device's own
 * database.
 *
 * @example
 * const radio = nativeRadio({ enabled: Constants.expoConfig?.extra?.bluetooth !== false });
 * const overTheAir =
 *   radio === undefined
 *     ? undefined
 *     : bleTransport({ name: "issues", radio, serviceUuid: SERVICE, characteristicUuid: CHAR });
 */
export const nativeRadio = (options: RadioOptions = {}): BleRadio | undefined => {
  if (options.enabled === false) {
    absent = "switched-off-in-config";
    return undefined;
  }
  const native = radioModule();
  if (native === null) {
    absent = "not-in-this-build";
    return undefined;
  }
  absent = undefined;
  // the state moves without anybody asking — a toggle in Control Centre, a permission answered —
  // and a reading that only updated on demand would be stale exactly when it is being read
  native.addListener("onStateChanged", (event: { readonly state?: string }) => {
    if (event.state !== undefined) adapter = event.state;
  });
  return bleRadioFrom(watched(native));
};
