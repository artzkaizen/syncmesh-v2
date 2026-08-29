import type { PeerId } from "@syncmesh/kernel";
import type { Bridge, FrameLink, Transport } from "@syncmesh/transport";

import { Result } from "@syncmesh/result";
import { createFrameTransport } from "@syncmesh/transport";

import type { LinkOptions } from "./link.js";
import type { BleRadio } from "./radio.js";

import { advertisement, hintFrom, hintOf } from "./advert.js";
import { discovery, shouldDial } from "./dial.js";
import { bleLink } from "./link.js";
import { notifyLimit as notifyLimitOf, subscriberLimit, writeLimit } from "./radio.js";
import { secureLink } from "./session.js";

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
 *
 * Every link is encrypted, with no setting that says otherwise: what the bridge is handed is
 * always a {@link secureLink}, so a peer that will not do the handshake gets nothing across.
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

/**
 * What a BLE link moves once the stack's overhead is paid, near enough (RFC-0012 §2). Nominal,
 * and that is the point: the scorer needs the *ratio* to a wide link rather than a measurement,
 * and being two orders of magnitude below one is the whole of what keeps a snapshot off the
 * radio without anyone having to name BLE inside the scorer.
 */
export const BLE_BANDWIDTH_BPS = 24_000;

/** One peer's link and what the radio needs to find it again. */
interface Held {
  /** The radio end, which takes packets in; the bridge never sees it. */
  readonly link: ReturnType<typeof bleLink>;
  /** The encrypted end, which is what was attached and what closing has to go through. */
  readonly frames: FrameLink;
  readonly bridge: Bridge;
  readonly connectionId?: string | undefined;
}

export function bleTransport(options: BleOptions): Transport {
  const { radio, serviceUuid, characteristicUuid } = options;
  const held = new Map<string, Held>();
  const byConnection = new Map<string, string>();
  /**
   * The peer on each link, by the hint the radio knows it by — and only once the handshake has
   * proved it. An advertisement's hint is a lossy derivation of a peer id and anyone can put one
   * in the air, so claiming to reach a peer on the strength of one would be routing a frame at a
   * signature nobody checked (E28).
   */
  const proven = new Map<string, PeerId>();
  const drop = (why: string) => options.onDropped?.(why);
  let notifyLimit = notifyLimitOf(undefined);

  /**
   * Forgets a link, and the peer with it.
   *
   * Dropping the link alone would leave discovery still holding the hint, so the peer's next
   * advertisement reads as one it has already seen and nothing re-dials — the device would be
   * gone until the process restarted. A link ending is exactly the moment to stop knowing it.
   */
  let close = (hint: string): void => void hint;

  const transport = createFrameTransport({
    name: options.name ?? "ble",
    open: async (ctx, attach) => {
      const self = hintOf(ctx.identity.peerId);
      const seen = discovery(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs });

      close = (hint) => {
        const link = held.get(hint);
        if (link === undefined) return;
        held.delete(hint);
        proven.delete(hint);
        if (link.connectionId !== undefined) byConnection.delete(link.connectionId);
        seen.forget(hint);
        link.bridge.close();
        link.frames.close?.();
      };

      /** A link, attached, and remembered under the hint the radio knows it by. */
      const hold = (
        hint: string,
        connectionId: string | undefined,
        mtu?: number,
        peer?: PeerId,
      ): Held => {
        const wiring: LinkOptions = {
          radio,
          serviceUuid,
          characteristicUuid,
          peer: hint,
          // read per send, not captured: a notification's size is renegotiated as subscribers change
          limit: () => (connectionId === undefined ? notifyLimit : writeLimit(mtu)),
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
        const frames = secureLink(link, {
          identity: ctx.identity,
          onDropped: drop,
          // the session is open and the peer signed for its id: this link now reaches it
          onEstablished: (id) => void proven.set(hint, id),
          // a handshake that cannot finish is a link that will never carry anything
          onFailed: (cause) => {
            drop(`the session with ${hint} failed: ${String(cause)}`);
            close(hint);
          },
        });
        const entry: Held = {
          link,
          frames,
          bridge: attach(frames, peer),
          connectionId,
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
        // the MTU is known before the link exists, and has to be: the session's hello is the
        // first thing out, and a link built at the 20-byte floor would fragment it eleven ways
        hold(hint, opened.value.connectionId, opened.value.mtu);
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

      // one number for every notification this peripheral sends, which is how the platform
      // reports it; a link reads it per send rather than holding a copy that could go stale
      radio.onSubscribersChanged((event) => {
        notifyLimit = subscriberLimit(event.maximumUpdateValueLength);
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
        entry.frames.close?.();
      }
      held.clear();
      byConnection.clear();
      proven.clear(); // a stopped radio reaches nobody, whatever it proved while it was up
      // a radio that will not stop is already gone; there is nobody left to report it to
      const stopped = await Result.tryPromise({
        try: async () => {
          await radio.stopScan();
          await radio.stopAdvertising();
          await radio.unpublishServices();
        },
        catch: (cause) => cause,
      });
      if (stopped.isErr()) drop(`the radio did not shut down cleanly: ${String(stopped.error)}`);
    },
  });

  return {
    ...transport,
    /**
     * Direct — a phone two metres away with no server in the path — and narrow. Not `costly`:
     * low energy is the whole of what BLE is, which is why presence may ride it where an
     * expensive radio would refuse the same frame.
     */
    route: () => ({ direct: true, bandwidthBps: BLE_BANDWIDTH_BPS }),
    /**
     * The peers with an open session on this radio (E28), so a frame addressed to one of them
     * can be routed here instead of broadcast everywhere.
     *
     * Only peers the handshake proved. A link that has been dialled but has not finished its
     * session is absent, which is correct: it cannot carry a frame yet either.
     */
    reaches: () => new Set(proven.values()),
  };
}
