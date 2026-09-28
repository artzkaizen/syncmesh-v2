import { describe, expect, test } from "bun:test";

import { ISSUE_STATUS, WORKSPACE, WORKSPACE_ID } from "../domain.js";
import { seedConversation, seedWorkspace } from "../seed.js";
import { T0, accountOf, openDevice, settle } from "./fixtures.js";

/**
 * The read surface a screen actually calls, over the seeded workspace — plus the two edges of
 * the manifest a test is the only honest way to show: presence, and the sealed partition.
 */

const seeded = async () => {
  const ada = await openDevice("ada");
  const workspace = await seedWorkspace(ada.$mesh.on(WORKSPACE).unwrap().db, { now: T0 });
  return { ada, workspace };
};

describe("the seeded workspace", () => {
  test("is substantial, and is the same workspace every run", async () => {
    const { ada, workspace } = await seeded();
    expect(workspace.issueIds).toHaveLength(120);
    expect(workspace.memberIds).toHaveLength(12);
    expect(workspace.projectIds).toHaveLength(6);
    expect(Object.keys(workspace.teamIds)).toEqual(["ENG", "DES", "OPS"]);

    const summary = (await ada.issues.summary({ workspaceId: WORKSPACE_ID })["~mesh"].run())[0];
    expect(summary?.total).toBe(120);
    // every fourth issue is left unnumbered on purpose: what a tracker looks like mid-flight
    expect(summary?.unnumbered).toBe(30);

    // the same seed on a fresh, unconnected device produces the same workspace, row for row
    const again = await openDevice("ada");
    const twice = await seedWorkspace(again.$mesh.on(WORKSPACE).unwrap().db, { now: T0 });
    expect(twice.issueIds).toEqual(workspace.issueIds);
    expect(
      await again.issues
        .list({ workspaceId: WORKSPACE_ID, teamId: twice.teamIds.ENG ?? "" })
        ["~mesh"].run(),
    ).toEqual(
      await ada.issues
        .list({ workspaceId: WORKSPACE_ID, teamId: workspace.teamIds.ENG ?? "" })
        ["~mesh"].run(),
    );

    for (const device of [ada, again]) await device.$mesh.stop();
  });

  test("answers the questions a Linear-shaped screen asks", async () => {
    const { ada, workspace } = await seeded();
    const teamId = workspace.teamIds.ENG ?? "";

    const board = await ada.issues.board({ workspaceId: WORKSPACE_ID, teamId })["~mesh"].run();
    expect(board.every((row) => row.teamId === teamId)).toBe(true);
    expect(board.every((row) => row.status !== "done" && row.status !== "canceled")).toBe(true);

    const counts = await ada.issues.counts({ workspaceId: WORKSPACE_ID, teamId })["~mesh"].run();
    expect(counts.reduce((held, row) => held + row.total, 0)).toBe(40);
    expect(counts.every((row) => ISSUE_STATUS.some((known) => known === row.status))).toBe(true);

    // a grouped board pages per column, not on a flat limit: the first N of *every* status,
    // so a column whose issues all rank late is filled from its own ranking rather than starved
    // by a shared one. One statement, so a drag across columns still re-reads atomically.
    const windowed = await ada.issues
      .list({ workspaceId: WORKSPACE_ID, teamId, perStatus: 2 })
      ["~mesh"].run();
    const perStatus = new Map<string, number>();
    for (const row of windowed) perStatus.set(row.status, (perStatus.get(row.status) ?? 0) + 1);
    expect([...perStatus.values()].every((n) => n <= 2)).toBe(true);

    // every status that has any issue at all is represented — the starvation this exists to fix
    const present = new Set(
      (await ada.issues.list({ workspaceId: WORKSPACE_ID, teamId })["~mesh"].run()).map(
        (r) => r.status,
      ),
    );
    expect(new Set(perStatus.keys())).toEqual(present);

    // and the badge beside it is counted without the window, so "more" is two exact numbers
    const badges = await ada.issues.counts({ workspaceId: WORKSPACE_ID, teamId })["~mesh"].run();
    const todo = badges.find((r) => r.status === "todo");
    expect(todo === undefined || todo.total >= (perStatus.get("todo") ?? 0)).toBe(true);

    const mine = await ada.issues
      .assigned({ workspaceId: WORKSPACE_ID, assigneeId: workspace.memberIds[0] ?? "" })
      ["~mesh"].run();
    expect(mine.every((row) => row.assigneeId === workspace.memberIds[0])).toBe(true);

    const found = await ada.issues
      .search({ workspaceId: WORKSPACE_ID, text: "relay" })
      ["~mesh"].run();
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((row) => /relay/i.test(`${row.title} ${row.description}`))).toBe(true);

    // a search term with a LIKE wildcard in it is a term, not a pattern
    expect(
      await ada.issues.search({ workspaceId: WORKSPACE_ID, text: "%" })["~mesh"].run(),
    ).toHaveLength(0);

    const byProject = await ada.issues
      .list({ workspaceId: WORKSPACE_ID, projectId: workspace.projectIds[0] ?? "" })
      ["~mesh"].run();
    expect(byProject.length).toBeGreaterThan(0);

    const totals = await ada.issues.labelTotals({ workspaceId: WORKSPACE_ID })["~mesh"].run();
    expect(totals.length).toBeGreaterThan(3);

    await ada.$mesh.stop();
  });

  test("a conversation in more than one voice needs a device per voice, and gets one", async () => {
    const ada = await openDevice("ada");
    const bo = await openDevice("bo");
    const chidi = await openDevice("chidi");
    const workspace = await seedWorkspace(ada.$mesh.on(WORKSPACE).unwrap().db, {
      issues: 12,
      now: T0,
    });
    await settle(ada, bo, chidi);

    const written = await seedConversation(
      [
        { account: accountOf("bo"), mesh: bo.$mesh.on(WORKSPACE).unwrap() },
        { account: accountOf("chidi"), mesh: chidi.$mesh.on(WORKSPACE).unwrap() },
      ],
      workspace.issueIds,
      { now: T0 },
    );
    expect(written).toBe(12);
    await settle(bo, chidi, ada);

    const voices = new Set<string>();
    for (const issueId of workspace.issueIds)
      for (const row of await ada.comments
        .forIssue({ workspaceId: WORKSPACE_ID, issueId })
        ["~mesh"].run())
        voices.add(row.authorId);
    expect(voices).toContain(accountOf("bo"));
    expect(voices).toContain(accountOf("chidi"));

    // a thread pages backwards on `(createdAt, id)`: newest first, resuming strictly before the
    // oldest row drawn. Two pages must not overlap and must not skip — the `id` tiebreak is what
    // holds when two comments share a millisecond, which seeded conversations do.
    let issueId = "";
    let total = 0;
    for (const candidate of workspace.issueIds) {
      const held =
        (
          await ada.comments.total({ workspaceId: WORKSPACE_ID, issueId: candidate })["~mesh"].run()
        )[0]?.total ?? 0;
      if (held > total) {
        total = held;
        issueId = candidate;
      }
    }
    // the seeded conversation has to give us something to page, or this asserts nothing
    expect(total).toBeGreaterThan(2);
    {
      const first = await ada.comments
        .forIssue({ workspaceId: WORKSPACE_ID, issueId, limit: 2 })
        ["~mesh"].run();
      expect(first).toHaveLength(2);
      const oldest = first.at(-1);
      const next = await ada.comments
        .forIssue({
          workspaceId: WORKSPACE_ID,
          issueId,
          limit: 2,
          before: { at: (oldest?.createdAt ?? new Date()).getTime(), id: oldest?.id ?? "" },
        })
        ["~mesh"].run();
      const seen = new Set(first.map((row) => row.id));
      expect(next.every((row) => !seen.has(row.id))).toBe(true);
      // newest first: every row of the second page is older than the last of the first
      expect(next.every((row) => row.createdAt <= (oldest?.createdAt ?? new Date()))).toBe(true);
      // and the count beside it is the whole thread, not the page
      expect(total).toBeGreaterThanOrEqual(first.length + next.length);
    }

    for (const device of [ada, bo, chidi]) await device.$mesh.stop();
  });

  test("who is looking at this issue is presence, and never a row", async () => {
    const { ada, workspace } = await seeded();
    const issueId = workspace.issueIds[0] ?? "";
    const viewing = ada.$mesh.presence(WORKSPACE).viewing;

    viewing.set({ issueId, typing: false });
    expect(viewing.peers().map((peer) => peer.value)).toEqual([{ issueId, typing: false }]);
    viewing.set({ issueId, typing: true });
    expect(viewing.peers()[0]?.value.typing).toBe(true);
    viewing.clear();
    expect(viewing.peers()).toEqual([]);

    await ada.$mesh.stop();
  });

  test("the sealed partition is a wall, not a label: no key, no handle", async () => {
    const ada = await openDevice("ada");
    // Ada is an admin of the workspace and it makes no difference. `embargo` is sealed, her
    // device holds no content key for this one, and a key arrives only inside a grant.
    const opened = ada.$mesh.on("embargo:acme-2026-001");
    expect(opened.isErr()).toBe(true);
    expect(String(opened.isErr() ? opened.error.message : "")).toMatch(/sealed/);
    // the unsealed workspace beside it opens exactly as before
    expect(ada.$mesh.on(WORKSPACE).isOk()).toBe(true);

    await ada.$mesh.stop();
  });
});
