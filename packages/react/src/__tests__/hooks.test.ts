import "./dom.js";
import type { Engine } from "@syncmesh/engine";

import { meshDrizzle } from "@syncmesh/drizzle";
import {
  createEngine,
  createMemoryEventStore,
  createValidator,
  openEngine,
} from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { openStores } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { gt } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useCan } from "../use-can.js";
import { useLiveQuery } from "../use-live-query.js";
import { usePresence } from "../use-presence.js";

const jobs = sqliteTable("jobs", {
  id: text().primaryKey(),
  title: text().notNull(),
  rank: integer().notNull(),
});
const schema = defineSchema({
  partitions: { org: {} },
  roles: { org: ["member"] },
  tables: {
    jobs: {
      columns: { id: t.text().primaryKey(), title: t.text(), rank: t.integer() },
      partition: "org",
      allow: ({ role }) => ({ $default: role("member") }),
    },
  },
});
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();

const open = async () => {
  const driver = bunSqliteDriver(":memory:");
  const stores = (await openStores(driver, { tables: [schema.tables.jobs] })).unwrap();
  const validate = createValidator({ schema, grantFor: null });
  const engine = (
    await openEngine({
      peerId: device.peerId,
      clock: createHlcClock({ now: () => T0 }),
      store: stores.events,
      stateStore: stores.state,
      validate,
      atomic: (fn) => stores.atomic(fn),
    })
  ).unwrap();
  const handle = meshDrizzle({ engine, validate, driver, schema, partition: ACME });
  return { engine, handle };
};

/** Mounts an element and returns the root plus a settle that flushes effects and async updates. */
const mount = async (element: Parameters<Root["render"]>[0]) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(element));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 15)));
  await settle();
  return { root, container, settle };
};

describe("useLiveQuery", () => {
  test("rows arrive, one render per change, none for an untouched result, and a changed filter re-subscribes", async () => {
    const { handle } = await open();
    await handle.db.insert(jobs).values({ id: "j1", title: "one", rank: 1 });
    const renders: string[] = [];
    let raise: () => void = () => undefined;
    const List = () => {
      const [floor, setFloor] = useState(0);
      raise = () => setFloor(2);
      const { data, isPending } = useLiveQuery({
        key: `jobs>${floor}`,
        live: () =>
          handle.live(
            handle.db
              .select({ id: jobs.id })
              .from(jobs)
              .where(gt(jobs.rank, floor))
              .orderBy(jobs.id),
          ),
        settled: () => Promise.resolve(),
      });
      renders.push(`${isPending ? "…" : data.map((r) => r.id).join(",")}@${floor}`);
      return null;
    };
    const { settle } = await mount(createElement(List));
    expect(renders.at(-1)).toBe("j1@0");

    await act(async () => {
      await handle.db.insert(jobs).values({ id: "j2", title: "two", rank: 3 });
    });
    await settle();
    expect(renders.at(-1)).toBe("j1,j2@0");
    const before = renders.length;

    // an update that leaves this result unchanged renders nothing
    await act(async () => {
      await handle.db.insert(jobs).values({ id: "j0", title: "zero", rank: 0 });
    });
    await settle();
    expect(renders.length).toBe(before);

    // a changed filter is a changed key: fresh subscription, fresh rows
    await act(async () => raise());
    await settle();
    expect(renders.at(-1)).toBe("j2@2");
  });
});

describe("useCan", () => {
  test("flips the moment a grant registers", async () => {
    const listeners = new Set<() => void>();
    let allowed = false;
    const mesh = {
      can: () => allowed,
      grants: {
        onRegistered: (listener: () => void) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      },
    };
    const seen: boolean[] = [];
    const Button = () => {
      seen.push(useCan(mesh, "jobs.insert"));
      return null;
    };
    await mount(createElement(Button));
    expect(seen.at(-1)).toBe(false);
    await act(async () => {
      allowed = true;
      for (const listener of listeners) listener();
    });
    expect(seen.at(-1)).toBe(true);
  });
});

describe("the done-when", () => {
  test("200 live queries, a 5,000-event catch-up, one render each", async () => {
    const { engine, handle } = await open();
    const counts = Array.from({ length: 200 }, () => 0);
    const Item = ({ index }: { readonly index: number }) => {
      counts[index] = (counts[index] ?? 0) + 1;
      useLiveQuery({
        key: `jobs>${index}`,
        live: () =>
          handle.live(
            handle.db
              .select({ id: jobs.id })
              .from(jobs)
              .where(gt(jobs.rank, index))
              .orderBy(jobs.id),
          ),
        settled: () => Promise.resolve(),
      });
      return null;
    };
    const { settle } = await mount(
      createElement(
        "div",
        null,
        ...Array.from({ length: 200 }, (_, index) => createElement(Item, { index, key: index })),
      ),
    );
    const afterMount = [...counts];

    // another author's 5,000 events arrive as one batch
    const author = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 140 + i)).unwrap();
    let ms = 100;
    const remote: Engine = createEngine({
      peerId: author.peerId,
      clock: createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms++) }),
      store: createMemoryEventStore(),
      validate: createValidator({ schema, grantFor: null }),
    });
    /* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures; names are brands over these strings */
    for (let i = 0; i < 5000; i += 1) {
      (
        await remote.mutate(
          "jobs.insert" as never,
          (tx) =>
            tx.insert(
              "jobs" as never,
              `r${i}` as never,
              new Map([
                ["id" as never, `r${i}`],
                ["title" as never, `t${i}`],
                ["rank" as never, (i % 400) as never],
              ]) as never,
            ),
          { partition: ACME },
        )
      ).unwrap();
    }
    /* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
    const entries = (await remote.eventsSince(new Map())).unwrap();
    await act(async () => {
      (await engine.receiveBatch(entries)).unwrap();
    });
    await settle();

    const extra = counts.map((n, i) => n - (afterMount[i] ?? 0));
    expect(Math.max(...extra)).toBe(1); // one fold batch, one render
    expect(Math.min(...extra)).toBe(1); // and every query's rows really changed
  }, 30_000);
});

describe("usePresence", () => {
  test("renders who is here, once per change, and not when the set is unchanged", async () => {
    const listeners = new Set<() => void>();
    let people: readonly { readonly peerId: string; readonly value: { readonly x: number } }[] = [];
    const topic = {
      peers: () => people,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const renders: string[] = [];
    const Cursors = () => {
      const here = usePresence(topic);
      renders.push(here.map((p) => `${p.peerId}@${p.value.x}`).join(","));
      return null;
    };
    await mount(createElement(Cursors));
    expect(renders.at(-1)).toBe("");

    const alice = { peerId: "a", value: { x: 1 } };
    await act(async () => {
      people = [alice];
      notify();
    });
    expect(renders.at(-1)).toBe("a@1");

    // the same entries again: a store that conflated to no change costs no render
    const before = renders.length;
    await act(async () => {
      people = [alice];
      notify();
    });
    expect(renders.length).toBe(before);

    await act(async () => {
      people = [];
      notify();
    });
    expect(renders.at(-1)).toBe("");
  });
});
