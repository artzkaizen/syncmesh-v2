import type { LiveChange, Runnable } from "@syncmesh/drizzle";

import { describe, expect, test } from "bun:test";

import type { Device } from "./fixtures.js";

import { WORKSPACE, WORKSPACE_ID } from "../domain.js";
import { seedWorkspace } from "../seed.js";
import { T0, accountOf, openDevice } from "./fixtures.js";

/**
 * The tracker's own reads, checked against the thing that makes them cheap.
 *
 * A fold names the rows it wrote, and a live query that can be patched from those rows says so by
 * delivering a **delta** rather than only a fresh array (`@syncmesh/drizzle`'s `LiveWindow`). So
 * the delta is the observable: a list that hands one back re-read one row, and a list that hands
 * back `undefined` re-read the table. Nothing here asserts a duration — what it asserts is which
 * of the two happened, which is the fact the duration follows from.
 *
 * It is a test in *this* package rather than in `drizzle` because the interesting queries are the
 * real ones. `issues.list` reads through the caller's scoped source — a subquery with their rule
 * compiled into it — sorts by `(rank, id)` and pages at 200, and every one of those is a clause
 * the patcher had to be taught. A synthetic `SELECT * FROM t` proves none of it.
 *
 * {@link maintaining} opens each query on the handle rather than through `call.live()`, because
 * `meshApi` currently hands `live` a *built* query and so holds maintenance off (see the note on
 * `api.ts`'s `read`). `call.run` is the same factory that wiring would pass, so this exercises the
 * real procedure down the real path while the app itself is on the re-reading one.
 */

/** A live query under a listener, with what it was told kept in order. */
const watching = <T>(live: {
  readonly ready: Promise<readonly T[]>;
  readonly subscribe: (
    listener: (rows: readonly T[], changes?: readonly LiveChange<T>[]) => void,
  ) => () => void;
  readonly release: () => void;
}) => {
  const told: { rows: readonly T[]; changes: readonly LiveChange<T>[] | undefined }[] = [];
  live.subscribe((rows, changes) => void told.push({ rows, changes }));
  return { told, ...live };
};

/** Folds land after the write's transaction; the next macrotask is after the listener's turn. */
const tick = () => new Promise((done) => setTimeout(done, 5));

/** The query, opened the way `meshApi` opens one when maintenance is on: by the way to build it. */
const maintaining = <T>(device: Device, call: { readonly run: () => Runnable<T> }) =>
  device.$mesh.on(WORKSPACE).unwrap().live(call.run);

const seeded = async (device: Device) => {
  const made = await seedWorkspace(device.$mesh.on(WORKSPACE).unwrap().db, { issues: 6, now: T0 });
  return made.issueIds;
};

describe("the tracker's lists are maintained rather than re-read", () => {
  test("assigning an issue delivers one update, and the rest of the list keeps its rows", async () => {
    const ada = await openDevice("ada");
    const ids = await seeded(ada);
    const list = maintaining(ada, ada.issues.list({ workspaceId: WORKSPACE_ID }));
    const before = await list.ready;
    const watch = watching(list);

    const moved = ids[2] ?? "";
    await ada.issues.assign({
      workspaceId: WORKSPACE_ID,
      id: moved,
      actorId: accountOf("ada"),
      assigneeId: accountOf("bo"),
    }).committed;
    await tick();

    const [delivery] = watch.told;
    expect(delivery?.changes?.map((change) => `${change.kind}:${change.key}`)).toEqual([
      `update:${moved}`,
    ]);
    expect(delivery?.rows).toHaveLength(before.length);
    // the rows the fold did not name are the objects they already were — which is the whole of
    // what a memoised list item checks before it re-renders
    const untouched = before.findIndex((row) => row.id !== moved);
    expect(delivery?.rows[untouched]).toBe(before[untouched]!);
    list.release();
  });

  test("a board keeps its order when a card's rank moves", async () => {
    const ada = await openDevice("ada");
    await seeded(ada);
    const teamId = (await ada.issues.list({ workspaceId: WORKSPACE_ID }).run())[0]?.teamId ?? "";
    const board = maintaining(ada, ada.issues.board({ workspaceId: WORKSPACE_ID, teamId }));
    const before = await board.ready;
    const watch = watching(board);

    // the card and its destination taken off the board itself: a rank moved against an issue in
    // another team is a write this query never sees
    await ada.issues.move({
      workspaceId: WORKSPACE_ID,
      id: before[0]?.id ?? "",
      actorId: accountOf("ada"),
      previousId: before.at(-1)?.id ?? null,
    }).committed;
    await tick();

    const last = watch.told.at(-1);
    expect(last?.changes).toBeDefined();
    // the order is the assertion: a patched list that put the moved card back in its old slot
    // would still have the right rows in it
    const ranks = last?.rows.map((row) => row.rank) ?? [];
    expect([...ranks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ranks);
    board.release();
  });

  test("a count over the same filters re-reads, and says so by naming no delta", async () => {
    const ada = await openDevice("ada");
    await seeded(ada);
    const open = (await ada.issues.list({ workspaceId: WORKSPACE_ID }).run()).find(
      (row) => row.status === "todo",
    );
    const counts = maintaining(ada, ada.issues.counts({ workspaceId: WORKSPACE_ID }));
    await counts.ready;
    const watch = watching(counts);

    await ada.issues.setStatus({
      workspaceId: WORKSPACE_ID,
      id: open?.id ?? "",
      actorId: accountOf("ada"),
      status: "done",
    }).committed;
    await tick();

    // a `GROUP BY` row is about every row in its group, and the fold named one of them: there is
    // no patch that could be trusted, so the query is asked again and the delta is absent
    expect(watch.told.at(-1)?.changes).toBeUndefined();
    expect(watch.told.at(-1)?.rows.some((row) => row.status === "done")).toBe(true);
    counts.release();
  });
});
