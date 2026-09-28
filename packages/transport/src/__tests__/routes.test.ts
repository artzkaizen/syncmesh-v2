import type { PeerId } from "@syncmesh/kernel";

import { parsePeerId } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { createRouteTable } from "../routes.js";

const id = (n: string): PeerId => parsePeerId(n.repeat(64).slice(0, 64)).unwrap();
const A = id("a");
const B = id("b");
const C = id("c");
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const table = (self: PeerId, now = () => T0, maxHops?: number) => {
  const options = { self, now };
  if (maxHops !== undefined) Object.assign(options, { maxHops });
  return createRouteTable(options);
};

describe("routes span hops — online means routable (book ch. 17)", () => {
  test("a neighbour's own service is one hop away, and it is what `to` answers with", () => {
    const mine = table(A);
    // B advertises: "I am the authority" — hop 0 from B, so hop 1 from here
    expect(
      mine.learn({ to: "authority", via: B, hops: 0, expiresAt: T0.add({ minutes: 1 }) }),
    ).toBe(true);
    const route = mine.to("authority");
    expect(route?.via).toBe(B);
    expect(route?.hops).toBe(1);
  });

  test("the shorter path wins, and a lost hop hands the question to the other one", () => {
    const mine = table(A);
    const soon = T0.add({ minutes: 1 });
    mine.learn({ to: "authority", via: B, hops: 2, expiresAt: soon });
    mine.learn({ to: "authority", via: C, hops: 0, expiresAt: soon });
    expect(mine.to("authority")?.via).toBe(C); // 1 hop beats 3

    mine.lost(C); // C walked out of range mid-request
    expect(mine.to("authority")?.via).toBe(B);
    mine.lost(B);
    expect(mine.to("authority")).toBeUndefined(); // a dead zone, said plainly
  });

  test("a route ages out rather than being believed forever", () => {
    let clock = T0;
    const mine = table(A, () => clock);
    mine.learn({ to: "authority", via: B, hops: 0, expiresAt: T0.add({ seconds: 30 }) });
    expect(mine.to("authority")).toBeDefined();

    clock = T0.add({ minutes: 5 });
    expect(mine.to("authority")).toBeUndefined();
    expect(mine.all()).toEqual([]);
  });

  test("the radius is bounded: past the hop limit an advertisement is dropped, not forwarded", () => {
    const mine = table(A, () => T0, 2);
    const far = { to: "authority", via: B, hops: 2, expiresAt: T0.add({ minutes: 1 }) };
    // 2 hops beyond B is 3 from here, past a limit of 2 — a room, not a network
    expect(mine.learn(far)).toBe(false);
    expect(mine.to("authority")).toBeUndefined();
  });

  test("what it advertises names itself as the next hop, and never goes back the way it came", () => {
    const mine = table(A);
    mine.serve("authority");
    mine.learn({ to: "ward", via: B, hops: 0, expiresAt: T0.add({ minutes: 1 }) });

    const toC = mine.advertise(C);
    expect(toC).toEqual([
      { to: "authority", via: A, hops: 0, expiresAt: expect.anything() },
      { to: "ward", via: A, hops: 1, expiresAt: expect.anything() },
    ]);

    // back to B, the route B taught us is withheld: the split horizon
    expect(mine.advertise(B).map((ad) => ad.to)).toEqual(["authority"]);
  });

  test("a service this device answers for is never learned from somebody else", () => {
    const mine = table(A);
    mine.serve("authority");
    expect(
      mine.learn({ to: "authority", via: B, hops: 0, expiresAt: T0.add({ minutes: 1 }) }),
    ).toBe(false);
  });
});
