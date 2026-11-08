import type { PageSource } from "@syncmesh/window";

import { createServerWindows, createWindowClient } from "@syncmesh/window";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Statement } from "./served-fixtures.js";

import { ALICE, POSTGRES_URL, after, eventually, seedMailbox, served } from "./served-fixtures.js";

const suite = POSTGRES_URL === undefined ? describe.skip : describe;

/**
 * `source` with its commit feed held: what the feed hands over is kept until `release`, which
 * hands each piece on as the feed would have, one after another. A test that releases once
 * every commit is in counts what a burst costs, however the feed happened to split it.
 */
const held = (source: PageSource) => {
  type Listener = Parameters<PageSource["onCommit"]>[0];
  const listeners = new Set<Listener>();
  const pieces: ReadonlySet<string>[] = [];
  let holding = true;
  const off = source.onCommit((tables) => {
    if (holding) pieces.push(tables);
    else for (const listener of listeners) listener(tables);
  });
  return {
    source: {
      ...source,
      onCommit: (listener: Listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    } satisfies PageSource,
    pieces,
    hold: () => {
      holding = true;
      pieces.length = 0;
    },
    release: () => {
      holding = false;
      for (const piece of pieces) for (const listener of listeners) listener(piece);
    },
    stop: off,
  };
};

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
    const opened = Array.from({ length: sockets }, () => {
      const feed = held(fx.sourceFor(ALICE));
      const client = createWindowClient();
      const server = createServerWindows({
        source: feed.source,
        send: (frame) => client.receive(frame),
      });
      client.attach((frame) => server.receive(frame));
      for (let w = 0; w < windows; w++)
        client.open(`w${w}`, { path: "mail.inbox", input: { folder: "inbox", ...input(w) } });
      return { server, feed };
    });
    await Promise.all(opened.map(({ server }) => server.idle()));
    return opened;
  };

  /**
   * Commits `commits` rows no window shows, then one to the table no window reads: the feed is in
   * commit order, so once that one is held every commit before it is too. Then the feed is let
   * go, and the reads are counted once every socket is idle, with how many pieces the feed made
   * of the burst.
   */
  const commit = async (opened: Awaited<ReturnType<typeof open>>, commits: number) => {
    for (const { feed } of opened) feed.hold();
    const stamp = `${Date.now()}`;
    for (let c = 0; c < commits; c++)
      await fx.pg.unsafe(
        `INSERT INTO ${fx.names.mail} VALUES ($1, 'alice', 'spam', '2020-01-01', 'x')`,
        [`z-${stamp}-${c}`],
      );
    await fx.pg.unsafe(
      `INSERT INTO ${fx.names.open} VALUES ($1, 'alice', 'spam', '2020-01-01', 'x')`,
      [`z-${stamp}`],
    );
    await eventually(
      () => opened.every(({ feed }) => feed.pieces.some((piece) => piece.has(fx.names.open))),
      "the last commit",
    );
    const pieces = Math.max(
      ...opened.map(({ feed }) => feed.pieces.filter((piece) => piece.has(fx.names.mail)).length),
    );
    fx.statements.length = 0;
    for (const { feed } of opened) feed.release();
    await Promise.all(opened.map(({ server }) => server.idle()));
    for (const { server, feed } of opened) {
      server.stop();
      feed.stop();
    }
    return { reads: reads(fx.statements), pieces };
  };

  /** The passes a feed's pieces cost a socket: the first starts one, and the rest land in it. */
  const passes = (pieces: number) => Math.min(pieces, 2);

  test("windows on one socket asking the same read are re-read once per commit", async () => {
    const { reads: count, pieces } = await commit(await open(4, 16, () => ({ limit: 50 })), 1);
    // four sockets, one read each: not 64
    expect(count).toBe(4 * passes(pieces));
  });

  test("a commit re-reads every window of a socket in one transaction, not one each", async () => {
    const opened = await open(1, 16, (w) => ({ limit: 50, after: after(10_000 - w * 100) }));
    const { reads: count, pieces } = await commit(opened, 1);
    expect(count).toBe(16 * passes(pieces));
    // a commit the feed hands over in two pieces is two passes, never sixteen
    expect(entries(fx.statements)).toBe(passes(pieces));
  });

  test("a burst of commits is at most two re-reads of each window, however the feed splits it", async () => {
    const opened = await open(1, 16, (w) => ({ limit: 50, after: after(10_000 - w * 100) }));
    const { reads: count, pieces } = await commit(opened, 20);
    expect(pieces).toBeGreaterThanOrEqual(1);
    expect(count).toBe(16 * passes(pieces));
  });
});
