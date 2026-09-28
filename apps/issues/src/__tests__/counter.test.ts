import { describe, expect, test } from "bun:test";

import { WORKSPACE, WORKSPACE_ID } from "../domain.js";
import { seedWorkspace } from "../seed.js";
import { T0, accountOf, openDevice, settle, type Device } from "./fixtures.js";

/**
 * The one column in this tracker that is not last-writer-wins, and what goes wrong without it.
 */

const viewsOf = async (device: Device, id: string) =>
  (await device.issues.get({ workspaceId: WORKSPACE_ID, id })["~mesh"].run())[0]?.views ?? -1;

describe("view counts across a partition (book ch. 2)", () => {
  test("two devices counting while apart sum, rather than one of them winning", async () => {
    const ada = await openDevice("ada");
    const bo = await openDevice("bo");
    const chidi = await openDevice("chidi");
    const seeded = await seedWorkspace(ada.$mesh.on(WORKSPACE).unwrap().db, { issues: 6, now: T0 });
    await settle(ada, bo, chidi);

    const id = seeded.issueIds[0] ?? "";
    const start = await viewsOf(ada, id);
    expect(await viewsOf(bo, id)).toBe(start);

    // the radios are down; three people read the same issue a different number of times
    for (let opened = 0; opened < 3; opened += 1)
      (await ada.issues.view({ workspaceId: WORKSPACE_ID, id }).committed).unwrap();
    for (let opened = 0; opened < 2; opened += 1)
      (await bo.issues.view({ workspaceId: WORKSPACE_ID, id }).committed).unwrap();
    (await chidi.issues.view({ workspaceId: WORKSPACE_ID, id }).committed).unwrap();

    // apart, each device knows only its own reading
    expect(await viewsOf(ada, id)).toBe(start + 3);
    expect(await viewsOf(bo, id)).toBe(start + 2);

    await settle(ada, bo, chidi);

    // last-writer-wins would have landed on +1, +2 or +3; the PN-counter lands on all six
    for (const device of [ada, bo, chidi]) expect(await viewsOf(device, id)).toBe(start + 6);

    for (const device of [ada, bo, chidi]) await device.$mesh.stop();
  });

  test("a view is not an edit: the counter moves and `updatedAt` does not", async () => {
    const ada = await openDevice("ada");
    const seeded = await seedWorkspace(ada.$mesh.on(WORKSPACE).unwrap().db, { issues: 3, now: T0 });
    const id = seeded.issueIds[0] ?? "";
    const before = (await ada.issues.get({ workspaceId: WORKSPACE_ID, id })["~mesh"].run())[0];

    (await ada.issues.view({ workspaceId: WORKSPACE_ID, id }).committed).unwrap();
    const after = (await ada.issues.get({ workspaceId: WORKSPACE_ID, id })["~mesh"].run())[0];

    expect(after?.views).toBe((before?.views ?? 0) + 1);
    // otherwise every issue anyone glanced at would float to the top of "recently updated"
    expect(after?.updatedAt).toEqual(before?.updatedAt ?? new Date(0));
    await ada.$mesh.stop();
  });

  test("reactions are rows, so two people reacting while apart both keep their reaction", async () => {
    const ada = await openDevice("ada");
    const bo = await openDevice("bo");
    const seeded = await seedWorkspace(ada.$mesh.on(WORKSPACE).unwrap().db, { issues: 3, now: T0 });
    await settle(ada, bo);
    const subjectId = seeded.issueIds[1] ?? "";

    (
      await ada.reactions.add({
        workspaceId: WORKSPACE_ID,
        subject: "issue",
        subjectId,
        emoji: "🚀",
        actorId: accountOf("ada"),
      }).committed
    ).unwrap();
    (
      await bo.reactions.add({
        workspaceId: WORKSPACE_ID,
        subject: "issue",
        subjectId,
        emoji: "🚀",
        actorId: accountOf("bo"),
      }).committed
    ).unwrap();
    await settle(ada, bo);

    const tally = await bo.reactions
      .tally({ workspaceId: WORKSPACE_ID, subject: "issue", subjectId })
      ["~mesh"].run();
    expect(tally).toEqual([{ emoji: "🚀", total: 2 }]);

    // Tapping it again is the same row, because the key is (actor, subject, emoji). The write
    // therefore stages nothing, and a mutation that staged nothing reports that it has no event
    // to hand back — honest, and something an idempotent call has to be ready for.
    const again = await bo.reactions.add({
      workspaceId: WORKSPACE_ID,
      subject: "issue",
      subjectId,
      emoji: "🚀",
      actorId: accountOf("bo"),
    }).committed;
    expect(again.isErr()).toBe(true);
    expect(
      await bo.reactions
        .tally({ workspaceId: WORKSPACE_ID, subject: "issue", subjectId })
        ["~mesh"].run(),
    ).toEqual([{ emoji: "🚀", total: 2 }]);

    for (const device of [ada, bo]) await device.$mesh.stop();
  });
});
