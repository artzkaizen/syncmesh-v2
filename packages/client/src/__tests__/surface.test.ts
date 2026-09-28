import type { LinkEvent, Transport } from "@syncmesh/transport";

import { createHub, createMemoryEventStore } from "@syncmesh/engine";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

/**
 * The two read-only members a diagnostic surface needs, and the one feed it subscribes to
 * (gaps 2 and 4).
 *
 * `query` is asserted by its *shape* rather than by what it refuses, because the shape is the
 * design: `run` is the door that authors a signed event and it is not here. What a test can
 * prove is that nobody can reach for it by accident, and that a mesh with no connection says so
 * rather than handing over something that fails later.
 */

const org = partition("org", { roles: ladder("member") });
const team = partition("team", { sealed: true, roles: org.roles });
const schema = () =>
  syncSchema({
    tables: {
      catalog: { columns: { id: t.text().primaryKey(), code: t.text() } },
      books: {
        columns: { id: t.text().primaryKey(), title: t.text() },
        partition: org,
        allow: ({ role }) => ({ $default: role("member") }),
      },
      memos: {
        columns: { id: t.text().primaryKey(), body: t.text() },
        partition: team,
        allow: ({ role }) => ({ $default: role("member") }),
      },
    },
    presence: { cursor: { partition: org, of: { x: t.integer() } } },
  });

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const open = async (transports: readonly Transport[] = []) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: device,
      now: () => T0,
      transports,
    })
  ).unwrap();

/** A medium that does nothing but report link events on demand. */
const reporting = (name: string) => {
  const hub = createHub<LinkEvent>();
  const transport: Transport = {
    name,
    start: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    onLinkEvent: hub.subscribe,
  };
  return {
    transport,
    say: (event: Omit<LinkEvent, "transport" | "at">) =>
      hub.emit({ ...event, transport: name, at: T0 }),
  };
};

describe("mesh.schema — the manifest, enumerable", () => {
  test("names every synced table and where its rows live", async () => {
    const mesh = await open();
    expect(mesh.schema.entries.map((entry) => String(entry.table.name))).toContain("books");
    expect(mesh.schema.entries.find((e) => String(e.table.name) === "books")?.partition).toBe(
      "org",
    );
    await mesh.stop();
  });

  test("says which kinds are sealed, so empty can be told from unreadable", async () => {
    const mesh = await open();
    expect([...mesh.schema.sealedKinds]).toEqual(["team"]);
    expect([...new Set(mesh.schema.entries.map((entry) => entry.partition))]).toEqual([
      "global",
      "org",
      "team",
    ]);
    expect(mesh.schema.presence.map((topic) => topic.name)).toEqual(["cursor"]);
    await mesh.stop();
  });
});

describe("mesh.query — the door that cannot write", () => {
  test("reads, and has no `run` beside it to reach for", async () => {
    const mesh = await open();
    const rows = await mesh.query!("SELECT COUNT(*) FROM syncmesh.events");

    expect(rows[0]?.[0]).toBe(0);
    // the shape is the design: the only SQL door that authors events is `mesh.on().db`, whose
    // proxy turns an insert, update or delete into a signed event
    expect(Object.hasOwn(mesh, "run")).toBe(false);
    expect(Object.getOwnPropertyNames(mesh.query!)).not.toContain("run");
    await mesh.stop();
  });

  test("a mesh over a bare event store reports `undefined`, not an empty reader", async () => {
    const mesh = (
      await createMesh({
        schema: schema(),
        identity: device,
        store: createMemoryEventStore(),
        now: () => T0,
      })
    ).unwrap();

    expect(mesh.query).toBeUndefined();
    // the schema is still there: a manifest needs no connection
    expect(mesh.schema.entries.length).toBeGreaterThan(0);
    await mesh.stop();
  });
});

describe("mesh.transports.onLinkEvent — one subscription, whatever the radios do", () => {
  test("carries every medium's link events into one feed", async () => {
    const ble = reporting("ble");
    const mesh = await open([ble.transport]);
    const seen: LinkEvent[] = [];
    const off = mesh.transports.onLinkEvent((event) => void seen.push(event));

    ble.say({ kind: "refused", why: "the door did not admit this peer" });
    expect(seen.map((event) => [event.transport, event.kind])).toEqual([["ble", "refused"]]);

    off();
    ble.say({ kind: "closed", why: "gone" });
    expect(seen).toHaveLength(1);
    await mesh.stop();
  });

  test("follows the set: a medium added afterwards reaches an existing subscription", async () => {
    const mesh = await open();
    const seen: LinkEvent[] = [];
    mesh.transports.onLinkEvent((event) => void seen.push(event));

    const lan = reporting("lan");
    (await mesh.transports.add(lan.transport)).unwrap();
    lan.say({ kind: "dropped", why: "a frame arrived before the session was open" });

    // the bug `$status.subscribe` still has, not repeated here
    expect(seen.map((event) => event.transport)).toEqual(["lan"]);

    await mesh.transports.remove("lan");
    lan.say({ kind: "closed", why: "gone" });
    expect(seen).toHaveLength(1); // removed means let go of, not merely unrouted
    await mesh.stop();
  });
});
