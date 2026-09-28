import "./dom.js";
import type { ReadCoverage } from "@syncmesh/client";
import type { Engine } from "@syncmesh/engine";

import { meshDrizzle } from "@syncmesh/drizzle";
import {
  createEngine,
  createMemoryEventStore,
  createValidator,
  openEngine,
} from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { openStores } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { gt } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { act, createElement, useEffect, useState } from "react";

import type { LiveResult } from "../use-live-query.js";
import type { OperationRecord } from "../use-operation.js";
import type { QueryResult } from "../use-query.js";

import { useCan } from "../use-can.js";
import { useLiveQuery } from "../use-live-query.js";
import { useOperation } from "../use-operation.js";
import { usePresence } from "../use-presence.js";
import { useQuery } from "../use-query.js";
import { mount } from "./mount.js";

const jobs = sqliteTable("jobs", {
  id: text().primaryKey(),
  title: text().notNull(),
  rank: integer().notNull(),
});
const org = partition("org", { roles: ladder("member") });
const schema = syncSchema({
  tables: {
    jobs: {
      columns: { id: t.text().primaryKey(), title: t.text(), rank: t.integer() },
      partition: org,
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
        "~mesh": {
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
        },
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

  /**
   * `state` is the rows keyed by primary key and `diff` is what the delivery changed (book
   * ch. 9) — both built once in the subscription layer, so a render that changed nothing hands
   * back the same map, and a fold that added a row names exactly that row.
   */
  test("state is the rows keyed, diff names the delivery, and neither is rebuilt per render", async () => {
    const { handle } = await open();
    await handle.db.insert(jobs).values({ id: "j1", title: "one", rank: 1 });
    let last: LiveResult<{ readonly id: string }> | undefined;
    let rerender: () => void = () => undefined;
    const List = () => {
      const [, bump] = useState(0);
      rerender = () => bump((n) => n + 1);
      last = useLiveQuery({
        "~mesh": {
          key: "jobs-keyed",
          live: () => handle.live(handle.db.select({ id: jobs.id }).from(jobs).orderBy(jobs.id)),
          settled: () => Promise.resolve(),
        },
      });
      return null;
    };
    const { settle } = await mount(createElement(List));
    await settle();
    expect([...(last?.state.keys() ?? [])]).toEqual(["j1"]);
    expect(last?.state.get("j1")).toBe(last?.data[0]);
    expect([...(last?.diff.added.keys() ?? [])]).toEqual(["j1"]);

    const held = last?.state;
    await act(async () => rerender());
    expect(last?.state).toBe(held);

    await act(async () => {
      await handle.db.insert(jobs).values({ id: "j2", title: "two", rank: 3 });
    });
    await settle();
    expect([...(last?.diff.added.keys() ?? [])]).toEqual(["j2"]);
    expect(last?.diff.changed.size).toBe(0);
    // the row the fold did not name is the object it already was, under the same key
    expect(last?.state.get("j1")).toBe(held?.get("j1"));
  });
});

describe("useCan", () => {
  test("flips the moment a grant registers", async () => {
    const listeners = new Set<() => void>();
    let allowed = false;
    // `api.jobs.create.can(input)`, as the hook sees it: a verdict to ask for, and the grant feed
    const rehearsal = {
      key: "jobs.create:{orgId:acme}",
      run: () => Promise.resolve({ isOk: () => allowed }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    const seen: boolean[] = [];
    const Button = () => {
      seen.push(useCan(rehearsal));
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

  /**
   * A rehearsal holds its handle until it rolls back, so one started per render queues every write
   * the screen makes behind it. Before the handle took turns it was worse than waste: a rehearsal
   * still open when an ordinary write committed was committed along with it, and a component that
   * rehearsed `delete` while bumping a counter deleted the row it was showing.
   */
  test("rehearses once per key, however many times the component renders", async () => {
    let runs = 0;
    // `can(input)` builds a fresh descriptor per call, which is what the old dependency list saw
    const descriptor = () => ({
      key: "jobs.delete:{id:1}",
      run: () => {
        runs += 1;
        return Promise.resolve({ isOk: () => true });
      },
      subscribe: () => () => undefined,
    });
    let rerender: () => void = () => undefined;
    const Row = () => {
      const [, bump] = useState(0);
      rerender = () => bump((n) => n + 1);
      useCan(descriptor());
      return null;
    };
    await mount(createElement(Row));
    expect(runs).toBe(1);
    for (let i = 0; i < 5; i += 1) await act(async () => rerender());
    expect(runs).toBe(1);
  });
});

describe("useOperation", () => {
  /**
   * The hook takes one ref — `client.$operations.get(id)` — and hands its record to React
   * (book ch. 10). The ref owns the reading and the identity: a record that reads the same is
   * the same object, so an unrelated commit announcing the ledger costs this view no render.
   */
  test("one subscription per id however many times the component renders, and an unchanged record keeps its identity", async () => {
    const listeners = new Set<() => void>();
    let row: OperationRecord | undefined;
    // `client.$operations.get(id)`, as the hook sees it: an id, the record as last read, a feed
    const ref = {
      id: "op-1",
      status: () => row,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const seen: (OperationRecord | undefined)[] = [];
    let rerender: () => void = () => undefined;
    const Detail = () => {
      const [, bump] = useState(0);
      rerender = () => bump((n) => n + 1);
      seen.push(useOperation(ref));
      return null;
    };

    const { settle } = await mount(createElement(Detail));
    expect(seen.at(-1)).toBeUndefined();
    for (let i = 0; i < 5; i += 1) await act(async () => rerender());
    expect(listeners.size).toBe(1); // one subscription, not one per render

    // the id was watched before the record existed, which is the only interesting case
    await act(async () => {
      row = { id: "op-1", label: "issue.update", status: "applied" };
      notify();
    });
    await settle();
    expect(seen.at(-1)?.status).toBe("applied");

    // the ledger announces with the same record: the store's snapshot is the same object, so
    // React bails out and nothing renders
    const before = seen.length;
    await act(async () => notify());
    await settle();
    expect(seen.length).toBe(before);

    await act(async () => {
      row = { id: "op-1", label: "issue.update", status: "superseded" };
      notify();
    });
    await settle();
    expect(seen.at(-1)?.status).toBe("superseded");
  });

  test("no ref reads nothing and subscribes to nothing", async () => {
    const seen: (OperationRecord | undefined)[] = [];
    const Detail = () => {
      seen.push(useOperation(undefined));
      return null;
    };
    const { settle } = await mount(createElement(Detail));
    await settle();
    expect(seen).toEqual([undefined]);
  });
});

describe("the done-when", () => {
  test("200 live queries, a 5,000-event catch-up, one render each", async () => {
    const { engine, handle } = await open();
    const counts = Array.from({ length: 200 }, () => 0);
    const Item = ({ index }: { readonly index: number }) => {
      counts[index] = (counts[index] ?? 0) + 1;
      useLiveQuery({
        "~mesh": {
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
        },
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

describe("useLiveQuery — coverage names a source (ch. 9)", () => {
  test("local-only, then partial naming the near source, then caught-up naming the far one", async () => {
    const { handle } = await open();
    await handle.db.insert(jobs).values({ id: "j1", title: "one", rank: 1 });

    const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
    const checkpoint = { at: T0, cursors: new Map() };
    let reading: ReadCoverage = { kind: "local-only" };
    const listeners = new Set<() => void>();
    const move = (next: ReadCoverage) => {
      reading = next;
      for (const listener of listeners) listener();
    };

    const seen: string[] = [];
    const Screen = () => {
      const { answered, coverage } = useLiveQuery({
        "~mesh": {
          key: "jobs-all",
          live: () => handle.live(handle.db.select({ id: jobs.id }).from(jobs).orderBy(jobs.id)),
          settled: () => Promise.resolve(),
          coverage: () => reading,
          onCoverage: (listener) => {
            listeners.add(listener);
            return () => void listeners.delete(listener);
          },
        },
      });
      seen.push(
        `${answered}/${coverage.kind}${coverage.kind === "local-only" ? "" : `@${coverage.source}`}`,
      );
      return null;
    };

    const { settle } = await mount(createElement(Screen));
    await settle();
    // the device answered; the world has not — two different facts, and this is where they split
    expect(seen.at(-1)).toBe("settled/local-only");

    await act(async () => move({ kind: "partial", source: "nearby", checkpoint }));
    await settle();
    expect(seen.at(-1)).toBe("settled/partial@nearby");

    await act(async () => move({ kind: "caught-up", source: "internet", checkpoint }));
    await settle();
    expect(seen.at(-1)).toBe("settled/caught-up@internet");

    // an unchanged reading is not a render: the store hands back the same object
    const renders = seen.length;
    await act(async () => move(reading));
    await settle();
    expect(seen.length).toBe(renders);
  });

  test("a call carrying no coverage reads local-only — the honest word for 'nothing here can say more'", async () => {
    const { handle } = await open();
    let kind = "";
    const Screen = () => {
      const { coverage } = useLiveQuery({
        "~mesh": {
          key: "jobs-bare",
          live: () => handle.live(handle.db.select({ id: jobs.id }).from(jobs)),
          settled: () => Promise.resolve(),
        },
      });
      kind = coverage.kind;
      return null;
    };
    const { settle } = await mount(createElement(Screen));
    await settle();
    expect(kind).toBe("local-only");
  });
});

describe("useQuery — the book's dialect (ch. 9)", () => {
  test("disabled with no call, then local, then settled — one field walking the progression", async () => {
    const { handle } = await open();
    await handle.db.insert(jobs).values({ id: "j1", title: "one", rank: 1 });

    let releaseSettled: () => void = () => undefined;
    const settledGate = new Promise<void>((resolve) => {
      releaseSettled = resolve;
    });
    const seen: string[] = [];
    let pick: (on: boolean) => void = () => undefined;
    const Screen = () => {
      const [on, setOn] = useState(false);
      pick = setOn;
      const call = on
        ? {
            "~mesh": {
              key: "jobs-all",
              live: () =>
                handle.live(handle.db.select({ id: jobs.id }).from(jobs).orderBy(jobs.id)),
              settled: () => settledGate,
            },
          }
        : undefined;
      const { data, status, answered, coverage, isEnabled } = useQuery(call);
      seen.push(
        `${status}/${isEnabled ? "on" : "off"}/${answered}/${coverage.kind}/${
          data === undefined ? "∅" : data.map((r) => r.id).join(",")
        }`,
      );
      return null;
    };

    const { settle } = await mount(createElement(Screen));
    expect(seen.at(-1)).toBe("disabled/off/none/local-only/∅"); // no call: disabled, and nothing asked

    await act(async () => pick(true));
    await settle();
    // this device answered and the world has not: the middle of the progression
    expect(seen.at(-1)).toBe("success/on/local/local-only/j1");

    await act(async () => releaseSettled());
    await settle();
    expect(seen.at(-1)).toBe("success/on/settled/local-only/j1"); // and now the far sources have too
  });

  /**
   * The regression behind a detail panel that said "that issue is not on this device" about a row
   * the list beside it was still drawing.
   *
   * `answered` used to be `!isPending`, and a read that threw is neither pending nor successful —
   * so the failed read was handed to the caller as a ready one with no rows, which every
   * empty-state branch in the repository reads as "there is nothing here". Absence has to come
   * from the store having answered; a query this device could not run has told it nothing.
   */
  test("a read that threw never answers, so no empty state can be drawn over it", async () => {
    const { handle } = await open();
    const ghost = sqliteTable("ghost", { id: text().primaryKey() });
    const seen: string[] = [];
    const Screen = () => {
      const { data, status, answered, error } = useQuery({
        "~mesh": {
          key: "ghost",
          live: () => handle.live(handle.db.select({ id: ghost.id }).from(ghost)),
          settled: () => Promise.resolve(),
        },
      });
      seen.push(
        `${status}/${answered}/${data === undefined ? "∅" : String(data.length)}/${
          error === undefined ? "-" : "error"
        }`,
      );
      return null;
    };

    const { settle } = await mount(createElement(Screen));
    await settle();
    // the rows are withheld rather than reported as none, and the reason is carried up
    expect(seen.at(-1)).toBe("error/none/∅/error");
  });

  /**
   * `enabled: false` has to be a held query and not a hidden one. A hook that opened the live
   * query and then declined to report it would still re-run the read on every fold batch touching
   * the table, which is the cost the flag exists to avoid — and on a paused poll over a hot table
   * that is the whole bill.
   *
   * The second half is why the flag is worth having at all: resuming is a changed key, not a
   * changed component. If flipping it remounted, every piece of state under the gate would be
   * thrown away by a flag whose entire job is to be turned back on.
   */
  test("`enabled: false` opens and subscribes nothing, and flipping it true runs without remounting", async () => {
    const { handle } = await open();
    await handle.db.insert(jobs).values({ id: "j1", title: "one", rank: 1 });

    let opens = 0;
    let subscribers = 0;
    const call = {
      "~mesh": {
        key: "jobs-all",
        live: () => {
          opens += 1;
          const inner = handle.live(handle.db.select({ id: jobs.id }).from(jobs).orderBy(jobs.id));
          return {
            ...inner,
            subscribe: (listener: (rows: readonly { readonly id: string }[]) => void) => {
              subscribers += 1;
              const off = inner.subscribe(listener);
              return () => {
                subscribers -= 1;
                off();
              };
            },
          };
        },
        settled: () => Promise.resolve(),
      },
    };

    let mounts = 0;
    const seen: string[] = [];
    let flip: (on: boolean) => void = () => undefined;
    const Screen = () => {
      const [on, setOn] = useState(false);
      flip = setOn;
      useEffect(() => {
        mounts += 1;
      }, []);
      const { data, status, isEnabled } = useQuery(call, { enabled: on });
      seen.push(
        `${status}/${isEnabled ? "on" : "off"}/${
          data === undefined ? "∅" : data.map((r) => r.id).join(",")
        }`,
      );
      return null;
    };

    const { settle } = await mount(createElement(Screen));
    expect(seen.at(-1)).toBe("disabled/off/∅");
    expect(opens).toBe(0);
    expect(subscribers).toBe(0);
    expect(mounts).toBe(1);

    await act(async () => flip(true));
    await settle();
    expect(seen.at(-1)).toBe("success/on/j1");
    expect(opens).toBe(1);
    expect(subscribers).toBe(1);
    expect(mounts).toBe(1); // the same component instance: resuming is a key change, not a remount

    // and turning it off again releases what it took, rather than leaving it running unread
    await act(async () => flip(false));
    await settle();
    expect(seen.at(-1)).toBe("disabled/off/∅");
    expect(subscribers).toBe(0);
  });

  /**
   * The two ways to not run are two *situations* and one *state* — see `useQuery`'s comment. A
   * screen that branches on `status` or `isEnabled` must not be able to tell which spelling the
   * caller used, or the distinction the descriptor form protects would start leaking into views.
   */
  test("no call and `enabled: false` produce the same disabled result", async () => {
    const { handle } = await open();
    const call = {
      "~mesh": {
        key: "jobs-all",
        live: () => handle.live(handle.db.select({ id: jobs.id }).from(jobs).orderBy(jobs.id)),
        settled: () => Promise.resolve(),
      },
    };
    const reportOf = (result: QueryResult<{ readonly id: string }>) =>
      [
        result.data === undefined ? "∅" : String(result.data.length),
        result.status,
        result.answered,
        result.isEnabled,
        result.error === undefined ? "-" : "error",
        result.state.size,
        result.diff.added.size,
      ].join("/");

    const reports: string[] = [];
    const Screen = () => {
      reports.push(reportOf(useQuery(undefined)), reportOf(useQuery(call, { enabled: false })));
      return null;
    };

    const { settle } = await mount(createElement(Screen));
    await settle();
    expect(reports.at(-1)).toBe(reports.at(-2));
    expect(reports.at(-1)).toBe("∅/disabled/none/false/-/0/0");
  });
});
