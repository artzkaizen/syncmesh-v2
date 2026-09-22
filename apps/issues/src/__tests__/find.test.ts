import { describe, expect, test } from "bun:test";

import { WORKSPACE, WORKSPACE_ID } from "../domain.js";
import { seedWorkspace } from "../seed.js";
import { T0, accountOf, openDevice } from "./fixtures.js";

/**
 * Finding an issue by the thing a person has in front of them.
 *
 * `ENG-42` is what appears in a commit message, a standup and a Slack thread, so it is what gets
 * typed into a search box — and a search that only matched title and description answered "no
 * results" to the most common query a tracker receives. Worth a test rather than a click-through
 * because the failure is silent in the direction that matters: an identifier search that quietly
 * falls back to a text match returns *something*, and the something looks plausible.
 */

const seeded = async () => {
  const ada = await openDevice("ada");
  const workspace = await seedWorkspace(ada.$mesh.on(WORKSPACE).unwrap().db, { now: T0 });
  return { ada, workspace };
};

const find = async (device: Awaited<ReturnType<typeof openDevice>>, text: string) =>
  device.issues.search({ workspaceId: WORKSPACE_ID, text })["~mesh"].run();

describe("searching for an issue", () => {
  test("finds one by its number, however the identifier was typed", async () => {
    const { ada } = await seeded();
    const listed = await ada.issues.list({ workspaceId: WORKSPACE_ID })["~mesh"].run();
    const numbered = listed.find((row) => row.number !== null);
    expect(numbered).toBeDefined();
    const number = numbered?.number ?? 0;

    // the four shapes the same question is asked in, and the same issue on top of all four
    for (const typed of [
      String(number),
      `#${String(number)}`,
      `ENG-${String(number)}`,
      `eng ${String(number)}`,
    ]) {
      const hits = await find(ada, typed);
      expect(hits[0]?.number).toBe(number);
    }

    await ada.$mesh.stop();
  });

  test("an exact number beats a title that merely contains the digits", async () => {
    const { ada, workspace } = await seeded();
    const teamId = workspace.teamIds.ENG ?? "";
    // a title carrying the digits of another issue's number is the case a `LIKE` gets wrong
    await ada.issues.create({
      workspaceId: WORKSPACE_ID,
      actorId: accountOf("ada"),
      teamId,
      title: "Bump the timeout to 7 seconds",
    }).committed;

    const hits = await find(ada, "7");
    // the seed numbers three of every four issues from 1, so number 7 exists to be found
    expect(hits.some((row) => row.number === 7)).toBe(true);
    // and it is first: an exact identifier match outranks a title that merely contains the digit
    expect(hits[0]?.number).toBe(7);

    await ada.$mesh.stop();
  });

  test("still searches text when there is no number in what was typed", async () => {
    const { ada } = await seeded();
    const hits = await find(ada, "relay");
    expect(hits.length).toBeGreaterThan(0);
    for (const row of hits) {
      const haystack = `${row.title} ${row.description}`.toLowerCase();
      expect(haystack).toContain("relay");
    }
    await ada.$mesh.stop();
  });
});
