import { describe, expect, test } from "bun:test";

import type { FrameLink } from "../link.js";

import { KIND } from "../frame-parts.js";
import { loopbackPair } from "../link.js";
import { createPeerSessions } from "../peer-session.js";
import { peer } from "../test-fixtures/index.js";

const PEER = peer(40, "acct_a").identity.peerId;

/** A link that records what went down it, can be made to refuse, and can be delivered to. */
const recorder = () => {
  const sent: Uint8Array[] = [];
  const listeners = new Set<(frame: Uint8Array) => void>();
  const link = {
    sent,
    refuse: false,
    send: (frame: Uint8Array) => {
      if (link.refuse) throw new Error("this link is not carrying");
      sent.push(frame);
    },
    onFrame: (cb: (frame: Uint8Array) => void) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    deliver: (frame: Uint8Array) => {
      for (const cb of listeners) cb(frame);
    },
    close: () => listeners.clear(),
  };
  return link;
};

/** A frame of a given class and size; the class is the first CBOR element, as on the wire. */
const frameOf = (cls: number, bytes: number): Uint8Array =>
  Uint8Array.from([0x82, cls, ...new Array<number>(Math.max(bytes - 2, 0)).fill(0)]);

/** A bridge stand-in: the session's job is which link a frame leaves on, not what a bridge does. */
const stubBridge = (link: FrameLink) => {
  const heard: Uint8Array[] = [];
  link.onFrame((frame) => void heard.push(frame));
  let closed = false;
  return {
    heard,
    closed: () => closed,
    link,
    bridge: {
      resync: () => undefined,
      requestSnapshot: () => undefined,
      requestGrant: () => undefined,
      sendGrant: () => undefined,
      sendPresence: () => undefined,
      onError: () => () => undefined,
      flush: () => Promise.resolve(),
      close: () => void (closed = true),
    },
  };
};

describe("one session per peer, not one per link (book ch. 16)", () => {
  test("a second medium joins the conversation instead of starting one", () => {
    const sessions = createPeerSessions();
    const radio = recorder();
    const wifi = recorder();
    let built = 0;
    const build = (link: FrameLink) => {
      built += 1;
      return stubBridge(link).bridge;
    };

    sessions.join(
      PEER,
      { id: "ble", link: radio, route: () => ({ direct: true, bandwidthBps: 24_000 }) },
      build,
    );
    sessions.join(
      PEER,
      { id: "lan", link: wifi, route: () => ({ direct: true, bandwidthBps: 20_000_000 }) },
      build,
    );

    expect(built).toBe(1); // one conversation, whatever it is carried on
    expect(sessions.peers()).toEqual([PEER]);
    expect(sessions.get(PEER)?.carriers()).toEqual(["ble", "lan"]);
  });

  test("the scorer picks per frame: a snapshot page takes the wide link, presence the cheap one", () => {
    const sessions = createPeerSessions();
    const radio = recorder();
    const wifi = recorder();
    let mux: FrameLink | undefined;
    sessions.join(
      PEER,
      { id: "ble", link: radio, route: () => ({ direct: true, bandwidthBps: 24_000 }) },
      (link) => {
        mux = link;
        return stubBridge(link).bridge;
      },
    );
    sessions.join(
      PEER,
      {
        id: "lan",
        link: wifi,
        route: () => ({ direct: true, bandwidthBps: 20_000_000, costly: true }),
      },
      () => {
        throw new Error("a second bridge was built");
      },
    );

    // 64 KB of snapshot: twenty-one seconds on the radio, a blink on the wide link
    mux?.send(frameOf(KIND.snapshot, 64 * 1024));
    expect(wifi.sent).toHaveLength(1);
    expect(radio.sent).toHaveLength(0);

    // a 40-byte presence value is not worth waking an expensive radio for
    mux?.send(frameOf(KIND.presence, 40));
    expect(radio.sent).toHaveLength(1);
    expect(wifi.sent).toHaveLength(1);
  });

  test("a link that refuses is not the end of the conversation", () => {
    const sessions = createPeerSessions();
    const radio = recorder();
    const wifi = recorder();
    let mux: FrameLink | undefined;
    sessions.join(
      PEER,
      { id: "lan", link: wifi, route: () => ({ direct: true, bandwidthBps: 20_000_000 }) },
      (link) => {
        mux = link;
        return stubBridge(link).bridge;
      },
    );
    sessions.join(
      PEER,
      { id: "ble", link: radio, route: () => ({ direct: true, bandwidthBps: 24_000 }) },
      () => {
        throw new Error("a second bridge was built");
      },
    );

    wifi.refuse = true;
    mux?.send(frameOf(KIND.event, 100));
    // the frame left down the other link rather than being lost, which is what divergence is
    expect(radio.sent).toHaveLength(1);
  });

  test("frames from every link reach the one bridge, and are not asked which link they came on", () => {
    const sessions = createPeerSessions();
    const radio = recorder();
    const wifi = recorder();
    let seen: ReturnType<typeof stubBridge> | undefined;
    sessions.join(PEER, { id: "ble", link: radio }, (link) => {
      seen = stubBridge(link);
      return seen.bridge;
    });
    sessions.join(PEER, { id: "lan", link: wifi }, () => {
      throw new Error("a second bridge was built");
    });

    radio.deliver(frameOf(KIND.event, 10));
    wifi.deliver(frameOf(KIND.event, 12));
    expect(seen?.heard).toHaveLength(2);
  });

  test("losing one link is a link lost; losing the last is the conversation over", () => {
    const sessions = createPeerSessions();
    const radio = recorder();
    const wifi = recorder();
    let seen: ReturnType<typeof stubBridge> | undefined;
    const leaveRadio = sessions.join(PEER, { id: "ble", link: radio }, (link) => {
      seen = stubBridge(link);
      return seen.bridge;
    });
    const leaveWifi = sessions.join(PEER, { id: "lan", link: wifi }, () => {
      throw new Error("a second bridge was built");
    });

    leaveRadio();
    expect(seen?.closed()).toBe(false); // still reachable: the bridge has nothing to recover from
    expect(sessions.get(PEER)?.carriers()).toEqual(["lan"]);

    leaveWifi();
    expect(seen?.closed()).toBe(true);
    expect(sessions.get(PEER)).toBeUndefined();
    // and the next link rebuilds it from the cursors, which is the recovery a reconnect uses
    expect(sessions.peers()).toEqual([]);
  });

  test("a send with no link left says so, rather than dropping the frame quietly", () => {
    const sessions = createPeerSessions();
    const pair = loopbackPair();
    let mux: FrameLink | undefined;
    const leave = sessions.join(PEER, { id: "lan", link: pair.a }, (link) => {
      mux = link;
      return stubBridge(link).bridge;
    });
    const send = mux;
    leave();
    expect(() => send?.send(frameOf(KIND.event, 8))).toThrow("did not leave");
  });
});
