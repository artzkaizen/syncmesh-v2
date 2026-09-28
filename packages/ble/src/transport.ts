import type { PeerId } from "@syncmesh/kernel";
import type { Transport, Upgraded } from "@syncmesh/transport";

import { Result, omitUndefined } from "@syncmesh/result";
import { createBackoff, createFrameTransport, createLiveness } from "@syncmesh/transport";

import type { LinkOptions } from "./link.js";
import type { BleAdvertisement, BleRadio, Unsubscribe } from "./radio.js";
import type { BleSighting } from "./sighting.js";

import { advertisement, groupFrom, groupTag, hintFrom, hintOf } from "./advert.js";
import { discovery, shouldDial } from "./dial.js";
import { bleLink } from "./link.js";
import { notifyLimit as notifyLimitOf, subscriberLimit, writeLimit } from "./radio.js";
import { judge } from "./sighting.js";

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
  /**
   * How often a quiet link is prodded; it is hung up on at {@link SILENCE_FACTOR} times this.
   *
   * **A radio needs this more than a socket does, not less.** Cycling one phone's Bluetooth tells
   * that phone everything and its neighbour nothing at all — no disconnect, no close — so the
   * neighbour holds a session keyed to an ephemeral secret that no longer exists, refuses to
   * re-dial a peer it believes it already has, and stays that way for as long as both handsets are
   * switched on. Recovering the adapter that cycled does not reach the one that did not.
   */
  readonly keepaliveMs?: number;
  /** What to ask for; the platform answers with what it got, which is what sizing uses. */
  readonly mtu?: number;
  readonly name?: string;
  /** A packet or a frame that went nowhere, for a log a person reads on a device. */
  readonly onDropped?: (why: string) => void;
  /**
   * Every advertisement judged, and the rung that judged it (`./sighting.ts`).
   *
   * **Not a drop.** Four of the six verdicts are this medium working: a peer whose turn it is to
   * dial, one already known, one backing off, our own advertisement coming back. What this
   * answers is the question a device cannot answer from outside — *why is nobody finding
   * anybody* — which until it existed reported as six silent returns and a transport calling
   * itself `ok`.
   *
   * Called per scan result, and a peer advertises about once a second: report a **change** of
   * verdict, never every one.
   */
  readonly onSighting?: (sighting: BleSighting) => void;
  /**
   * Concurrent links this radio sustains. Raising it does not give the controller more capacity;
   * it gives you more links that all work worse. Present because a controller is not one number
   * across every phone, not because an app has a view.
   */
  readonly maxLinks?: number;
  /**
   * The fleet this device belongs to, advertised in four bytes so a stranger's phone can be
   * refused **before** a connection is spent (book ch. 17).
   *
   * This is the only cheap refusal BLE can make. Ten bytes of advertisement cannot name a peer,
   * and a prefix of one cannot be refused on without closing the join corridor — but a group
   * can, because one of ours carries it from config before it carries any credential.
   *
   * **An optimization, not a security control**, exactly as it is on every other medium: anyone
   * can put any four bytes in the air, and everything that reaches a link still faces the grant
   * and the `allow` rules. What it saves is a connection, a subscription and a handshake.
   */
  readonly group?: string;
}

/** What a BLE controller sustains before throughput and latency degrade across every link. */
export const DEFAULT_MAX_LINKS = 6;

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
  /** The upgraded end, which is what was attached and what closing has to go through. */
  readonly session: Upgraded;
  readonly connectionId?: string | undefined;
}

/** Closes whichever link is holding this peer, by the hint the radio knows it by. */
const dropPeer = (
  proven: ReadonlyMap<string, PeerId>,
  peer: PeerId,
  close: (hint: string) => void,
): void => {
  for (const [hint, id] of proven) if (id === peer) close(hint);
};

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
const serialise = () => {
  let running: Promise<void> | undefined;
  let owed = false;
  return (stop: () => Promise<void>, start: () => Promise<void>): Promise<void> => {
    if (running !== undefined) {
      owed = true;
      return running;
    }
    running = (async () => {
      do {
        owed = false;
        await stop();
        await start();
      } while (owed);
    })().finally(() => (running = undefined));
    return running;
  };
};

/**
 * A deadline per link, because on this medium silence is the only evidence of an ending.
 *
 * The adapter watch in `open` recovers *this* device when its own radio cycles. It cannot recover
 * the device on the other side, which was told nothing and is holding a link that ended without a
 * disconnect — and a peer this radio believes it is already linked to is one it will not dial when
 * the advertisement comes back. Reproduced in `one-radio-cycles.test.ts`: one handset toggled, and
 * the pair never converges again. That is why BLE needs this as much as a LAN stream does, despite
 * having an adapter callback a socket has no equivalent of.
 *
 * The prod is `resync`: the far side answers cursors with a digest, always, so a re-request is this
 * protocol's keepalive and the only frame both ends already handle. A busy link is never prodded —
 * anything arriving re-arms the deadline.
 */
const linkDeadline = (
  options: BleOptions,
  on: {
    readonly drop: (why: string) => void;
    readonly close: (hint: string) => void;
    readonly probe: () => void;
  },
) =>
  createLiveness<string>({
    ...omitUndefined({ everyMs: options.keepaliveMs }),
    probe: on.probe,
    dead: (hint) => {
      on.drop(`${hint} went quiet and was hung up on`);
      on.close(hint);
    },
  });

/**
 * Connect, find the characteristic, subscribe, and take whatever MTU we are given.
 *
 * Four platform calls that only ever run together: a connection without a subscription carries
 * nothing back, and an MTU learned after the link exists is learned too late — the session's
 * hello is the first thing out, and a link built at the 20-byte floor would fragment it eleven
 * ways. A failure is a value because a peer that will not connect is ordinary on this medium.
 */
const openConnection = (peripheralId: string, options: BleOptions) =>
  Result.tryPromise({
    try: async () => {
      const { radio, serviceUuid, characteristicUuid } = options;
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
  let closeLink = (hint: string): void => void hint;
  /** The link deadline's timer, let go on close so a stopped radio leaves nothing running. */
  let stopLiveness: (() => void) | undefined;
  /** Holds the two reasons to restart to one at a time. See {@link serialise}. */
  const restart = serialise();

  /**
   * What `open` was called with, kept so the radio coming back can repeat it.
   *
   * A transport is opened once, by the mesh, with a context it never hands out again. When the
   * adapter is switched off the OS tears down scanning and advertising underneath us and there is
   * no second `open` coming — so recovering means re-running what `open` did, which means having
   * kept what it was called with.
   */
  let reopen: (() => Promise<void>) | undefined;
  /** Dropped on `close`, so a stopped transport is not still listening to a radio it left. */
  let watchAdapter: Unsubscribe | undefined;
  /**
   * Everything this `open` subscribed to on the radio, dropped when it closes.
   *
   * **A transport that restarts subscribes again, and the platform keeps both.** Recovering from
   * an adapter that cycled means running `open` a second time (see `reopen`), and every
   * subscription the first one made was still live — so one write arrived twice, the second copy
   * landing on a session that had already opened the first as a hello and could only report
   * `not a sealed frame`. Two restarts made it three copies. The links looked established, every
   * `reaches()` claimed its peers, and nothing crossed.
   */
  let listening: Unsubscribe[] = [];

  const transport = createFrameTransport({
    name: options.name ?? "ble",
    kind: "ble",
    ...omitUndefined({ onDropped: options.onDropped }),
    /**
     * Direct — a phone two metres away with no server in the path — and narrow. Not `costly`:
     * low energy is the whole of what BLE is, which is why presence may ride it where an
     * expensive radio would refuse the same frame.
     */
    route: () => ({ direct: true, bandwidthBps: BLE_BANDWIDTH_BPS }),
    open: async (ctx, _attach, upgrade) => {
      reopen = () =>
        restart(
          () => transport.stop(),
          () => transport.start(ctx),
        );
      /**
       * The radio telling us it came back, which is the only way this recovers on its own.
       *
       * `wake()` exists for something outside to knock; this is the medium knocking for itself, and
       * it is the difference between "Bluetooth works again once you relaunch" and "Bluetooth works
       * again". `poweredOn` arriving after anything else means the adapter was off, refused or
       * resetting and now is not — every one of which tore down discovery underneath us.
       *
       * The first `poweredOn` is skipped: `open` is already doing that work, and restarting the
       * transport from inside its own `open` would be a loop rather than a recovery.
       */
      let wasOn = true;
      watchAdapter?.();
      watchAdapter = radio.onAdapterStateChanged?.((state) => {
        const on = state === "poweredOn";
        if (on && !wasOn) void reopen?.().catch((cause: unknown) => drop(String(cause)));
        wasOn = on;
      });
      const self = hintOf(ctx.identity.peerId);
      /**
       * A peer that will not connect is re-advertised every second or so, and dialling each
       * sighting spends the controller on a link that is not going to open. Keyed by hint,
       * because a dial that fails has not proved a peer id to key by.
       */
      const backoff = createBackoff();
      const alive = linkDeadline(options, {
        drop,
        close: (hint) => closeLink(hint),
        probe: () => transport.resync?.(),
      });
      stopLiveness = alive.stop;
      /**
       * Whether an advertisement is one of ours, when it says.
       *
       * Abstains rather than refuses when it does not: an older build advertises no group, and a
       * platform that surfaces only the local name drops the field entirely. Refusing on a field
       * that may simply not have arrived would make a working fleet invisible to itself.
       */
      const ours = options.group === undefined ? undefined : groupTag(options.group);
      const ourFleet = (advert: BleAdvertisement): boolean => {
        if (ours === undefined) return true;
        const theirs = groupFrom(advert, serviceUuid);
        if (theirs === undefined) return true;
        return theirs.every((byte, at) => byte === ours[at]);
      };
      const seen = discovery(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs });

      closeLink = (hint) => {
        const link = held.get(hint);
        if (link === undefined) return;
        held.delete(hint);
        proven.delete(hint);
        if (link.connectionId !== undefined) byConnection.delete(link.connectionId);
        seen.forget(hint);
        alive.forget(hint);
        link.session.close();
      };

      /**
       * A link handed to the upgrader, remembered under the hint the radio knows it by.
       *
       * The radio fragments below this line, so what comes out of `bleLink` is already whole
       * frames — `upgrade.frames` rather than `upgrade.bytes`, and no length prefix is paid for
       * boundaries the medium already has.
       */
      const hold = (hint: string, connectionId: string | undefined, mtu?: number): Held => {
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
            closeLink(hint);
          },
        };
        // its presence is the role: a link with a connection writes, one without notifies
        if (connectionId !== undefined) Object.assign(wiring, { connectionId });
        const link = bleLink(wiring);
        const session = upgrade.frames(link, {
          onProven: (peer) => void proven.set(hint, peer),
          /**
           * The one ending worth remembering on this medium.
           *
           * BLE cannot ask the door before it dials — four bytes of advertisement name no peer
           * — so a refusal costs a connection, a subscription and a handshake. Remembering it by
           * hint is what stops the *next* advertisement costing the same, which on a radio that
           * sustains six links and runs on a battery is the difference that matters.
           */
          onRefused: () => backoff.failed(hint),
          onClosed: (why) => {
            drop(why);
            closeLink(hint);
          },
        });
        const entry: Held = { link, session, connectionId };
        held.set(hint, entry);
        if (connectionId !== undefined) byConnection.set(connectionId, hint);
        return entry;
      };

      const dial = async (hint: string, peripheralId: string): Promise<void> => {
        const opened = await openConnection(peripheralId, options);
        if (opened.isErr()) {
          drop(`could not dial ${hint}: ${String(opened.error)}`);
          backoff.failed(hint);
          seen.forget(hint); // the next advertisement is a fresh sighting; backoff decides if it dials
          return;
        }
        backoff.succeeded(hint);
        // the MTU is known before the link exists, and has to be: the session's hello is the
        // first thing out, and a link built at the 20-byte floor would fragment it eleven ways
        hold(hint, opened.value.connectionId, opened.value.mtu);
      };

      await radio.publishServices({
        services: [{ uuid: serviceUuid, characteristics: [{ uuid: characteristicUuid }] }],
      });
      await radio.startAdvertising(advertisement(ctx.identity.peerId, serviceUuid, options.group));
      await radio.startScan({ serviceUuids: [serviceUuid] });

      listening.push(
        radio.onScanResult((advert) => {
          const hint = hintFrom(advert, serviceUuid);
          /**
           * What this link is known by: the hint where one arrived, the peripheral id where none
           * did — a backgrounded iPhone announces no readable name (`./sighting.ts`), and keying
           * it by the only identifier it did supply is what keeps it dialable.
           */
          const key = hint ?? advert.peripheralId;
          /**
           * The rungs, named rather than fallen through.
           *
           * Each was a bare `return`, which made every way of finding nobody look the same from
           * outside — see `./sighting.ts`. The order and the short-circuiting are unchanged:
           * `fresh` records as it answers, so a stranger's phone must be refused above it.
           */
          const verdict = judge(hint, self, {
            // said *something*, whether or not we could read it — which is what separates
            // somebody's headphones from an iPhone that has gone quiet behind a lock screen
            announced: () =>
              advert.localName !== undefined || advert.serviceDataBase64 !== undefined,
            // the only refusal this medium has room for: another fleet's phone is not a threat,
            // merely not ours to spend a connection and a handshake on
            ours: () => ourFleet(advert),
            fresh: () => seen.sighted(key, advert.peripheralId),
            mine: () => hint !== undefined && shouldDial(self, hint),
            ready: () => backoff.ready(key),
          });
          options.onSighting?.({ hint, peripheralId: advert.peripheralId, verdict });
          if (verdict !== "dialling" && verdict !== "dialling-unnamed") return;
          void dial(key, advert.peripheralId);
        }),
      );

      listening.push(
        radio.onCharacteristicValueChanged((event) => {
          const hint = byConnection.get(event.connectionId);
          if (hint === undefined) return drop("a notification arrived on no link of ours");
          alive.heard(hint);
          held.get(hint)?.link.accept(event.valueBase64);
        }),
      );

      listening.push(
        radio.onCharacteristicWriteRequested((event) => {
          // the dialled side: whoever wrote is the peer, and this is the first we hear of them.
          // A platform that does not name the central leaves one inbound link the only answer —
          // stated rather than guessed at, because guessing would cross two peers' frames
          const hint = event.centralId ?? onlyInbound();
          if (hint === undefined) return drop("a write arrived and no peer could be named for it");
          const entry = held.get(hint) ?? hold(hint, undefined);
          alive.heard(hint);
          entry.link.accept(event.valueBase64);
        }),
      );

      // one number for every notification this peripheral sends, which is how the platform
      // reports it; a link reads it per send rather than holding a copy that could go stale
      listening.push(
        radio.onSubscribersChanged((event) => {
          notifyLimit = subscriberLimit(event.maximumUpdateValueLength);
        }),
      );

      listening.push(
        radio.onConnectionStateChanged((event) => {
          if (event.state === "connected") return;
          const hint = byConnection.get(event.connectionId);
          if (hint !== undefined) closeLink(hint);
        }),
      );

      /** The one link nobody dialled, when the platform will not say which central wrote. */
      const onlyInbound = (): string | undefined => {
        const inbound = [...held].filter(([, entry]) => entry.connectionId === undefined);
        return inbound.length === 1 ? inbound[0]?.[0] : undefined;
      };
    },
    close: async () => {
      stopLiveness?.();
      stopLiveness = undefined;
      watchAdapter?.();
      watchAdapter = undefined;
      // before the links, and unconditionally: a restart re-subscribes, and a listener left
      // behind by the previous `open` delivers every packet a second time
      for (const off of listening) off();
      listening = [];
      for (const [, entry] of held) entry.session.close();
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
     * The peers with an open session on this radio (E28), so a frame addressed to one of them
     * can be routed here instead of broadcast everywhere.
     *
     * Only peers the handshake proved. A link that has been dialled but has not finished its
     * session is absent, which is correct: it cannot carry a frame yet either.
     */
    reaches: () => new Set(proven.values()),
    /**
     * What the controller sustains before every link degrades, not what any one link costs.
     * RFC-0012 §1's figure, and the reason it is declared here rather than configured: an app
     * that could raise it would be raising it on a radio that cannot honour the number.
     */
    maxLinks: () => options.maxLinks ?? DEFAULT_MAX_LINKS,
    /**
     * Closes one peer's link, by the hint the radio knows it by. `close` forgets the peer with
     * it, so the next advertisement is a fresh sighting rather than one discovery has already
     * seen — which is what makes a dropped peer re-dialable rather than banished.
     */
    drop: (peer) => dropPeer(proven, peer, closeLink),
    /**
     * Look for peers again, because the radio may have come back.
     *
     * **An adapter switching off is not a link ending.** No peer disconnected and no session
     * closed — the medium stopped existing — so nothing in the session layer notices and nothing
     * restarts discovery. A phone whose Bluetooth was toggled off and on therefore never found
     * anybody again until the app was relaunched, which is the same shape as a Wi-Fi drop leaving
     * a socket abandoned rather than closed, and wants the same answer.
     *
     * Stopping before starting is what makes it safe to call on a healthy radio: `stop` forgets
     * every peer and tears down scanning and advertising, so `start` is publishing into a clean
     * state rather than stacking a second scan on a live one. `@syncmesh/ble`'s own radio bridge
     * waits for `poweredOn` before any of it reaches the platform, so calling this while the
     * adapter is still off costs a promise and nothing else.
     */
    wake: () => {
      void reopen?.().catch((cause: unknown) =>
        drop(`the radio would not restart: ${cause instanceof Error ? cause.message : "unknown"}`),
      );
    },
  };
}
