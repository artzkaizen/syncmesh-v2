import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Statement } from "./served-fixtures.js";

import {
  ALICE,
  POSTGRES_URL,
  after,
  eventually,
  mailId,
  pipe,
  seedMailbox,
  served,
} from "./served-fixtures.js";

const suite = POSTGRES_URL === undefined ? describe.skip : describe;

const ROWS = 1_000_000;
const LIMIT = 50;

type Fixture = Awaited<ReturnType<typeof served>>;

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Actual Rows": number;
  readonly "Actual Loops": number;
  readonly "Rows Removed by Filter"?: number;
  readonly "Rows Removed by Index Recheck"?: number;
  readonly Plans?: readonly PlanNode[];
}

/** Every row Postgres took out of `table` to answer `statement`: kept, filtered or rechecked. */
const rowsRead = async (fx: Fixture, statement: Statement) => {
  // SAFETY: the params are the ones Drizzle bound for this statement, which postgres.js takes
  const [explained] = await fx.pg.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, [
    ...statement.params,
  ] as never[]);
  /* oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: EXPLAIN (FORMAT JSON) answers one row whose one column is the plan as JSON */
  const plan = (explained as unknown as { "QUERY PLAN": { Plan: PlanNode }[] })["QUERY PLAN"][0]
    ?.Plan;
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode | undefined) => {
    if (node === undefined) return;
    nodes.push(node);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(plan);
  const scans = nodes.filter((n) => n["Relation Name"] === fx.names.mail);
  return {
    read: scans.reduce(
      (sum, n) =>
        sum +
        (n["Actual Rows"] +
          (n["Rows Removed by Filter"] ?? 0) +
          (n["Rows Removed by Index Recheck"] ?? 0)) *
          n["Actual Loops"],
      0,
    ),
    sorted: nodes.some((n) => n["Node Type"] === "Sort"),
    scans: scans.map((n) => n["Node Type"]),
  };
};

/** The last page read the server's Drizzle sent for the mail table. */
const lastPageRead = (fx: Fixture) => {
  const found = [...fx.statements]
    .reverse()
    .find((s) => s.sql.includes("from (select") && s.sql.includes(fx.names.mail));
  if (found === undefined) throw new Error("no page read was sent");
  return found;
};

suite(`a million rows in Postgres, read a page at a time (D43)`, () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await served({ seed: seedMailbox(ROWS) });
  }, 120_000);
  afterAll(() => fx.close());

  test("opening, a scroll 500k deep and a live INSERT each read about one page of rows", async () => {
    const { client, server } = pipe(fx.sourceFor(ALICE));

    client.open("inbox", { path: "mail.inbox", input: { folder: "inbox", limit: LIMIT } });
    await server.idle();
    expect(client.rows("inbox")[0]?.key).toBe(mailId(ROWS));
    const opened = await rowsRead(fx, lastPageRead(fx));

    client.open("inbox", {
      path: "mail.inbox",
      input: { folder: "inbox", limit: LIMIT, after: after(ROWS / 2) },
    });
    await server.idle();
    expect(client.rows("inbox").map((r) => r.key)).toEqual(
      Array.from({ length: LIMIT }, (_, i) => mailId(ROWS / 2 - 1 - i)),
    );
    const deep = await rowsRead(fx, lastPageRead(fx));

    client.open("inbox", { path: "mail.inbox", input: { folder: "inbox", limit: LIMIT } });
    await server.idle();
    const before = fx.statements.length;
    await fx.insert(ROWS + 1);
    await eventually(() => client.rows("inbox")[0]?.key === mailId(ROWS + 1), "the live insert");
    expect(fx.statements.length).toBe(before + 1);
    const live = await rowsRead(fx, lastPageRead(fx));

    console.log("rows read per page from 1M:", { opened, deep, live });
    for (const page of [opened, deep, live]) {
      expect(page.read).toBeLessThanOrEqual(LIMIT + 1);
      expect(page.sorted).toBe(false);
    }
    expect(server.held()).toBe(LIMIT);
    expect(client.held()).toBe(LIMIT);
  }, 60_000);
});
