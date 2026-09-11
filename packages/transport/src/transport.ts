import type { Engine, Unsubscribe } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { Temporal } from "@syncmesh/temporal";
import type { GrantRegistry, Identity } from "@syncmesh/wire";

import { createHub } from "@syncmesh/engine";
import { TaggedError } from "@syncmesh/result";

import type { Bridge, BridgeOptions } from "./bridge.js";
import type { FrameLink } from "./link.js";
import type { RouteMessage } from "./route-scorer.js";
import type { RouteProfile } from "./route-scorer.js";

import { bridgeFramedLink } from "./bridge.js";

/** Everything a transport needs to run sessions; `createMesh({ transports })` supplies it. */
export interface TransportContext {
  readonly engine: Engine;
  readonly identity: Identity;
  readonly grants: GrantRegistry;
  readonly now?: () => Temporal.Instant;
  readonly onGrantRequest?: BridgeOptions["onGrantRequest"];
  /** Where arriving ephemeral values go (D16); absent, presence frames are ignored. */
  readonly onPresence?: BridgeOptions["onPresence"];
  /**
   * Whether this transport is the one to carry a frame (E28). The mesh supplies it from
   * `pickRoutes`; a transport running without one carries everything, which is what every
   * transport did before link admission existed.
   */
  readonly carries?: (transport: string, message: RouteMessage) => boolean;
}

/**
 * Where a write sits in the log a store-and-forward hop keeps: which log, and how far into it.
 *
 * The lineage half matters as much as the position (RFC-0020 §3.2). An offset alone is a number
 * that means something different in every log, so a hop restarted over a fresh one would confirm
 * a write into a log that never held it. Carrying the lineage makes that case answerable —
 * {@link VisibilityLost} — instead of falsely settled.
 */
export interface VisibilityToken {
  /** The log's lineage id; a relay opened over a new log announces a new one. */
  readonly epoch: string;
  /** The position within *that* lineage. Monotone inside one, meaningless across two. */
  readonly offset: number;
}

/**
 * The log this token names is not the log this device is now reading — a relay restarted over a
 * fresh store, or a token from another room. The write it stands for is untouched: it is in this
 * device's own log, signed, and will be re-offered on the next join. Only the *question* is
 * unanswerable, because the position it asked about no longer exists.
 */
export class VisibilityLost extends TaggedError("VisibilityLost")<{
  /** The lineage the token was minted against. */
  expected: string;
  /** The lineage this device is reading instead — what makes the two logs nameable in a log line. */
  actual: string;
  message: string;
}> {}

/** The caller stopped waiting. The write is unaffected — ask again with a longer deadline. */
export class VisibilityTimeout extends TaggedError("VisibilityTimeout")<{
  offset: number;
  message: string;
}> {}

/**
 * Reading back what you just wrote (RFC-0020 §3.2, N1b). `synced()` answers *did the relay
 * durably take it?*; this answers *can I read it back yet?* — the question a UI asks after a
 * write it wants to draw as settled, and the one a server answers for a caller by handing the
 * token over so the caller can wait for its own device to arrive there.
 *
 * A capability, not an obligation: a radio has no ordered log to name a position in, so it
 * declares none and `mesh.visibility` answers a typed value rather than pretending.
 */
export interface TransportVisibility {
  /** How far this device has been told the log runs, in the lineage it was told under; `undefined` until a session has said. */
  readonly token: () => VisibilityToken | undefined;
  /**
   * Settles once this device has been told about a position at or past the token's, in the same
   * lineage — `VisibilityLost` when the lineage changed (including while waiting), and
   * `VisibilityTimeout` when the caller's deadline passed first. Default deadline 10s.
   */
  readonly visibleAt: (
    token: VisibilityToken,
    options?: { readonly timeoutMs?: number },
  ) => Promise<Result<void, VisibilityLost | VisibilityTimeout>>;
}

/**
 * The two-tier port (D12-A): required `name/start/stop/whenReady`, optional capabilities.
 * An absent capability is a fact about the medium, not a bug.
 */
export interface Transport {
  readonly name: string;
  readonly start: (ctx: TransportContext) => Promise<void>;
  /** Resolves when the medium is usable — or after the force-ready timeout, so a dead network never wedges the mesh. */
  readonly whenReady: () => Promise<void>;
  readonly stop: () => Promise<void>;
  /**
   * How near this source is (RFC-0019): `0` is the device's own storage, `1` a relay, `2` a
   * radio. Lower answers first, and a scope is not empty until the lower numbers have finished —
   * a fast radio that holds nothing must not be what tells the app there is nothing. Default 1.
   */
  readonly priority?: number;
  /**
   * What kind of medium this is, for the route scorer (RFC-0012 §2): direct or relayed, how
   * fast, whether it costs power out of proportion to the bytes it moves, whether its radio is
   * currently down. Read per send rather than declared once, because a radio renegotiates its
   * bandwidth and a dormant one wakes.
   *
   * Absent means {@link ORDINARY_LINK} — which is what a relay is, and why the relay says
   * nothing here.
   */
  readonly route?: () => RouteProfile;
  /**
   * The peers this medium currently has a link to (RFC-0012 §1, E28) — the fact that lets
   * `pickRoutes` choose one link rather than filter a broadcast.
   *
   * Optional, and absent is not "no peers": a medium that cannot enumerate its links says
   * nothing, and every frame keeps reaching it exactly as it does today. A transport that
   * answers must answer completely, because a peer it omits is a peer the mesh stops talking
   * to down this link.
   */
  readonly reaches?: () => ReadonlySet<PeerId>;
  /**
   * How many links this medium sustains at once (RFC-0012 §1, E28) — what {@link admit} spends.
   *
   * Declared by the medium and never configured by the app. It is a property of the radio: a BLE
   * controller degrades every link past roughly six, and an app handed a way to raise that has
   * been handed a way to break the ones it already has. Absent means no limit worth enforcing,
   * which is the honest answer for a relay socket that multiplexes rooms.
   */
  readonly maxLinks?: () => number;
  /**
   * Closes the link to one peer, because the mesh decided this radio is holding more than it
   * sustains (E28). The peer stays discoverable — a drop is a slot reclaimed, not a refusal —
   * and the next advertisement may re-dial it.
   *
   * Present only on a medium that can name its links, which is the same medium that can answer
   * {@link Transport.reaches}. A budget nothing can act on is a number, not a budget.
   */
  readonly drop?: (peer: PeerId) => void;
  /**
   * Resolves when this source has finished its first pass and has nothing more to hand over
   * right now. A transport that cannot tell is settled as soon as it is ready, which is the
   * honest answer for a medium with no end-of-catch-up to report.
   */
  readonly caughtUp?: () => Promise<void>;
  /** Re-requests from the last contiguous position on every open session; the recovery after loss or reconnect. */
  readonly resync?: () => void;
  /**
   * Everything this medium has already taken in is folded and saved. What `mesh.flush()` awaits
   * before a close: a frame that arrived is folded on a queue, and the save at the end of that
   * queue is the one a process exiting would lose. A medium with no queue declares none.
   */
  readonly flush?: () => Promise<void>;
  /** Asks every connected peer for a grant for this device (flow A step ②). */
  readonly requestGrant?: (invite?: string) => void;
  /** Sends one ephemeral value to every open session; dropped, never queued, on a full link. */
  readonly sendPresence?: (wire: Uint8Array) => void;
  /**
   * Offers bytes under their own hash (D18). Absent is a fact about the medium, not a bug: a
   * raw radio says so rather than pretending, and `mesh.blobs` answers `NoSuchCapability`.
   */
  readonly putBlob?: (hash: string, bytes: Uint8Array) => Promise<void>;
  /** Asks for bytes by hash; `undefined` when nobody there holds them, or the deadline passed. */
  readonly fetchBlob?: (hash: string, timeoutMs: number) => Promise<Uint8Array | undefined>;
  /**
   * Naming a position in an ordered log and waiting to reach it (RFC-0020 §3.2). Present only on
   * a medium that has one — a relay room does, a peer-to-peer radio does not.
   */
  readonly visibility?: TransportVisibility;
  readonly onStatus?: (cb: (online: boolean) => void) => Unsubscribe;
  /**
   * Which medium this is, for diagnosis (book ch. 16, 18). Two adapters exist per protocol
   * where two protocols exist — AWDL and Wi-Fi Aware never interoperate — so a merged
   * "p2p-wifi" would hide exactly the fact a mixed fleet must know. Absent is `"unknown"`,
   * which is the honest answer for a transport a test built out of two functions.
   */
  readonly kind?: TransportKind;
  /**
   * Why this medium is not carrying, in terms a person can act on (book ch. 18): a UI can say
   * "Bluetooth is off" rather than drawing a red dot. Present only where the platform tells the
   * truth about its radio; absent, {@link Transport.onStatus} is all anyone knows, and a source
   * that is down reads as `temporarily-unavailable`.
   */
  readonly condition?: () => TransportCondition;
}

/**
 * The medium behind a source. Central and peripheral BLE permissions are separate because the
 * platforms separate them, and a person can hold one without the other.
 */
export type TransportKind =
  | "ble"
  | "lan"
  | "awdl"
  | "wifi-aware"
  | "websocket"
  | "http"
  | "unknown";

/** What a source is doing, or why it is not (book ch. 18). `ok` is the only one that carries. */
export type TransportCondition =
  | "ok"
  | "connecting-failed"
  | "listen-failed"
  | "discovery-failed"
  | "radio-off"
  | "no-permission-central"
  | "no-permission-peripheral"
  | "no-hardware"
  | "backgrounded"
  | "temporarily-unavailable"
  | "unknown";

export interface FrameTransportOptions {
  readonly name: string;
  /** The medium behind this source, for diagnosis; absent reads as `"unknown"` (book ch. 18). */
  readonly kind?: TransportKind;
  /** What this medium says about itself when it is not carrying; absent leaves `onStatus` the only word. */
  readonly condition?: () => TransportCondition;
  /** Discover the medium and `attach` a link per peer found; resolve when discovery is up. */
  readonly open: (
    ctx: TransportContext,
    attach: (link: FrameLink, peer?: PeerId) => Bridge,
  ) => Promise<void> | void;
  readonly close?: () => Promise<void> | void;
  /** Milliseconds before `whenReady` force-resolves. Default 1000. */
  readonly forceReadyAfter?: number;
}

/** Builds a transport from `open`: the base every framed medium extends. Attached links get the full session bridge. */
export function createFrameTransport(options: FrameTransportOptions): Transport {
  const { name, open, close, forceReadyAfter = 1000 } = options;
  const bridges = new Set<Bridge>();
  const status = createHub<boolean>();
  let ready: Promise<void> = Promise.resolve();

  return {
    name,
    ...(options.kind !== undefined && { kind: options.kind }),
    ...(options.condition !== undefined && { condition: options.condition }),
    start: async (ctx) => {
      const attach = (link: FrameLink, peer?: PeerId): Bridge => {
        const bridgeOptions: BridgeOptions = {
          engine: ctx.engine,
          identity: ctx.identity,
          grants: ctx.grants,
        };
        /**
         * Only once both halves are known. A link whose peer has not been named yet carries
         * everything, because narrowing on an unknown addressee would ask the scorer to choose
         * among links it cannot tell apart — and the frame it declined to send is one nobody
         * sends, which is divergence rather than routing.
         */
        if (ctx.carries !== undefined && peer !== undefined) {
          const carries = ctx.carries;
          Object.assign(bridgeOptions, {
            carries: (message: RouteMessage) => carries(name, { ...message, to: peer }),
          });
        }
        if (ctx.now !== undefined) Object.assign(bridgeOptions, { now: ctx.now });
        if (ctx.onGrantRequest !== undefined)
          Object.assign(bridgeOptions, { onGrantRequest: ctx.onGrantRequest });
        if (ctx.onPresence !== undefined)
          Object.assign(bridgeOptions, { onPresence: ctx.onPresence });
        const bridge = bridgeFramedLink(link, bridgeOptions);
        bridges.add(bridge);
        return bridge;
      };
      const opened = Promise.resolve(open(ctx, attach)).then(() => status.emit(true));
      ready = Promise.race([
        opened,
        new Promise<void>((resolve) => void setTimeout(resolve, forceReadyAfter)),
      ]);
      await opened;
    },
    whenReady: () => ready,
    flush: async () => {
      await Promise.all([...bridges].map((bridge) => bridge.flush()));
    },
    resync: () => {
      for (const bridge of bridges) bridge.resync();
    },
    requestGrant: (invite) => {
      for (const bridge of bridges) bridge.requestGrant(invite);
    },
    sendPresence: (wire) => {
      for (const bridge of bridges) bridge.sendPresence(wire);
    },
    stop: async () => {
      for (const bridge of bridges) bridge.close();
      bridges.clear();
      status.emit(false);
      await close?.();
    },
    onStatus: status.subscribe,
  };
}

/** The 20-line transport: one link from `pipe`, bridged. Enough for a relay socket or a loopback end. */
export const linkTransport = (
  name: string,
  pipe: (ctx: TransportContext) => FrameLink | Promise<FrameLink>,
): Transport =>
  createFrameTransport({
    name,
    open: async (ctx, attach) => void attach(await pipe(ctx)),
  });
