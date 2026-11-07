import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { createWindowClient } from "../client.js";
import { createMemoryRowSource } from "../source.js";
import { createClientView } from "../view.js";
import { AT, MAIL, after, ats, down, mail, mailKey, newest } from "./fixtures.js";

const ROWS = 1_000_000;
const LIMIT = 50;
/**
 * Tens of times what a run takes alone (under 10 ms), so a GC pause on a loaded CI box does not
 * fail it; what is actually bounded is `scanned`, which is exact.
 */
const BUDGET = Temporal.Duration.from({ milliseconds: 500 });

const elapsed = (work: () => void): Temporal.Duration => {
  const start = performance.now();
  work();
  return Temporal.Duration.from({ milliseconds: Math.ceil(performance.now() - start) });
};

const within = (d: Temporal.Duration) => Temporal.Duration.compare(d, BUDGET) <= 0;

describe("a window over a million rows (E27)", () => {
  const source = createMemoryRowSource();
  // one column a row: the source stands in for a database, and its memory is not what is bounded
  source.load(
    MAIL,
    Array.from({ length: ROWS }, (_, i) => ({ key: mailKey(i + 1), row: new Map([[AT, i + 1]]) })),
  );
  // the source's index for this order, as a database has one before any window opens
  source.window(newest(1), () => true);

  const open = () => {
    const client = createWindowClient();
    const frames: Uint8Array[] = [];
    const view = createClientView({
      source,
      send: (frame) => {
        frames.push(frame);
        client.receive(frame);
      },
    });
    client.attach((frame) => view.receive(frame));
    return { client, view, frames };
  };

  test("opening a window reads only its rows, and holds only its rows", () => {
    const { client, view, frames } = open();
    const took = elapsed(() => client.desire("inbox", newest(LIMIT)));
    expect(ats(client.rows("inbox"))).toEqual(down(ROWS, LIMIT));
    expect(source.scanned()).toBe(LIMIT);
    expect(view.held()).toBe(LIMIT);
    expect(client.held()).toBe(LIMIT);
    // one frame, the size of a screen: under 100 bytes a row here, never the table
    expect(frames.length).toBe(1);
    expect(frames[0]?.byteLength).toBeLessThan(LIMIT * 100);
    expect(within(took)).toBe(true);
  });

  test("a scroll half a million rows deep costs what the first screen did", () => {
    const { client, view } = open();
    client.desire("inbox", newest(LIMIT));
    const took = elapsed(() => client.desire("inbox", newest(LIMIT, { after: after(500_000) })));
    expect(ats(client.rows("inbox"))).toEqual(down(499_999, LIMIT));
    expect(source.scanned()).toBe(LIMIT);
    expect(view.held()).toBe(LIMIT);
    expect(within(took)).toBe(true);
  });

  test("a new row lands in an open window without re-reading the table", () => {
    const { client, view } = open();
    client.desire("inbox", newest(LIMIT));
    const took = elapsed(() =>
      source.write([{ table: MAIL, key: mailKey(ROWS + 1), row: mail(ROWS + 1) }]),
    );
    expect(ats(client.rows("inbox"))).toEqual(down(ROWS + 1, LIMIT));
    expect(source.scanned()).toBe(LIMIT);
    expect(view.held()).toBe(LIMIT);
    expect(within(took)).toBe(true);
  });
});
