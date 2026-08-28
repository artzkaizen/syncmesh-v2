import type { PeerId } from "@syncmesh/kernel";
import type { Bridge, Transport } from "@syncmesh/transport";

import { Result } from "@syncmesh/result";
import { createFrameTransport } from "@syncmesh/transport";

import type { LinkOptions } from "./link.js";
import type { BleRadio } from "./radio.js";

import { advertisement, hintFrom, hintOf } from "./advert.js";
import { discovery, shouldDial } from "./dial.js";
import { bleLink } from "./link.js";
import { payloadLimit } from "./radio.js";

/**
 * BLE as a `FrameTransport`.
 *
 * Both roles run at once, because a phone-to-phone mesh needs both in one process: this device
 * advertises so it can be found and scans so it can find. Which role carries a given link is
 * decided by {@link shouldDial} and nothing else, so exactly one end connects and the other
 * waits to be written to.
 *
 * Everything above a link is the bridge's: grants, cursors, the gap rule, resync. This file owns
 * only what is true of a radio — who is nearby, who dials, and where an arriving packet belongs.
 */

export interface BleOptions {
  readonly radio: BleRadio;
  /** The GATT service and characteristic both ends agree on; ours by convention, yours by config. */
  readonly serviceUuid: string;
  readonly characteristicUuid: string;
  /** How long a peer stays known after its last advertisement. */
  readonly ttlMs?: number;
  /** What to ask for; the platform answers with what it got, which is what sizing uses. */
  readonly mtu?: number;
  readonly name?: string;
  /** A packet or a frame that went nowhere, for a log a person reads on a device. */
  readonly onDropped?: (why: string) => void;
}

export const DEFAULT_MTU = 517;

/** One peer's link and what the radio needs to find it again. */
interface Held {
  readonly link: ReturnType<typeof bleLink>;
  readonly bridge: Bridge;
  readonly connectionId?: string | undefined;
  /** The smallest a notification may be to this peer; only the dialled side ever uses it. */
  notifyLimit: number;
}

export function bleTransport(options: BleOptions): Transport {
  const { radio, serviceUuid, characteristicUuid } = options;
  const held = new Map<string, Held>();
  const byConnection = new Map<string, string>();
  const drop = (why: string) => options.onDropped?.(why);
  let notifyLimit = payloadLimit(undefined);

  /**
   * Forgets a link, and the peer with it.
   *
   * Dropping the link alone would leave discovery still holding the hint, so the peer's next
   * advertisement reads as one it has already seen and nothing re-dials — the device would be
   * gone until the process restarted. A link ending is exactly the moment to stop knowing it.
   */
  let close = (hint: string): void => void hint;

  return createFrameTransport({
    name: options.name ?? "ble",
    open: async (ctx, attach) => {
      const self = hintOf(ctx.identity.peerId);
      const seen = discovery(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs });

      close = (hint) => {
        const link = held.get(hint);
        if (link === undefined) return;
        held.delete(hint);
        if (link.connectionId !== undefined) byConnection.delete(link.connectionId);
        seen.forget(hint);
        link.bridge.close();
        link.link.close?.();
      };

      /** A link, attached, and remembered under the hint the radio knows it by. */
      const hold = (hint: string, connectionId: string | undefined, peer?: PeerId): Held => {
        const wiring: LinkOptions = {
          radio,
          serviceUuid,
          characteristicUuid,
          peer: hint,
          limit: () =>
            connectionId === undefined ? notifyLimit : (held.get(hint)?.notifyLimit ?? notifyLimit),
          onDropped: drop,
          // a write that did not leave ends the link; the next advertisement rebuilds it, and
          // the bridge resyncs from its cursors, which is the recovery every loud failure uses
          onFailed: (cause) => {
            drop(`the link to ${hint} failed: ${String(cause)}`);
            close(hint);
          },
        };
        // its presence is the role: a link with a connection writes, one without notifies
        if (connectionId !== undefined) Object.assign(wiring, { connectionId });
        const link = bleLink(wiring);
        const entry: Held = {
          link,
          bridge: attach(link, peer),
          connectionId,
          notifyLimit: payloadLimit(undefined),
        };
        held.set(hint, entry);
        if (connectionId !== undefined) byConnection.set(connectionId, hint);
        return entry;
      };

      /** Connect, find the characteristic, subscribe, and take whatever MTU we are given. */
      const dial = async (hint: string, peripheralId: string): Promise<void> => {
        const opened = await Result.tryPromise({
          try: async () => {
            const connection = await radio.connect(peripheralId);
            await radio.discoverServices(connection.connectionId);
            await radio.subscribe(connection.connectionId, serviceUuid, characteristicUuid);
            const mtu =
              (await radio.requestMtu?.(connection.connectionId, options.mtu ?? DEFAULT_MTU)) ??
              connection.mtu;
            return { connectionId: connection.connectionId, mtu };
          },
          catch: (cause) => cause,
        });
        if (opened.isErr()) {
          drop(`could not dial ${hint}: ${String(opened.error)}`);
          seen.forget(hint);
          return;
        }
        const entry = hold(hint, opened.value.connectionId);
        entry.notifyLimit = payloadLimit(opened.value.mtu);
      };

      await radio.publishServices({
        services: [{ uuid: serviceUuid, characteristics: [{ uuid: characteristicUuid }] }],
      });
      await radio.startAdvertising(advertisement(ctx.identity.peerId, serviceUuid));
      await radio.startScan({ serviceUuids: [serviceUuid] });

      radio.onScanResult((advert) => {
        const hint = hintFrom(advert, serviceUuid);
        // our own advertisement comes back on some platforms; dialling it would be a link to self
        if (hint === undefined || hint === self) return;
        if (!seen.sighted(hint, advert.peripheralId)) return;
        if (!shouldDial(self, hint)) return; // the other end dials; we answer when it writes
        void dial(hint, advert.peripheralId);
      });

      radio.onCharacteristicValueChanged((event) => {
        const hint = byConnection.get(event.connectionId);
        if (hint === undefined) return drop("a notification arrived on no link of ours");
        held.get(hint)?.link.accept(event.valueBase64);
      });

      radio.onCharacteristicWriteRequested((event) => {
        // the dialled side: whoever wrote is the peer, and this is the first we hear of them.
        // A platform that does not name the central leaves one inbound link the only answer —
        // stated rather than guessed at, because guessing would cross two peers' frames
        const hint = event.centralId ?? onlyInbound();
        if (hint === undefined) return drop("a write arrived and no peer could be named for it");
        const entry = held.get(hint) ?? hold(hint, undefined);
        entry.link.accept(event.valueBase64);
      });

      radio.onSubscribersChanged((event) => {
        notifyLimit = payloadLimit(event.maximumUpdateValueLength);
        // nobody subscribed means nothing can be notified; the links go when the peers do
        for (const [hint, entry] of held)
          if (entry.connectionId === undefined) held.set(hint, { ...entry, notifyLimit });
      });

      radio.onConnectionStateChanged((event) => {
        if (event.state === "connected") return;
        const hint = byConnection.get(event.connectionId);
        if (hint !== undefined) close(hint);
      });

      /** The one link nobody dialled, when the platform will not say which central wrote. */
      const onlyInbound = (): string | undefined => {
        const inbound = [...held].filter(([, entry]) => entry.connectionId === undefined);
        return inbound.length === 1 ? inbound[0]?.[0] : undefined;
      };
    },
    close: async () => {
      for (const [, entry] of held) {
        entry.bridge.close();
        entry.link.close?.();
      }
      held.clear();
      byConnection.clear();
      await Result.tryPromise({
        try: async () => {
          await radio.stopScan();
          await radio.stopAdvertising();
          await radio.unpublishServices();
        },
        catch: (cause) => cause,
      });
    },
  });
}
