import type { RelayDial } from "@syncmesh/relay";

import { sqlite } from "@syncmesh/client";
import { createMesh } from "@syncmesh/client/internal";
import { tableDigests } from "@syncmesh/engine";
import { seed } from "@syncmesh/kernel/test-fixtures";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, createPlaintextVault } from "@syncmesh/wire";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { relayRivetActor } from "../host.js";
import { closeReason } from "../socket.js";
import { rivetActor, rivetDbOver } from "./actor.js";

const notes = sqliteTable("notes", { id: text().primaryKey(), body: text().notNull() });
const org = partition("org", { roles: ladder("member") });
const schema = () =>
  syncSchema({
    tables: {
      notes: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: org,
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
  });

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
// the room's key beside its log, kept plaintext here: these tests are about the actor (N26)
const vault = createPlaintextVault();
type Dial = () => Promise<RelayDial> | RelayDial;

const until = async (check: () => Promise<boolean>, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return check();
};

/** One device on a room, ungranted: the schema is the only check a host test needs. */
const device = async (dial: Dial, n: number) =>
  (
    await createMesh({
      schema: schema(),
      identity: createIdentity(seed(n)).unwrap(),
      now: () => T0,
      transports: [relayTransport({ dial, reconnectMs: 20 })],
      storage: sqlite({ driver: bunSqliteDriver(":memory:") }),
    })
  ).unwrap();

type Device = Awaited<ReturnType<typeof device>>;
const count = async (mesh: Device) =>
  (await mesh.on("org:acme").unwrap().db.select().from(notes)).length;

/**
 * Two devices write into one room, serialised so the digests do not depend on which frame won a
 * race, and each ends up holding both writes — the scenario every host test in the repo runs.
 */
const converge = async (dial: Dial) => {
  const a = await device(dial, 7);
  const b = await device(dial, 160);
  await Promise.all([a.ready(), b.ready()]);
  await a.on("org:acme").unwrap().db.insert(notes).values({ id: "n1", body: "from a" });
  const arrived = await until(async () => (await count(b)) === 1);
  await b.on("org:acme").unwrap().db.insert(notes).values({ id: "n2", body: "from b" });
  const both =
    arrived && (await until(async () => (await count(a)) === 2 && (await count(b)) === 2));
  const digests = { a: tableDigests(a.engine.state()), b: tableDigests(b.engine.state()) };
  await a.stop();
  await b.stop();
  return { both, digests };
};

/** What the room says about itself over plain HTTP, as JSON. */
const described = async (response: Response) =>
  // SAFETY: `describeRoom` answers this map as JSON when the request does not ask for CBOR
  (await response.json()) as { room: string; relay: string; epoch: string };

describe("the room in a Rivet actor (D09-C, E25)", () => {
  test("a phone cannot tell an embedded relay from a Rivet actor", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-rivet-host-"));
    const actor = rivetActor(
      new Database(":memory:"),
      relayRivetActor({ vault, keepaliveMs: 60_000, pageSize: 2 }),
      ["acme"],
    );
    const relay = await startRelay(0, { dataDir, keepaliveMs: 60_000, pageSize: 2 });
    try {
      const embedded = await converge(webSocketDial(relay.url));
      const rivet = await converge(() => actor.dial());
      expect(embedded.both).toBe(true);
      expect(rivet.both).toBe(true);
      expect(rivet.digests.a).toEqual(embedded.digests.a);
      expect(rivet.digests.b).toEqual(embedded.digests.b);
      expect(rivet.digests.a).toEqual(rivet.digests.b);
    } finally {
      await relay.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("an actor that sleeps wakes as the same room: same key, same lineage, same log", async () => {
    const actor = rivetActor(
      new Database(":memory:"),
      relayRivetActor({ vault, keepaliveMs: 60_000 }),
      ["acme"],
    );
    const ask = new Request("http://rivet.local/actors/room/http/");
    const before = await described(await actor.describe(ask));
    expect(before.room).toBe("acme");

    const { both } = await converge(() => actor.dial());
    expect(both).toBe(true);
    actor.sleep();

    const after = await described(await actor.describe(ask));
    expect(after.relay).toBe(before.relay);
    expect(after.epoch).toBe(before.epoch);
    // a phone arriving after the nap is paged what the room held before it
    const late = await device(() => actor.dial(), 99);
    await late.ready();
    expect(await until(async () => (await count(late)) === 2)).toBe(true);
    await late.stop();
  }, 30_000);

  test("the posture is asked with the upgrade request in hand, before the room is", async () => {
    const actor = rivetActor(
      new Database(":memory:"),
      relayRivetActor({ vault, posture: { allowedOrigins: ["https://app.example"] } }),
      ["acme"],
    );
    const from = (origin: string) =>
      new Request("http://rivet.local/actors/room/websocket/", { headers: { origin } });

    let closed = false;
    const refused = actor.dial(from("https://evil.example"));
    refused.onClose(() => void (closed = true));
    expect(await until(() => Promise.resolve(closed))).toBe(true);
    expect(actor.closeCodes).toEqual([1008]);

    let spoke = false;
    const admitted = actor.dial(from("https://app.example"));
    admitted.onFrame(() => void (spoke = true));
    expect(await until(() => Promise.resolve(spoke))).toBe(true);
    admitted.close();
  });

  test("a socket handed over without its upgrade request is refused when a posture is set", async () => {
    const actor = rivetActor(
      new Database(":memory:"),
      relayRivetActor({ vault, posture: { verifyJoin: () => true } }),
      ["acme"],
    );
    let closed = false;
    let spoke = false;
    const bare = actor.dial();
    bare.onClose(() => void (closed = true));
    bare.onFrame(() => void (spoke = true));
    expect(await until(() => Promise.resolve(closed))).toBe(true);
    expect(spoke).toBe(false);
  });

  test("the room's socket cap holds with or without the upgrade request", async () => {
    const actor = rivetActor(
      new Database(":memory:"),
      relayRivetActor({ vault, limits: { maxRoomConnections: 1 } }),
      ["acme"],
    );
    let spoke = false;
    const first = actor.dial();
    first.onFrame(() => void (spoke = true));
    expect(await until(() => Promise.resolve(spoke))).toBe(true);

    let closed = false;
    const second = actor.dial();
    second.onClose(() => void (closed = true));
    expect(await until(() => Promise.resolve(closed))).toBe(true);
    first.close();
  });

  test("a full room closes a socket with try-again-later, with its request or without", async () => {
    const actor = rivetActor(
      new Database(":memory:"),
      relayRivetActor({
        vault,
        posture: { allowedOrigins: ["https://app.example"] },
        limits: { maxRoomConnections: 1 },
      }),
      ["acme"],
    );
    const upgrade = new Request("http://rivet.local/actors/room/websocket/", {
      headers: { origin: "https://app.example" },
    });
    let spoke = false;
    const first = actor.dial(upgrade);
    first.onFrame(() => void (spoke = true));
    expect(await until(() => Promise.resolve(spoke))).toBe(true);

    let closed = false;
    const second = actor.dial(upgrade);
    second.onClose(() => void (closed = true));
    expect(await until(() => Promise.resolve(closed))).toBe(true);
    // 1013, not the posture's 1008: a seat may be free on the next dial
    expect(actor.closeCodes).toEqual([1013]);
    first.close();
  });

  test("a socket that closes while its room is opening holds no seat", async () => {
    const actor = rivetActor(
      new Database(":memory:"),
      relayRivetActor({ vault, limits: { maxRoomConnections: 1 } }),
      ["acme"],
    );
    actor.dial().close(); // gone before the cold actor has opened its SQLite
    await new Promise((resolve) => setTimeout(resolve, 200));

    let spoke = false;
    const next = actor.dial();
    next.onFrame(() => void (spoke = true));
    expect(await until(() => Promise.resolve(spoke))).toBe(true);
    expect(actor.closeCodes).toEqual([]);
    next.close();
  });

  test("an instance that sleeps while its room is opening does not stay cached", async () => {
    const relay = relayRivetActor({ vault });
    const base = rivetDbOver(new Database(":memory:"));
    let queries = 0;
    const db = {
      ...base,
      execute: (...args: Parameters<typeof base.execute>) => {
        queries += 1;
        return base.execute(...args);
      },
    };
    const ask = (abortSignal: AbortSignal) =>
      relay.onRequest(
        { actorId: "actor-1", key: ["acme"], db, abortSignal },
        new Request("http://rivet.local/"),
      );
    const asleep = new AbortController();
    const opening = ask(asleep.signal);
    asleep.abort(); // the instance sleeps before the open it started has finished
    expect((await opening).status).toBe(200);

    // woken under the same id, it opens its room again from SQLite instead of reusing the old one
    queries = 0;
    expect((await ask(new AbortController().signal)).status).toBe(200);
    expect(queries).toBeGreaterThan(0);
  });

  test("a room that cannot open closes its socket, and the failure still surfaces", async () => {
    const codes: (number | undefined)[] = [];
    const broken = new Error("disk gone");
    const opening = relayRivetActor({ vault }).onWebSocket(
      {
        actorId: "actor-broken",
        key: ["acme"],
        db: { execute: () => Promise.reject(broken), transaction: () => Promise.reject(broken) },
        abortSignal: new AbortController().signal,
      },
      {
        readyState: 1,
        send: () => {},
        close: (code) => void codes.push(code),
        addEventListener: () => {},
      },
    );
    const failure = await opening.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBe(broken);
    expect(codes).toEqual([1011]);
  });
});

describe("closeReason", () => {
  test("cuts on a whole character within the close frame's 123 bytes", () => {
    const reason = closeReason("é".repeat(100));
    expect(new TextEncoder().encode(reason).byteLength).toBeLessThanOrEqual(123);
    expect(reason).toBe("é".repeat(61));
    expect(closeReason("short")).toBe("short");
  });
});

describe("the room's key at rest (N26)", () => {
  test("an actor given no vault is a definition error", () => {
    // @ts-expect-error -- the type requires a vault; this is the plain-JavaScript caller
    expect(() => relayRivetActor({})).toThrow("pass `vault`");
  });
});
