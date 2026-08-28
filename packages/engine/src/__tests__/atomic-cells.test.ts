import type { CellChange, MergeSpec, PeerId, Stamp } from "@syncmesh/kernel";

import { applyCellChange, emptyState, readRow } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { createLink } from "../link.js";
import {
  CREATE,
  N1,
  NOTES,
  PEER_A,
  PEER_B,
  column,
  hlcAt,
  key,
  row,
  setup,
  table,
} from "./fixtures.js";

/**
 * What a cell is, demonstrated rather than asserted.
 *
 * A cell holds one value and one stamp. The column's declared type decides what is stored and
 * what is checked; it decides **nothing** about merging. So a string, a number and a JSON array
 * all lose a concurrent write in exactly the same way, and the shape of the value inside makes no
 * difference at all — which is the thing that is easy to disbelieve until you watch it.
 */

/** Two engines that were together, went apart, and came back. */
const apart = async () => {
  const a = setup(PEER_A, 100);
  const b = setup(PEER_B, 200);
  const link = createLink(a.engine, b.engine);
  return {
    a,
    b,
    link,
    /** Both write while offline; then they reconnect and settle. */
    concurrently: async (write: (engine: typeof a.engine, who: "a" | "b") => Promise<void>) => {
      link.setOnline(false);
      await write(a.engine, "a");
      await write(b.engine, "b");
      link.setOnline(true);
      (await link.catchUp()).unwrap();
    },
  };
};

const cellOf = (engine: ReturnType<typeof setup>["engine"], name: string) =>
  readRow(engine.state(), NOTES, N1)?.get(column(name));

describe("a cell is atomic, whatever type it declares", () => {
  test("a JSON array loses one of two concurrent writes", async () => {
    const { a, b, link, concurrently } = await apart();
    await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ tags: ["urgent"] })));
    await link.flush();

    // each device reads ["urgent"], appends its own tag, writes the whole array back — because
    // writing the whole array is the only thing a cell lets you do
    await concurrently(async (engine, who) => {
      await engine.mutate(CREATE, (tx) =>
        tx.update(NOTES, N1, row({ tags: ["urgent", who === "a" ? "billing" : "design"] })),
      );
    });

    const settled = cellOf(a.engine, "tags");
    expect(cellOf(b.engine, "tags")).toEqual(settled); // they agree, which is the point
    expect(settled).toHaveLength(2); // and one tag is simply gone
    expect(settled).not.toEqual(["urgent", "billing", "design"]);
  });

  test("text loses it identically — one character's difference is a different value", async () => {
    const { a, b, concurrently } = await apart();
    await concurrently(async (engine, who) => {
      await engine.mutate(CREATE, (tx) =>
        tx.insert(NOTES, N1, row({ tags: who === "a" ? "urgent,billing" : "urgent,design" })),
      );
    });
    const settled = cellOf(a.engine, "tags");
    expect(cellOf(b.engine, "tags")).toEqual(settled);
    expect(["urgent,billing", "urgent,design"]).toContain(String(settled));
  });

  test("and an integer loses it identically: two +1s from 10 settle at 11, not 12", async () => {
    const { a, b, link, concurrently } = await apart();
    await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ views: 10 })));
    await link.flush();
    // read 10, add one, write 11 — on both devices, because neither can see the other
    await concurrently(async (engine) => {
      await engine.mutate(CREATE, (tx) => tx.update(NOTES, N1, row({ views: 11 })));
    });
    expect(cellOf(a.engine, "views")).toBe(11);
    expect(cellOf(b.engine, "views")).toBe(11); // agreed, and wrong by one view
  });
});

describe("the two ways out", () => {
  const TAG = table("postTag");

  test("a row per tag: different keys, so there is nothing to merge and nothing is lost", async () => {
    const { a, b, concurrently } = await apart();
    await concurrently(async (engine, who) => {
      const tag = who === "a" ? "billing" : "design";
      await engine.mutate(CREATE, (tx) =>
        tx.insert(TAG, key(`p1:${tag}`), row({ postId: "p1", tag })),
      );
    });

    const tagsOn = (engine: typeof a.engine) =>
      [...(engine.state().get(TAG)?.keys() ?? [])].map(String).sort();
    expect(tagsOn(a.engine)).toEqual(["p1:billing", "p1:design"]);
    expect(tagsOn(b.engine)).toEqual(tagsOn(a.engine));
  });

  test("a counter cell: it stops holding the number and holds each peer's totals instead", () => {
    // at the kernel, because no `mutate` can author one yet — the missing producer is exactly
    // the client surface, and this is what it would be producing
    const merge: MergeSpec = new Map([[NOTES, new Map([[column("views"), "counter" as const]])]]);
    // the change carries the author's running totals, and the stamp says whose they are — so no
    // peer can write another's entry, which is what makes the two increments independent
    const increment = (inc: number): CellChange => ({
      kind: "increment",
      table: NOTES,
      key: N1,
      counts: new Map([[column("views"), { inc, dec: 0 }]]),
    });
    const from = (peer: PeerId, ms: number): Stamp => ({ hlc: hlcAt(ms), peer });

    // the same two concurrent +1s, folded in either order
    let straight = emptyState();
    straight = applyCellChange(straight, increment(1), from(PEER_A, 100), merge);
    straight = applyCellChange(straight, increment(1), from(PEER_B, 200), merge);

    let reversed = emptyState();
    reversed = applyCellChange(reversed, increment(1), from(PEER_B, 200), merge);
    reversed = applyCellChange(reversed, increment(1), from(PEER_A, 100), merge);

    expect(readRow(straight, NOTES, N1)?.get(column("views"))).toEqual(
      readRow(reversed, NOTES, N1)?.get(column("views")),
    );
    // and the cell no longer contains 12 — it contains what computes to 12
    expect(readRow(straight, NOTES, N1)?.get(column("views"))).not.toBe(12);
  });
});
