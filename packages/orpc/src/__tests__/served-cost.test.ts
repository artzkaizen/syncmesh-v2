import { Temporal } from "@syncmesh/temporal";
import { createServerWindows, createWindowClient } from "@syncmesh/window";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Statement } from "./served-fixtures.js";

import { ALICE, POSTGRES_URL, after, eventually, seedMailbox, served } from "./served-fixtures.js";

const suite = POSTGRES_URL === undefined ? describe.skip : describe;

/** How long a pass must read nothing before the feed is taken to have handed every commit over. */
const QUIET = Temporal.Duration.from({ milliseconds: 200 });

/** The page reads among what the server sent: the role and the reader's settings are not reads. */
const reads = (statements: readonly Statement[]) =>
  statements.filter((statement) => / limit /i.test(statement.sql)).length;

/** The statements that start a served read's transaction: one per transaction. */
const entries = (statements: readonly Statement[]) =>
  statements.filter((statement) => statement.sql.includes("syncmesh_served")).length;

suite("what a commit costs a socket's windows (D43)", () => {
  let fx: Awaited<ReturnType<typeof served>>;
  beforeAll(async () => {
    fx = await served({ seed: seedMailbox(10_000) });
  });
  afterAll(() => fx.close());

  /** `sockets` sockets of alice's, each opening `windows` windows, the `n`th read by `input(n)`. */
  const open = async (sockets: number, windows: number, input: (n: number) => object) => {
    const servers = Array.from({ length: sockets }, () => {
      const client = createWindowClient();
      const server = createServerWindows({
        source: fx.sourceFor(ALICE),
        send: (frame) => client.receive(frame),
      });
      client.attach((frame) => server.receive(frame));
      for (let w = 0; w < windows; w++)
        client.open(`w${w}`, { path: "mail.inbox", input: { folder: "inbox", ...input(w) } });
      return server;
    });
    await Promise.all(servers.map((server) => server.idle()));
    return servers;
  };

  /** Commits `commits` rows no window shows, and counts the reads until every socket is idle. */
  const commit = async (servers: ReturnType<typeof createServerWindows>[], commits: number) => {
    fx.statements.length = 0;
    const stamp = `${Date.now()}`;
    for (let c = 0; c < commits; c++)
      await fx.pg.unsafe(
        `INSERT INTO ${fx.names.mail} VALUES ($1, 'alice', 'spam', '2020-01-01', 'x')`,
        [`z-${stamp}-${c}`],
      );
    await eventually(() => reads(fx.statements) > 0, "the first re-read");
    // the feed hands the commits over on its own schedule: idle until a quiet pass reads nothing
    let seen = -1;
    while (seen !== reads(fx.statements)) {
      seen = reads(fx.statements);
      await Promise.all(servers.map((server) => server.idle()));
      await new Promise((resolve) => setTimeout(resolve, QUIET.total("milliseconds")));
    }
    for (const server of servers) server.stop();
    return seen;
  };

  test("windows on one socket asking the same read are re-read once per commit", async () => {
    const servers = await open(4, 16, () => ({ limit: 50 }));
    // four sockets, one read each: not 64
    expect(await commit(servers, 1)).toBe(4);
  });

  test("a commit re-reads every window of a socket in one transaction, not one each", async () => {
    const servers = await open(1, 16, (w) => ({ limit: 50, after: after(10_000 - w * 100) }));
    const count = await commit(servers, 1);
    expect(count).toBe(16);
    // a commit the feed hands over in two pieces is two passes, never sixteen
    expect(entries(fx.statements)).toBeLessThanOrEqual(2);
  });

  test("a burst of commits is at most two re-reads of each window, not one per commit", async () => {
    const servers = await open(1, 16, (w) => ({ limit: 50, after: after(10_000 - w * 100) }));
    const count = await commit(servers, 20);
    expect(count).toBeGreaterThanOrEqual(16);
    expect(count).toBeLessThanOrEqual(32);
  });
});
