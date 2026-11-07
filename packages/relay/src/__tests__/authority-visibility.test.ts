import type { PeerId } from "@syncmesh/kernel";
import type { Transport } from "@syncmesh/transport";

import { createMemoryEventStore } from "@syncmesh/engine";
import { authorityTables } from "@syncmesh/schema";
import {
  AUTHORITY,
  CATALOG,
  CONSULTS,
  onlyClinics,
  gatedPeer,
  gatedSchema,
  holds,
  idsIn,
  writeCatalog,
  writeConsult,
  type GatedPeer,
} from "@syncmesh/transport/test-fixtures";
import { signEvent } from "@syncmesh/wire";
import { afterEach, describe, expect, test } from "bun:test";

import type { Entitlement, RelayAdmission } from "../admission.js";
import type { RelayRoom } from "../room.js";

import { memoryFanout } from "../fanout.js";
import { hostTuning } from "../serve.js";
import { relayTransport } from "../transport.js";
import { dialTo, openRoom, tick, until } from "./fixtures.js";

/**
 * The authority's own database, as far as these tests need one: which clinics each device belongs
 * to. Mutable, because what D24 guards against is an entitlement that changes under a cursor.
 */
const clinics = new Map<PeerId, readonly string[]>();

const entitlementOf = (peer: PeerId): Entitlement => {
  if (peer === AUTHORITY.peerId) return { scope: "authority", admits: () => true };
  const mine = clinics.get(peer) ?? [];
  return {
    scope: `clinics:${[...mine].sort().join(",")}`,
    admits: (event) => onlyClinics(event, mine),
  };
};

const admission: RelayAdmission = {
  tables: authorityTables(gatedSchema),
  entitle: ({ peer }) => entitlementOf(peer),
};

const running: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const t of running.splice(0)) await t.stop();
  clinics.clear();
});

/** A peer joined to a room through a real `relayTransport`, kept for teardown. */
const attach = async (p: GatedPeer, dial: () => ReturnType<ReturnType<typeof dialTo>["dial"]>) => {
  const transport: Transport = relayTransport({ dial, reconnectMs: 10, maxReconnectMs: 20 });
  running.push(transport);
  await transport.start(p.context);
  await transport.caughtUp?.();
  return transport;
};

const gatedRoom = (overrides: Parameters<typeof openRoom>[0] = {}) =>
  openRoom({ admission, pageSize: 2, maxBacklog: 64, ...overrides });

/** The authority, connected, having written the run every test starts from. */
const seeded = async (room: RelayRoom) => {
  const authority = gatedPeer(7);
  await attach(authority, dialTo(room).dial);
  await writeCatalog(authority, "c1", "aspirin");
  (await writeConsult(authority, "x", "a")).unwrap();
  (await writeConsult(authority, "y", "b")).unwrap();
  await writeCatalog(authority, "c2", "ibuprofen");
  await until(() => room.offset() === 4);
  return authority;
};

describe("visibility: authority — admission at the relay (D24-A)", () => {
  test("devices with the same entitlement are admitted the same set; others see only their own", async () => {
    const room = await gatedRoom();
    const authority = await seeded(room);
    const [a1, a2, b] = [gatedPeer(41), gatedPeer(42), gatedPeer(43)];
    clinics.set(a1.identity.peerId, ["a"]);
    clinics.set(a2.identity.peerId, ["a"]);
    clinics.set(b.identity.peerId, ["b"]);
    await attach(a1, dialTo(room).dial);
    await attach(b, dialTo(room).dial);

    expect(idsIn(a1, CONSULTS)).toEqual(["x"]);
    expect(idsIn(b, CONSULTS)).toEqual(["y"]);
    // the global catalog reaches everyone, gate or no gate
    expect(idsIn(a1, CATALOG)).toEqual(["c1", "c2"]);
    expect(idsIn(b, CATALOG)).toEqual(["c1", "c2"]);

    // live, as well as in catch-up
    (await writeConsult(authority, "z", "a")).unwrap();
    await writeCatalog(authority, "c3", "paracetamol");
    expect(await until(() => holds(a1, CATALOG, "c3") && holds(b, CATALOG, "c3"))).toBe(true);
    expect(idsIn(a1, CONSULTS)).toEqual(["x", "z"]);
    expect(idsIn(b, CONSULTS)).toEqual(["y"]);

    // a second device under the same entitlement, joining later, lands on the same set
    await attach(a2, dialTo(room).dial);
    expect(idsIn(a2, CONSULTS)).toEqual(idsIn(a1, CONSULTS));
    expect(idsIn(a2, CATALOG)).toEqual(idsIn(a1, CATALOG));
    // and both claim the authority's whole run: the gaps are accounted for, not open
    const run = authority.engine.coverage().synced.get(AUTHORITY.peerId);
    expect(a1.engine.coverage().synced.get(AUTHORITY.peerId)).toBe(run);
    expect(a2.engine.coverage().synced.get(AUTHORITY.peerId)).toBe(run);
    expect(b.engine.coverage().synced.get(AUTHORITY.peerId)).toBe(run);
    room.close();
  });

  test("a withheld live event does not stall the author's stream: what follows it folds", async () => {
    const room = await gatedRoom();
    const authority = await seeded(room);
    const b = gatedPeer(43);
    clinics.set(b.identity.peerId, ["b"]);
    const { dial, dials } = dialTo(room);
    await attach(b, dial);

    // a gated row b may not read, then a global one it must: the second sits behind the first
    // in the authority's run, and nothing will ever send b the first
    (await writeConsult(authority, "secret", "a")).unwrap();
    await writeCatalog(authority, "c3", "after the hole");
    expect(await until(() => holds(b, CATALOG, "c3"), 2000)).toBe(true);
    expect(holds(b, CONSULTS, "secret")).toBe(false);
    // folded on the live path — a re-join would have recovered it too, and hidden the stall
    expect(dials()).toBe(1);
    expect(b.engine.coverage().synced.get(AUTHORITY.peerId)).toBe(
      authority.engine.coverage().synced.get(AUTHORITY.peerId),
    );
    room.close();
  });

  test("a wait on a write behind a withheld one settles on a row that can be read", async () => {
    const room = await gatedRoom();
    const authority = gatedPeer(7);
    const writer = await attach(authority, dialTo(room).dial);
    const b = gatedPeer(43);
    clinics.set(b.identity.peerId, ["b"]);
    const reader = await attach(b, dialTo(room).dial);
    const visibility = (t: Transport) => {
      if (t.visibility === undefined) throw new Error("a relay transport declares visibility");
      return t.visibility;
    };

    (await writeConsult(authority, "secret", "a")).unwrap();
    await writeCatalog(authority, "c3", "after the hole");
    expect(await until(() => (visibility(writer).token()?.offset ?? 0) >= 2)).toBe(true);
    const token = visibility(writer).token();
    if (token === undefined) throw new Error("no token after an ack");
    // c3 must be folded the moment the wait ends, not parked behind `secret` until a pass-over
    expect((await visibility(reader).visibleAt(token)).isOk()).toBe(true);
    expect(holds(b, CATALOG, "c3")).toBe(true);
    expect(holds(b, CONSULTS, "secret")).toBe(false);
    room.close();
  });

  test("an entitlement that changes re-pages the device, so nothing refused before stays skipped", async () => {
    const room = await gatedRoom();
    await seeded(room);
    const b = gatedPeer(43);
    clinics.set(b.identity.peerId, ["b"]);
    const { dial, dials } = dialTo(room);
    await attach(b, dial);
    expect(idsIn(b, CONSULTS)).toEqual(["y"]);

    // the authority's database changed: b now also works at clinic a. Its cursor already stands
    // past x, which the relay withheld from it — keeping that cursor would skip x forever
    clinics.set(b.identity.peerId, ["a", "b"]);
    room.reentitle([b.identity.peerId]);
    expect(await until(() => holds(b, CONSULTS, "x"), 3000)).toBe(true);
    expect(idsIn(b, CONSULTS)).toEqual(["x", "y"]);
    // one redial for the re-entitlement, one for the re-page from nothing
    expect(dials()).toBeGreaterThanOrEqual(2);
    room.close();
  });

  test("the fan-out from another instance passes through the same gate", async () => {
    const fanout = memoryFanout();
    const store = () => createMemoryEventStore();
    const one = await gatedRoom({ fanout, store: store() });
    const two = await gatedRoom({ fanout, store: store() });
    const authority = gatedPeer(7);
    await attach(authority, dialTo(one).dial);
    const b = gatedPeer(43);
    clinics.set(b.identity.peerId, ["b"]);
    await attach(b, dialTo(two).dial);

    (await writeConsult(authority, "x", "a")).unwrap();
    (await writeConsult(authority, "y", "b")).unwrap();
    await writeCatalog(authority, "c1", "aspirin");
    expect(await until(() => holds(b, CATALOG, "c1"))).toBe(true);
    expect(idsIn(b, CONSULTS)).toEqual(["y"]);
    one.close();
    two.close();
  });

  test("a forged write to a gated table is refused by every peer it reaches", async () => {
    const room = await gatedRoom();
    const authority = await seeded(room);
    const a = gatedPeer(41);
    clinics.set(a.identity.peerId, ["a"]);
    await attach(a, dialTo(room).dial);

    // a device that believes itself the authority signs a consult for clinic a: the relay holds
    // no keys and no schema, so it stores and forwards it — the verdict is every receiver's
    const self = gatedPeer(66).identity.peerId;
    const forger = gatedPeer(66, self);
    const forged = (await writeConsult(forger, "forged", "a")).unwrap();
    const forgerLink = relayTransport({ dial: dialTo(room).dial });
    running.push(forgerLink);
    await forgerLink.start(forger.context);
    await forgerLink.caughtUp?.();
    await tick(100);

    expect(signEvent(forged, forger.identity).wire.byteLength).toBeGreaterThan(0);
    expect(holds(a, CONSULTS, "forged")).toBe(false);
    expect(holds(authority, CONSULTS, "forged")).toBe(false);
    // and the device itself was never able to write one through its own validator
    const own = await writeConsult(a, "mine", "a");
    expect(own.isErr() && own.error._tag).toBe("ReadOnlyPartition");
    room.close();
  });

  test("startRelay hands the gate to every room it opens", () => {
    const tuned = hostTuning({ admission }, () => Promise.reject(new Error("unused")));
    expect(tuned.admission).toBe(admission);
  });
});
