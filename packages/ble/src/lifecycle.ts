import { Result } from "@syncmesh/result";

import type { BleRadio, Unsubscribe } from "./radio.js";

/**
 * One restart at a time, and never one fewer than was asked for.
 *
 * Two reasons to restart arrive within a tick of each other — the adapter announcing `poweredOn`
 * and a `wake()` from the app are the same recovery reaching this transport by two routes — and
 * run interleaved they are worse than either alone: the second teardown takes down the links the
 * first had just finished building.
 *
 * A request arriving mid-restart is *owed one more pass* rather than dropped. Dropping it assumes
 * the running restart already saw what the new request knows, and the case that assumption loses
 * is exactly the one that matters: a restart that began while the adapter was still off.
 */
export const createRestart = <Context>() => {
  let running: Promise<void> | undefined;
  let owed = false;
  return (
    target: { readonly stop: () => Promise<void>; readonly start: (ctx: Context) => Promise<void> },
    ctx: Context,
  ): Promise<void> => {
    if (running !== undefined) {
      owed = true;
      return running;
    }
    running = (async () => {
      do {
        owed = false;
        await target.stop();
        await target.start(ctx);
      } while (owed);
    })().finally(() => (running = undefined));
    return running;
  };
};

/**
 * The radio telling us it came back, which is the only way a BLE transport recovers on its own.
 *
 * `wake()` exists for something outside to knock; this is the medium knocking for itself, and
 * it is the difference between "Bluetooth works again once you relaunch" and "Bluetooth works
 * again". `poweredOn` arriving after anything else means the adapter was off, refused or
 * resetting and now is not — every one of which tore down discovery underneath us.
 *
 * The first `poweredOn` is skipped: `open` is already doing that work, and restarting the
 * transport from inside its own `open` would be a loop rather than a recovery. `undefined` on a
 * radio that cannot report its adapter.
 */
export const watchPower = (radio: BleRadio, back: () => void): Unsubscribe | undefined => {
  let wasOn = true;
  return radio.onAdapterStateChanged?.((state) => {
    const on = state === "poweredOn";
    if (on && !wasOn) back();
    wasOn = on;
  });
};

/** Scanning, advertising and the published service, stopped; the cause when the radio would not. */
export const stopRadio = (radio: BleRadio) =>
  Result.tryPromise({
    try: async () => {
      await radio.stopScan();
      await radio.stopAdvertising();
      await radio.unpublishServices();
    },
    catch: (cause) => cause,
  });
