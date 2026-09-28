import { describe, expect, test } from "bun:test";

import type { LinkEvent } from "../link-events.js";

import { loopbackPair } from "../link.js";
import { peer } from "../test-fixtures/index.js";
import { createFrameTransport } from "../transport.js";

/**
 * Link-level failure, said out loud (gap 2).
 *
 * The refusal is the case worth holding: before this, a device could be refused by every peer it
 * met and nothing on it said so — `onStatus` reports the radio, and the radio is fine. Every
 * assertion here is about a fact that already existed inside the upgrader and had nowhere to go.
 */

/** Two ends of one loopback, each upgraded by its own transport; `admits` is the door under test. */
const room = (admits?: () => Promise<boolean>) => {
  const pair = loopbackPair();
  const peers = [peer(11, "acct"), peer(12, "acct")];
  const seen: LinkEvent[][] = [[], []];
  const ends = [pair.a, pair.b];
  const transports = ends.map((end, i) =>
    createFrameTransport({
      name: `loopback:${String(i)}`,
      open: (_ctx, _attach, upgrade) => void upgrade.frames(end),
    }),
  );
  for (const [i, transport] of transports.entries())
    transport.onLinkEvent?.((event) => void seen[i]?.push(event));

  const start = async () => {
    await Promise.all(
      transports.map((transport, i) =>
        transport.start({
          ...peers[i]!.context,
          ...(admits !== undefined && { admits }),
        }),
      ),
    );
  };
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) {
      await pair.control.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const stop = async () => {
    await Promise.all(transports.map((transport) => transport.stop()));
  };
  return { pair, peers, seen, transports, start, settle, stop };
};

const kinds = (events: readonly LinkEvent[]) => events.map((event) => event.kind);

describe("a transport says what happened to its links", () => {
  test("a refusal is reported, with who was refused and on which medium", async () => {
    const here = room(async () => false);
    await here.start();
    await here.settle();

    const refused = here.seen[0]?.find((event) => event.kind === "refused");
    expect(refused).toBeDefined();
    // the handshake named them before the door answered, so this is a fact and not an announcement
    expect(refused?.peer).toBe(here.peers[1]!.identity.peerId);
    expect(refused?.transport).toBe("loopback:0");
    expect(refused?.why).toContain("admit");
    // and the close that follows carries the peer too, which is what makes a repeat readable
    const closed = here.seen[0]?.find((event) => event.kind === "closed");
    expect(closed?.peer).toBe(here.peers[1]!.identity.peerId);

    await here.stop();
  });

  test("a link that stands reports the peer it proved, and nothing else", async () => {
    const here = room(async () => true);
    await here.start();
    await here.settle();

    expect(kinds(here.seen[0] ?? [])).toEqual(["proven"]);
    expect(here.seen[0]?.[0]?.peer).toBe(here.peers[1]!.identity.peerId);
    expect(here.seen[0]?.[0]?.why).toBeUndefined();

    await here.stop();
  });

  test("a door that says nothing reports a proved link and no refusal", async () => {
    const here = room();
    await here.start();
    await here.settle();

    expect(kinds(here.seen[1] ?? [])).toEqual(["proven"]);

    await here.stop();
  });

  test("a frame that never became a link is a drop, and names nobody", async () => {
    const pair = loopbackPair();
    const here = peer(13, "acct");
    const seen: LinkEvent[] = [];
    const transport = createFrameTransport({
      name: "loopback",
      open: (_ctx, _attach, upgrade) => void upgrade.frames(pair.a),
    });
    transport.onLinkEvent?.((event) => void seen.push(event));
    await transport.start(here.context);

    // nothing upgraded the far end, so what arrives is not a hello and never becomes a session
    pair.b.send(Uint8Array.from([9, 9, 9]));
    await pair.control.flush();

    const dropped = seen.find((event) => event.kind === "dropped");
    expect(dropped).toBeDefined();
    expect(dropped?.peer).toBeUndefined();
    expect(dropped?.why).toBeTruthy();

    await transport.stop();
  });

  test("the adapter's own callbacks still run, after the report", async () => {
    const pair = loopbackPair();
    const peers = [peer(14, "acct"), peer(15, "acct")];
    const heard: string[] = [];
    const ends = [pair.a, pair.b];
    const transports = ends.map((end, i) =>
      createFrameTransport({
        name: `loopback:${String(i)}`,
        open: (_ctx, _attach, upgrade) =>
          void upgrade.frames(end, { onProven: () => void heard.push(`proven:${String(i)}`) }),
      }),
    );
    await Promise.all(transports.map((transport, i) => transport.start(peers[i]!.context)));
    for (let round = 0; round < 6; round += 1) {
      await pair.control.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // reporting is a listener, not a replacement: the medium still manages its own paths
    expect(heard.sort()).toEqual(["proven:0", "proven:1"]);
    await Promise.all(transports.map((transport) => transport.stop()));
  });
});
