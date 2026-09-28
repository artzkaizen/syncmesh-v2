import "./dom.js";
import type { ReactNode } from "react";

import { parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type {
  DevtoolsAck,
  DevtoolsEndingTally,
  DevtoolsLinkEvent,
  DevtoolsMedium,
  DevtoolsPeer,
  DevtoolsRoute,
} from "../contract.js";
import type { LinksSource } from "../panels/link-kit.js";

import { Peers } from "../panels/peers.js";
import { Transports } from "../panels/transports.js";

const id = (hex: string) => parsePeerId(hex.repeat(64).slice(0, 64)).unwrap();
const seq = (value: number) => parseSeqNum(value).unwrap();
const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);

const SELF = id("1");
const ALICE = id("a");
const BOB = id("b");
const NOW = Date.now();

const medium = (over: Partial<DevtoolsMedium>) =>
  ({
    name: "ble",
    kind: "ble",
    condition: "ok",
    online: true,
    maxLinks: undefined,
    priority: 2,
    ...over,
  }) satisfies DevtoolsMedium;

const BLE = medium({});
const RELAY = medium({ name: "relay", kind: "websocket", priority: 1 });

/** Each event in the ring is one ending, which is what the source's own tally counts. */
const countOf = (events: readonly DevtoolsLinkEvent[]) =>
  events.map((event) => ({ transport: event.transport, kind: event.kind, count: 1 }));

interface Fixture {
  readonly mediums: readonly DevtoolsMedium[];
  readonly peers: readonly DevtoolsPeer[];
  readonly silent: readonly string[];
  readonly routes: readonly DevtoolsRoute[];
  readonly recent: readonly DevtoolsLinkEvent[];
  readonly tally: readonly DevtoolsEndingTally[];
  readonly acks: readonly DevtoolsAck[];
  /** This device's own cursor, which is what a peer's ack is measured against. */
  readonly cursor: number;
}

const sourceOf = (fixture: Partial<Fixture>): LinksSource => ({
  links: () => ({
    self: SELF,
    peers: fixture.peers ?? [],
    silent: fixture.silent ?? [],
    routes: fixture.routes ?? [],
    tally: fixture.tally ?? countOf(fixture.recent ?? []),
    recent: fixture.recent ?? [],
  }),
  overview: () => ({
    health: "local-ready",
    mediums: fixture.mediums ?? [],
    handles: { observers: 0, subscriptions: 0, operations: 0, fetches: 0, links: 0 },
    running: true,
    settled: true,
    peers: (fixture.peers ?? []).length,
    grants: 0,
    parked: 0,
  }),
  sync: () => ({
    authors:
      fixture.cursor === undefined
        ? []
        : [{ peer: SELF, cursor: seq(fixture.cursor), ahead: 0, holding: 0 }],
    scope: undefined,
    acks: fixture.acks ?? [],
    parked: [],
  }),
  onChange: () => () => undefined,
});

const mount = (node: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    text: () => container.textContent ?? "",
    /** Every drawn proportion, as the numbers a screen reader would be given. */
    meters: () =>
      [...container.querySelectorAll('[role="meter"]')].map((node) => ({
        now: Number(node.getAttribute("aria-valuenow")),
        max: Number(node.getAttribute("aria-valuemax")),
      })),
    rings: () => container.querySelectorAll("svg circle").length,
    sparklines: () => container.querySelectorAll('[role="img"]').length,
    tags: () => [...container.querySelectorAll("span")].map((node) => node.textContent ?? ""),
    inspect: () => {
      const button = [...container.querySelectorAll("button")].find((candidate) =>
        candidate.getAttribute("aria-label")?.startsWith("Inspect"),
      );
      act(() => button?.click());
    },
    close: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

const drawn = (node: ReactNode) => {
  const panel = mount(node);
  const text = panel.text();
  panel.close();
  return text;
};

const ALICE_ON_BLE = { peer: ALICE, over: ["ble"], ackedAt: undefined } satisfies DevtoolsPeer;
const BOB_SEEN = { peer: BOB, over: [], ackedAt: undefined } satisfies DevtoolsPeer;

describe("the transports panel draws what it can", () => {
  test("the link health ring and one meter per ending kind render over a live window", () => {
    const panel = mount(
      <Transports
        openTab={() => undefined}
        source={sourceOf({
          mediums: [BLE],
          tally: [
            { transport: "ble", kind: "proven", count: 3 },
            { transport: "ble", kind: "refused", count: 1 },
          ],
        })}
      />,
    );
    const text = panel.text();
    const meters = panel.meters();
    const rings = panel.rings();
    panel.close();
    expect(rings).toBeGreaterThan(0);
    expect(text).toContain("75%");
    expect(meters).toContainEqual({ now: 3, max: 4 });
    expect(meters).toContainEqual({ now: 1, max: 4 });
  });

  test("links held is a meter against the medium's own maxLinks, never an invented one", () => {
    const panel = mount(
      <Transports
        openTab={() => undefined}
        source={sourceOf({
          mediums: [medium({ maxLinks: 6 })],
          peers: [ALICE_ON_BLE],
        })}
      />,
    );
    const meters = panel.meters();
    const text = panel.text();
    panel.close();
    expect(meters).toContainEqual({ now: 1, max: 6 });
    expect(text).toContain("1/6");
  });

  test("a medium that cannot enumerate loses its bar and keeps its sentence", () => {
    const fixture = { mediums: [medium({ maxLinks: 6 })] };
    const withBar = mount(<Transports openTab={() => undefined} source={sourceOf(fixture)} />);
    const bars = withBar.meters().length;
    withBar.close();

    const panel = mount(
      <Transports openTab={() => undefined} source={sourceOf({ ...fixture, silent: ["ble"] })} />,
    );
    const text = panel.text();
    const silentBars = panel.meters().length;
    panel.close();

    expect(silentBars).toBe(bars - 1);
    expect(text).toContain("this medium cannot say");
    expect(text).toContain("links not countable");
    expect(text).not.toContain("0 held");
    expect(text).not.toContain("carrying nobody");
  });

  test("a medium that can enumerate and holds nothing says nobody, which is a different claim", () => {
    const text = drawn(
      <Transports openTab={() => undefined} source={sourceOf({ mediums: [RELAY] })} />,
    );
    expect(text).toContain("carrying nobody");
    expect(text).toContain("0 held");
    expect(text).not.toContain("this medium cannot say");
  });

  test("the peer relation is inverted, so each medium lists who it carries as its own tag", () => {
    const text = drawn(
      <Transports
        openTab={() => undefined}
        source={sourceOf({
          mediums: [BLE, RELAY],
          peers: [{ peer: ALICE, over: ["ble", "relay"], ackedAt: undefined }],
        })}
      />,
    );
    expect(text.match(/aaaaaaaa…/gu)).toHaveLength(2);
    expect(text.match(/1 held/gu)).toHaveLength(2);
  });

  test("a medium that cannot enumerate still shows what a session named, and says it may be more", () => {
    const text = drawn(
      <Transports
        openTab={() => undefined}
        source={sourceOf({
          mediums: [RELAY],
          silent: ["relay"],
          peers: [{ peer: ALICE, over: ["relay"], ackedAt: undefined }],
        })}
      />,
    );
    expect(text).toContain("aaaaaaaa…");
    expect(text).toContain("and possibly more");
  });

  test("a medium whose status went false while its condition reads ok is flagged, not left green", () => {
    const text = drawn(
      <Transports
        openTab={() => undefined}
        source={sourceOf({ mediums: [medium({ online: false })] })}
      />,
    );
    expect(text).toContain("offline");
  });

  test("a medium that has never reported a status is not presented as up", () => {
    const text = drawn(
      <Transports
        openTab={() => undefined}
        source={sourceOf({ mediums: [medium({ online: undefined })] })}
      />,
    );
    expect(text).toContain("has not said if it is up");
    expect(text).not.toContain("· up");
  });

  test("no mediums is a sentence about this device, not an empty table", () => {
    const text = drawn(<Transports openTab={() => undefined} source={sourceOf({})} />);
    expect(text).toContain("No mediums");
    expect(text).toContain("it can reach nobody and nobody can reach it");
  });

  test("routes draw their hop count and the endings draw a sparkline with a legend", () => {
    const panel = mount(
      <Transports
        openTab={() => undefined}
        source={sourceOf({
          mediums: [BLE],
          routes: [{ to: BOB, via: ALICE, hops: 2, expiresAt: at(NOW + 60_000) }],
          recent: [
            {
              id: 1,
              kind: "refused",
              transport: "ble",
              peer: BOB,
              why: "the door did not admit this peer",
              at: at(NOW),
            },
          ],
        })}
      />,
    );
    const text = panel.text();
    const meters = panel.meters();
    const sparks = panel.sparklines();
    panel.close();
    expect(sparks).toBeGreaterThan(0);
    expect(meters).toContainEqual({ now: 2, max: 4 });
    expect(text).toContain("refused 1");
    expect(text).toContain("the door did not admit this peer");
    expect(text).toContain("in 1m");
  });

  test("an empty feed says why it may be empty rather than implying a quiet link", () => {
    const text = drawn(
      <Transports openTab={() => undefined} source={sourceOf({ mediums: [BLE] })} />,
    );
    expect(text).toContain("No link events yet");
    expect(text).toContain("silence is not proof of a steady link");
    expect(text).toContain("no endings in the ring");
  });
});

describe("the peers panel draws what it can", () => {
  test("reachability is a ring over proved sessions, with a bar per medium beside it", () => {
    const panel = mount(
      <Peers
        openTab={() => undefined}
        source={sourceOf({ mediums: [BLE], peers: [ALICE_ON_BLE, BOB_SEEN] })}
      />,
    );
    const text = panel.text();
    const meters = panel.meters();
    const rings = panel.rings();
    panel.close();
    expect(rings).toBeGreaterThan(0);
    expect(text).toContain("50%");
    expect(text).toContain("reachable");
    expect(meters).toContainEqual({ now: 1, max: 2 });
  });

  test("lag is a bar scaled to the worst peer and coloured by the age of the ack", () => {
    const panel = mount(
      <Peers
        openTab={() => undefined}
        source={sourceOf({
          mediums: [BLE],
          peers: [ALICE_ON_BLE, { peer: BOB, over: ["ble"], ackedAt: undefined }],
          acks: [
            { peer: ALICE, at: at(NOW - 3_600_000), ours: seq(12), authors: 2 },
            { peer: BOB, at: at(NOW - 2000), ours: seq(38), authors: 2 },
          ],
          cursor: 40,
        })}
      />,
    );
    const text = panel.text();
    const meters = panel.meters();
    panel.close();
    expect(meters).toContainEqual({ now: 28, max: 28 });
    expect(meters).toContainEqual({ now: 2, max: 28 });
    expect(text).toContain("1h");
  });

  test("a peer row names the mediums carrying it, one tag each and never a joined string", () => {
    const panel = mount(
      <Peers
        openTab={() => undefined}
        source={sourceOf({
          mediums: [BLE, RELAY],
          peers: [{ peer: ALICE, over: ["ble", "relay"], ackedAt: undefined }],
        })}
      />,
    );
    const tags = panel.tags();
    panel.close();
    expect(tags).toContain("ble");
    expect(tags).toContain("relay");
    expect(tags).not.toContain("ble, relay");
  });

  test("a peer nothing is carrying is seen only, and gets no lag bar it cannot justify", () => {
    const panel = mount(
      <Peers openTab={() => undefined} source={sourceOf({ mediums: [BLE], peers: [BOB_SEEN] })} />,
    );
    const text = panel.text();
    panel.close();
    expect(text).toContain("seen only");
    expect(text).toContain("never acknowledged");
  });

  test("no peers quotes the mediums' own conditions, because that is where the reason is", () => {
    const text = drawn(
      <Peers
        openTab={() => undefined}
        source={sourceOf({ mediums: [medium({ condition: "radio-off" })] })}
      />,
    );
    expect(text).toContain("No peers");
    expect(text).toContain("ble (radio-off)");
  });

  test("no peers and no mediums says the device has nothing to hear on", () => {
    const text = drawn(<Peers openTab={() => undefined} source={sourceOf({})} />);
    expect(text).toContain("no transport at all");
  });

  test("no peers over an up-but-blind medium explains why nobody is listed yet", () => {
    const text = drawn(
      <Peers
        openTab={() => undefined}
        source={sourceOf({ mediums: [RELAY], silent: ["relay"] })}
      />,
    );
    expect(text).toContain("cannot enumerate their links");
  });

  test("a blind medium gets no share bar on the reachability breakdown either", () => {
    const fixture = {
      mediums: [RELAY],
      peers: [{ peer: ALICE, over: ["relay"], ackedAt: undefined }],
    };
    const withBar = mount(<Peers openTab={() => undefined} source={sourceOf(fixture)} />);
    const bars = withBar.meters().length;
    withBar.close();

    const panel = mount(
      <Peers openTab={() => undefined} source={sourceOf({ ...fixture, silent: ["relay"] })} />,
    );
    const silentBars = panel.meters().length;
    const text = panel.text();
    panel.close();
    expect(silentBars).toBe(bars - 1);
    expect(text).toContain("this medium cannot say");
  });

  test("selecting a peer shows every medium's verdict, its route and its link history", () => {
    const panel = mount(
      <Peers
        openTab={() => undefined}
        source={sourceOf({
          mediums: [BLE, RELAY],
          silent: ["relay"],
          peers: [BOB_SEEN],
          routes: [{ to: BOB, via: ALICE, hops: 2, expiresAt: at(NOW + 120_000) }],
          recent: [
            {
              id: 1,
              kind: "closed",
              transport: "ble",
              peer: BOB,
              why: "out of range",
              at: at(NOW - 5000),
            },
          ],
        })}
      />,
    );
    expect(panel.text()).not.toContain("Reached by");
    panel.inspect();
    const text = panel.text();
    const sparks = panel.sparklines();
    panel.close();
    expect(text).toContain("Reached by");
    expect(text).toContain("not carrying");
    expect(text).toContain("this medium cannot say");
    expect(text).toContain("Reached through");
    expect(text).toContain("out of range");
    expect(text).toContain("closed 1");
    expect(sparks).toBe(1);
  });
});
