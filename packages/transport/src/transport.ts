import type { Engine, Unsubscribe } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { GrantRegistry, Identity } from "@syncmesh/wire";

import { createHub } from "@syncmesh/engine";

import type { Bridge, BridgeOptions } from "./bridge.js";
import type { FrameLink } from "./link.js";

import { bridgeFramedLink } from "./bridge.js";

/** Everything a transport needs to run sessions; `createMesh({ transports })` supplies it (E09). */
export interface TransportContext {
  readonly engine: Engine;
  readonly identity: Identity;
  readonly grants: GrantRegistry;
  readonly now?: () => Temporal.Instant;
  readonly onGrantRequest?: BridgeOptions["onGrantRequest"];
  /** Where arriving ephemeral values go (D16); absent, presence frames are ignored. */
  readonly onPresence?: BridgeOptions["onPresence"];
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
  /** Re-requests from the last contiguous position on every open session; the recovery after loss or reconnect. */
  readonly resync?: () => void;
  /** Asks every connected peer for a grant for this device (flow A step ②). */
  readonly requestGrant?: (invite?: string) => void;
  /** Sends one ephemeral value to every open session; dropped, never queued, on a full link. */
  readonly sendPresence?: (wire: Uint8Array) => void;
  readonly onStatus?: (cb: (online: boolean) => void) => Unsubscribe;
}

export interface FrameTransportOptions {
  readonly name: string;
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
    start: async (ctx) => {
      const attach = (link: FrameLink): Bridge => {
        const bridgeOptions: BridgeOptions = {
          engine: ctx.engine,
          identity: ctx.identity,
          grants: ctx.grants,
        };
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
