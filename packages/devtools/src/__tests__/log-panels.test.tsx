import "./dom.js";
import type { TableName } from "@syncmesh/kernel";
import type { ReactNode } from "react";

import { StoreFailure } from "@syncmesh/engine";
import { eventId, hlcOf, parsePartitionKey, parsePeerId, parseSeqNum } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { DevtoolsEvent, DevtoolsStore, DevtoolsStranded, DevtoolsWrite } from "../contract.js";
import type { EventsSource } from "../panels/events.js";
import type { StorageSource } from "../panels/storage.js";
import type { DevtoolsReceipt, WritesSource } from "../panels/writes.js";

import { QueryFailed } from "../contract.js";
import { Events } from "../panels/events.js";
import { Storage } from "../panels/storage.js";
import { Writes } from "../panels/writes.js";

const id = (hex: string) => parsePeerId(hex.repeat(64).slice(0, 64)).unwrap();
const seq = (value: number) => parseSeqNum(value).unwrap();
/** SAFETY: a table name is a branded string and carries no invariant a literal can fail. */
const table = (name: string) => name as TableName;
const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);

const ALICE = id("a");
const BOB = id("b");
const ORG = parsePartitionKey("org:acme").unwrap();

const mount = async (node: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    text: () => container.textContent ?? "",
    /** Quantities that were drawn rather than printed. */
    meters: () => container.querySelectorAll('[role="meter"]').length,
    rings: () => container.querySelectorAll("svg circle").length,
    click: async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) =>
          candidate.textContent?.includes(label) === true ||
          candidate.getAttribute("aria-label")?.includes(label) === true,
      );
      await act(async () => {
        button?.click();
      });
    },
    close: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

const header = (n: number, over: Partial<DevtoolsEvent> = {}): DevtoolsEvent => ({
  id: eventId(ALICE, seq(n), false),
  peer: ALICE,
  seq: seq(n),
  hlc: hlcOf(1_700_000_000_000 + n, 0),
  partition: undefined,
  local: false,
  bytes: 1200,
  tables: undefined,
  // unnamed by default: a peer's event is the common row, and this device's ledger says nothing
  // about one, so the fixture starts from the case the panel has to be honest about
  label: undefined,
  ...over,
});

describe("Events", () => {
  test("shows the header of every event and never a payload", async () => {
    const rows = [
      header(2, { partition: ORG, tables: undefined }),
      header(1, { local: true, bytes: 480, tables: undefined }),
    ];
    const source = { events: () => Promise.resolve(Result.ok(rows)) } satisfies EventsSource;
    const panel = await mount(<Events openTab={() => undefined} source={source} />);
    const text = panel.text();
    expect(text).toContain("org:acme");
    expect(text).toContain("local only");
    expect(text).toContain("synced");
    expect(text).toContain("1.2 kB");
    expect(text).toContain("480 B");
    panel.close();
  });

  test("says a missing table list is undecoded, not empty", async () => {
    const source = {
      events: () => Promise.resolve(Result.ok([header(1)])),
    } satisfies EventsSource;
    const panel = await mount(<Events openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("not decoded");
    panel.close();
  });

  test("this device's own write is named by its procedure, not by the table it touched", async () => {
    const rows = [
      header(2, { label: "issues.move" }),
      // another peer's event: the ledger holds nothing about it, and naming it would mean the
      // decode this panel exists not to do
      header(1),
    ];
    const source = { events: () => Promise.resolve(Result.ok(rows)) } satisfies EventsSource;
    const panel = await mount(<Events openTab={() => undefined} source={source} />);
    const text = panel.text();
    expect(text).toContain("issues.move");
    expect(text).toContain("not decoded");
    panel.close();
  });

  test("a procedure name wins over the tables, because it is what a person did", async () => {
    const rows = [header(1, { label: "issues.move", tables: [table("issue")] })];
    const source = { events: () => Promise.resolve(Result.ok(rows)) } satisfies EventsSource;
    const panel = await mount(<Events openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("issues.move");
    expect(panel.text()).not.toContain("issue,");
    panel.close();
  });

  test("pages with the oldest stamp on the screen", async () => {
    const rows = Array.from({ length: 100 }, (_unused, index) => header(100 - index));
    const asked: (readonly unknown[] | undefined)[] = [];
    const source = {
      events: (options) => {
        asked.push([options?.before]);
        return Promise.resolve(Result.ok(rows));
      },
    } satisfies EventsSource;
    const panel = await mount(<Events openTab={() => undefined} source={source} />);
    await panel.click("Older");
    expect(asked).toHaveLength(2);
    expect(asked[1]?.[0]).toBe(rows[99]?.hlc);
    panel.close();
  });

  test("draws the page as a shape: a rate spark, a mix and meters per author", async () => {
    const rows = [
      header(3, { partition: ORG }),
      header(2, { local: true, bytes: 480 }),
      header(1, { peer: BOB, id: eventId(BOB, seq(1), false) }),
    ];
    const source = { events: () => Promise.resolve(Result.ok(rows)) } satisfies EventsSource;
    const panel = await mount(<Events openTab={() => undefined} source={source} />);
    const text = panel.text();
    expect(text).toContain("buckets");
    expect(text).toContain("On this page");
    expect(text).toContain("By author");
    expect(text).toContain("By instance");
    // one size bar per row, plus the two author bars and the two instance bars
    expect(panel.meters()).toBeGreaterThanOrEqual(7);
    panel.close();
  });

  test("an empty page draws no chart, because an empty spark teaches nobody", async () => {
    const source = { events: () => Promise.resolve(Result.ok([])) } satisfies EventsSource;
    const panel = await mount(<Events openTab={() => undefined} source={source} />);
    expect(panel.meters()).toBe(0);
    expect(panel.text()).not.toContain("buckets");
    panel.close();
  });

  test("an empty first page says what empty means", async () => {
    const source = { events: () => Promise.resolve(Result.ok([])) } satisfies EventsSource;
    const panel = await mount(<Events openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("The log is empty");
    expect(panel.text()).toContain("mesh.on()");
    panel.close();
  });

  test("a refused read is a value, not a blank panel", async () => {
    const source = {
      events: () => Promise.resolve(Result.err(new StoreFailure({ message: "store is closed" }))),
    } satisfies EventsSource;
    const panel = await mount(<Events openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("The log could not be read");
    expect(panel.text()).toContain("store is closed");
    panel.close();
  });
});

const STORE = {
  version: 4,
  log: [
    { peer: ALICE, local: false, events: 12, topSeq: seq(12), bytes: 24_000 },
    { peer: ALICE, local: true, events: 2, topSeq: seq(2), bytes: 900 },
    { peer: BOB, local: false, events: 6, topSeq: seq(6), bytes: 12_000 },
  ],
  tables: [{ table: "issue", rows: 9 }],
  floors: [{ peer: BOB, local: false, seq: seq(40) }],
  writes: [{ status: "applied", count: 7 }],
} satisfies DevtoolsStore;

const sync = () => ({ authors: [], scope: undefined, acks: [], parked: [] });

const identity = () => ({
  peer: ALICE,
  account: "acme",
  role: "member",
  partitions: ["org:acme"],
  session: undefined,
  sessionExpiresAt: undefined,
});

const links = () => ({ self: ALICE, peers: [], silent: [], routes: [], tally: [], recent: [] });

describe("Storage", () => {
  test("a mesh with no SQL store says so", async () => {
    const source = { storage: undefined, sync, identity } satisfies StorageSource;
    const panel = await mount(<Storage openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("This mesh keeps no SQL store");
    panel.close();
  });

  test("counts the log, the rows, the floors and the migration", async () => {
    const source = {
      storage: () => Promise.resolve(Result.ok(STORE)),
      sync,
      identity,
    } satisfies StorageSource;
    const panel = await mount(<Storage openTab={() => undefined} source={source} />);
    const text = panel.text();
    expect(text).toContain("37 kB");
    expect(text).toContain("v4");
    expect(text).toContain("issue");
    expect(text).toContain("unscoped");
    expect(text).toContain("applied");
    panel.close();
  });

  test("counts once on open and once per refresh, never on its own", async () => {
    let reads = 0;
    const source = {
      storage: () => {
        reads += 1;
        return Promise.resolve(Result.ok(STORE));
      },
      sync,
      identity,
    } satisfies StorageSource;
    const panel = await mount(<Storage openTab={() => undefined} source={source} />);
    expect(reads).toBe(1);
    await panel.click("Refresh");
    expect(reads).toBe(2);
    panel.close();
  });

  test("draws the log as a ring and the tables as meters", async () => {
    const source = {
      storage: () => Promise.resolve(Result.ok(STORE)),
      sync,
      identity,
    } satisfies StorageSource;
    const panel = await mount(<Storage openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("authored here");
    // fourteen of the twenty events in this database were written here
    expect(panel.text()).toContain("70%");
    // three author bars and one table bar
    expect(panel.meters()).toBe(4);
    // the ring is a track and an arc
    expect(panel.rings()).toBe(2);
    panel.close();
  });

  test("a refused statement names itself", async () => {
    const source = {
      storage: () =>
        Promise.resolve(Result.err(new QueryFailed({ sql: "SELECT 1", cause: "no such table" }))),
      sync,
      identity,
    } satisfies StorageSource;
    const panel = await mount(<Storage openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("The store could not be counted");
    expect(panel.text()).toContain("SELECT 1");
    panel.close();
  });
});

const WRITE = {
  id: "op-1",
  label: "issue.create",
  peer: ALICE,
  seq: seq(7),
  at: at(Date.now() - 45_000),
  status: "applied",
  correctedBy: undefined,
  correctedReason: undefined,
} satisfies DevtoolsWrite;

/** Nothing stranded is the healthy answer, so it is the one every ledger fixture starts from. */
const clean = () => Promise.resolve(Result.ok([]));

const ledger = (writes: readonly DevtoolsWrite[]) => ({
  writes: () => Promise.resolve(Result.ok({ unsettled: writes, truncated: false })),
  stranded: clean,
  onChange: () => () => undefined,
  links,
});

const STRANDED = {
  author: BOB,
  count: 86,
  from: seq(12),
  to: seq(98),
  message: "86 event(s) by 3f100000 (seq 12-98) can never be sent",
} satisfies DevtoolsStranded;

describe("Writes", () => {
  test("a mesh with no ledger says so instead of showing an empty table", async () => {
    const source = {
      writes: undefined,
      stranded: clean,
      onChange: () => () => undefined,
      links,
    } satisfies WritesSource;
    const panel = await mount(<Writes openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("This mesh has no write ledger");
    panel.close();
  });

  test("lists what is waiting, with its event and its age", async () => {
    const panel = await mount(<Writes openTab={() => undefined} source={ledger([WRITE])} />);
    const text = panel.text();
    expect(text).toContain("issue.create");
    expect(text).toContain("-7");
    expect(text).toContain("45s");
    panel.close();
  });

  test("custody is read for the chosen write and named as delivery", async () => {
    const asked: string[] = [];
    const receipts = [{ holder: BOB, at: at(Date.now() - 5000) }] satisfies DevtoolsReceipt[];
    const source = {
      ...ledger([WRITE]),
      receiptsOf: (write) => {
        asked.push(write.id);
        return Promise.resolve(Result.ok(receipts));
      },
    } satisfies WritesSource;
    const panel = await mount(<Writes openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("delivery, never approval");
    await panel.click("Custody of issue.create");
    expect(asked).toEqual(["op-1"]);
    expect(panel.text()).toContain("held 5s");
    panel.close();
  });

  test("a source with no receipts reader says that, rather than showing nobody", async () => {
    const panel = await mount(<Writes openTab={() => undefined} source={ledger([WRITE])} />);
    expect(panel.text()).toContain("Custody cannot be read here");
    panel.close();
  });

  test("draws each wait as a meter and custody as a ring", async () => {
    const old = { ...WRITE, id: "op-0", label: "issue.rename", at: at(Date.now() - 7_200_000) };
    const source = {
      ...ledger([old, WRITE]),
      receiptsOf: () => Promise.resolve(Result.ok([{ holder: BOB, at: at(Date.now() - 1000) }])),
    } satisfies WritesSource;
    const panel = await mount(<Writes openTab={() => undefined} source={source} />);
    expect(panel.meters()).toBe(2);
    expect(panel.text()).toContain("holders");
    expect(panel.text()).toContain("2h");
    await panel.click("Custody of issue.rename");
    expect(panel.text()).toContain("1/1");
    panel.close();
  });

  test("corrections carry their reason, and say when the list is partial", async () => {
    const corrected = {
      ...WRITE,
      correctedBy: "auth-1",
      correctedReason: "price outside policy",
    } satisfies DevtoolsWrite;
    const panel = await mount(<Writes openTab={() => undefined} source={ledger([corrected])} />);
    expect(panel.text()).toContain("price outside policy");
    expect(panel.text()).toContain("no corrections reader");
    panel.close();
  });

  test("corrections come from the source where it has them", async () => {
    const source = {
      ...ledger([]),
      corrections: () => [{ event: `${ALICE}-7`, table: "issue", key: "i-1", reason: "duplicate" }],
    } satisfies WritesSource;
    const panel = await mount(<Writes openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("duplicate");
    expect(panel.text()).toContain("issue.i-1");
    expect(panel.text()).not.toContain("no corrections reader");
    panel.close();
  });

  test("a run nobody here can sign for is named, counted and explained", async () => {
    const source = {
      ...ledger([WRITE]),
      stranded: () => Promise.resolve(Result.ok([STRANDED])),
    } satisfies WritesSource;
    const panel = await mount(<Writes openTab={() => undefined} source={source} />);
    const text = panel.text();
    expect(text).toContain("Stranded writes");
    expect(text).toContain("86 events");
    expect(text).toContain("seq 12");
    // the count rides in the band beside Unsettled, because a device can have none of one and
    // plenty of the other and every other panel here would still read healthy
    expect(text).toContain("Stranded");
    // it says what cannot be done about it, which is the finding rather than a missing feature
    expect(text).toContain("Nothing repairs this");
    panel.close();
  });

  test("an empty audit reads as the ordinary state, not as an absent reader", async () => {
    const panel = await mount(<Writes openTab={() => undefined} source={ledger([WRITE])} />);
    expect(panel.text()).toContain("Nothing stranded");
    panel.close();
  });

  test("a stranded write is not counted as waiting, because waiting is a claim about time", async () => {
    const doomed = {
      ...WRITE,
      id: "op-0",
      peer: BOB,
      seq: seq(40),
      at: at(Date.now() - 30 * 3_600_000),
    };
    const live = { ...WRITE, id: "op-9", at: at(Date.now() - 4000) };
    const source = {
      ...ledger([doomed, live]),
      stranded: () => Promise.resolve(Result.ok([STRANDED])),
    } satisfies WritesSource;
    const panel = await mount(<Writes openTab={() => undefined} source={source} />);
    const text = panel.text();
    // the one that can still arrive is the only thing "waiting longest" may be about; the 30h
    // row is by the retired author and inside the audit's run
    expect(text).toContain("4s");
    expect(text).not.toContain("30h");
    // and it is not hidden — the panel says how many it set aside and where they went
    expect(text).toContain("1 more write is unsettled in this ledger");
    panel.close();
  });

  test("a ledger with nothing left but stranded writes does not claim everything was receipted", async () => {
    const doomed = { ...WRITE, id: "op-0", peer: BOB, seq: seq(40) };
    const source = {
      ...ledger([doomed]),
      stranded: () => Promise.resolve(Result.ok([STRANDED])),
    } satisfies WritesSource;
    const panel = await mount(<Writes openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("Nothing is waiting that could arrive");
    expect(panel.text()).not.toContain("receipted by at least one peer");
    panel.close();
  });

  test("a refused audit says the log could not be read, never that it is clean", async () => {
    const source = {
      ...ledger([WRITE]),
      stranded: () =>
        Promise.resolve(Result.err(new StoreFailure({ message: "the database went away" }))),
    } satisfies WritesSource;
    const panel = await mount(<Writes openTab={() => undefined} source={source} />);
    expect(panel.text()).toContain("The log could not be audited");
    expect(panel.text()).toContain("the database went away");
    expect(panel.text()).not.toContain("Nothing stranded");
    panel.close();
  });
});
