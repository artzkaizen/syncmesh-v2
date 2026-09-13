import { afterEach, describe, expect, test } from "bun:test";

import { WORKSPACE } from "../domain.js";
import { seedWorkspace } from "../seed.js";
import { T0, accountOf, openDevice, settle, type Device } from "./fixtures.js";

/**
 * The question this app exists to answer: two people drag cards on two planes, and then the
 * planes land.
 */

const open = async () => {
  const ada = await openDevice("ada");
  const bo = await openDevice("bo");
  const seeded = await seedWorkspace(ada.mesh.on(WORKSPACE).unwrap(), { issues: 18, now: T0 });
  await settle(ada, bo);
  return { ada, bo, teamId: seeded.teamIds.ENG ?? "" };
};

const order = async (device: Device, teamId: string) =>
  (await device.api.issues.list({ teamId }).run()).map((row) => row.id);

let running: readonly Device[] = [];
afterEach(async () => {
  for (const device of running) await device.mesh.stop();
  running = [];
});

describe("manual order across a partition (book ch. 2, D25)", () => {
  test("two concurrent reorders both survive, and both devices end up reading the same list", async () => {
    const { ada, bo, teamId } = await open();
    running = [ada, bo];
    const before = await order(ada, teamId);
    expect(await order(bo, teamId)).toEqual(before);
    expect(before.length).toBeGreaterThan(3);

    // the radios are down. Ada pulls the last card to the very top …
    const last = before.at(-1) ?? "";
    (
      await ada.api.issues.move({
        id: last,
        actorId: accountOf("ada"),
        previousId: null,
        nextId: before[0] ?? null,
      }).committed
    ).unwrap();

    // … while Bo, elsewhere, pulls the second-to-last card between the first two
    const second = before.at(-2) ?? "";
    (
      await bo.api.issues.move({
        id: second,
        actorId: accountOf("bo"),
        previousId: before[0] ?? null,
        nextId: before[1] ?? null,
      }).committed
    ).unwrap();

    // each device sees only its own move so far
    expect((await order(ada, teamId))[0]).toBe(last);
    expect((await order(bo, teamId))[1]).toBe(second);

    await settle(ada, bo);

    // neither drag was lost, and — the property that matters — the two lists are identical
    const merged = await order(ada, teamId);
    expect(await order(bo, teamId)).toEqual(merged);
    expect(merged.indexOf(last)).toBeLessThan(merged.indexOf(second));
    expect(merged.toSorted()).toEqual(before.toSorted()); // nothing gained, nothing dropped
  });

  test("a drag across board columns moves status and rank as one event, so no device sees it torn", async () => {
    const { ada, bo, teamId } = await open();
    running = [ada, bo];
    const board = await ada.api.issues.board({ teamId }).run();
    const card = board[0] ?? { id: "", status: "triage" as const };

    (
      await ada.api.issues.move({
        id: card.id,
        actorId: accountOf("ada"),
        status: "started",
        previousId: null,
        nextId: null,
      }).committed
    ).unwrap();
    await settle(ada, bo);

    const landed = (await bo.api.issues.board({ teamId }).run()).find((row) => row.id === card.id);
    expect(landed?.status).toBe("started");
    expect(landed?.startedAt).not.toBeNull();
    // one write, one event: the history row and the move arrived together or not at all
    const feed = await bo.api.history.forIssue({ issueId: card.id }).run();
    expect(feed.some((row) => row.kind === "status" && row.toValue === "started")).toBe(true);
  });

  test("a hundred and twenty seeded issues come out in the same order on a device that only received them", async () => {
    const ada = await openDevice("ada");
    const chidi = await openDevice("chidi");
    running = [ada, chidi];
    const seeded = await seedWorkspace(ada.mesh.on(WORKSPACE).unwrap(), { now: T0 });
    await settle(ada, chidi);

    expect(seeded.issueIds).toHaveLength(120);
    const teamId = seeded.teamIds.DES ?? "";
    expect(await order(chidi, teamId)).toEqual(await order(ada, teamId));
  });
});
