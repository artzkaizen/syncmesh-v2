import { describe, expect, test } from "bun:test";

import { PER_STATUS, issuesCall } from "../app/use-issues.js";
import { NO_FILTERS } from "../app/view.js";
import { WORKSPACE } from "../domain.js";
import { seedWorkspace } from "../seed.js";
import { T0, openDevice } from "./fixtures.js";

/**
 * Which question the list screen is asking, over a real device.
 *
 * The hook itself is three lines and needs a DOM; the decision inside it does not, which is why
 * `issuesCall` is exported apart from `useIssues`. What is worth checking is that the header's
 * search box **switches** the read rather than adding a second one: the descriptor is picked, so
 * clearing the box has to land back on the identical question — same procedure, same key,
 * therefore the same subscription — and not on a second list that merely resembles the first.
 */

const seeded = async () => {
  const ada = await openDevice("ada");
  const workspace = await seedWorkspace(ada.$mesh.on(WORKSPACE).unwrap().db, { now: T0 });
  return { ada, workspace };
};

describe("the screen's one read of the issues", () => {
  test("searching and then clearing gets back exactly the list that was there before", async () => {
    const { ada } = await seeded();

    const first = issuesCall(ada, NO_FILTERS, PER_STATUS);
    const listed = await first.run();
    expect(listed.length).toBeGreaterThan(0);

    // somebody types: a different procedure, a different key, and genuinely different rows
    const searching = issuesCall(ada, { ...NO_FILTERS, text: "relay" }, PER_STATUS);
    const found = await searching.run();
    expect(found.length).toBeGreaterThan(0);
    expect(searching.key).not.toBe(first.key);
    expect(found).not.toEqual(listed);

    // and clears it again — whitespace included, because that is what a half-deleted box holds
    const cleared = issuesCall(ada, { ...NO_FILTERS, text: "  " }, PER_STATUS);
    expect(cleared.key).toBe(first.key);
    expect(await cleared.run()).toEqual(listed);

    await ada.$mesh.stop();
  });

  test("the text chooses the procedure; the filters travel with the list it chose", async () => {
    const { ada, workspace } = await seeded();
    const teamId = workspace.teamIds.ENG ?? "";

    const filtered = issuesCall(ada, { ...NO_FILTERS, teamId }, PER_STATUS);
    expect(filtered.path).toBe("issues.list");
    const rows = await filtered.run();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.teamId === teamId)).toBe(true);

    expect(issuesCall(ada, { ...NO_FILTERS, teamId, text: "relay" }, PER_STATUS).path).toBe(
      "issues.search",
    );

    await ada.$mesh.stop();
  });
});
