import type { Result } from "@syncmesh/result";

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { WORKSPACE, WORKSPACE_ID } from "../domain.js";
import { seedWorkspace } from "../seed.js";
import { issue } from "../tables.js";
import { T0, accountOf, openDevice, settle } from "./fixtures.js";

/**
 * The rules, refusing things.
 *
 * Every refusal below happens on the *writing* device, before the transaction commits — not
 * because the handler checked anything (none of them do) but because the same rule every
 * receiver runs is run here first. That is the property worth a test: there is one copy of the
 * rule, it lives in the manifest, and a UI that greys out a button is echoing it rather than
 * re-implementing it.
 */

/** The tag the capture threw, under Drizzle's one wrapper — the same unwrap `withMesh` does. */
const tagOf = (thrown: Error): string | undefined => {
  // SAFETY: reading an optional discriminant off an Error — absent on a plain one, which is
  // what `undefined` here means
  const tagged = (thrown.cause instanceof Error ? thrown.cause : thrown) as { _tag?: string };
  return tagged._tag;
};

/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- a thrown value is the one thing that really is unknown; naming its tag is the parse */
const why = (thrown: unknown): string =>
  thrown instanceof Error ? (tagOf(thrown) ?? thrown.message) : String(thrown);

/** What a call answered with: the rule's own tag when it refused, `"allowed"` when it did not. */
const refusal = async (call: Promise<Result<unknown, Error>>): Promise<string> => {
  const answered = await call;
  return answered.isErr() ? why(answered.error) : "allowed";
};

describe("who may do what (RFC-0008)", () => {
  test("a member may edit their own comment, and not someone else's", async () => {
    const ada = await openDevice("ada");
    const bo = await openDevice("bo");
    const chidi = await openDevice("chidi");
    const seeded = await seedWorkspace(ada.mesh.on(WORKSPACE).unwrap().db, { issues: 3, now: T0 });
    await settle(ada, bo, chidi);

    const issueId = seeded.issueIds[0] ?? "";
    const posted = (
      await bo.api.comments.post({
        workspaceId: WORKSPACE_ID,
        issueId,
        authorId: accountOf("bo"),
        body: "on it",
      }).committed
    ).unwrap();
    await settle(bo, chidi, ada);

    expect(
      await refusal(
        bo.api.comments.edit({
          workspaceId: WORKSPACE_ID,
          id: posted.data.id,
          body: "on it, tomorrow",
        }).committed,
      ),
    ).toBe("allowed");
    expect(
      await refusal(
        chidi.api.comments.edit({
          workspaceId: WORKSPACE_ID,
          id: posted.data.id,
          body: "bo is wrong",
        }).committed,
      ),
    ).toBe("PolicyDenied");

    // an admin may remove it — moderation is a job — but the edit above is still refused to them
    expect(
      await refusal(
        ada.api.comments.remove({ workspaceId: WORKSPACE_ID, id: posted.data.id }).committed,
      ),
    ).toBe("allowed");

    for (const device of [ada, bo, chidi]) await device.mesh.stop();
  });

  test("nobody posts in somebody else's name, however they address the call", async () => {
    const ada = await openDevice("ada");
    const seeded = await seedWorkspace(ada.mesh.on(WORKSPACE).unwrap().db, { issues: 3, now: T0 });
    const bo = await openDevice("bo");
    await settle(ada, bo);

    const issueId = seeded.issueIds[0] ?? "";
    expect(
      await refusal(
        bo.api.comments.post({
          workspaceId: WORKSPACE_ID,
          issueId,
          authorId: accountOf("ada"),
          body: "signed, Ada",
        }).committed,
      ),
    ).toBe("PolicyDenied");

    for (const device of [ada, bo]) await device.mesh.stop();
  });

  test("only an admin deletes a project, and `can` says so before the button is drawn", async () => {
    const ada = await openDevice("ada");
    const bo = await openDevice("bo");
    const seeded = await seedWorkspace(ada.mesh.on(WORKSPACE).unwrap().db, { issues: 3, now: T0 });
    await settle(ada, bo);

    const id = seeded.projectIds[0] ?? "";
    // the rehearsal: the write runs against the replica, is judged, and is rolled back (ch. 15)
    expect(
      (await bo.api.projects.remove.can({ workspaceId: WORKSPACE_ID, id }).run()).isErr(),
    ).toBe(true);
    expect(
      (await ada.api.projects.remove.can({ workspaceId: WORKSPACE_ID, id }).run()).isErr(),
    ).toBe(false);
    // and nothing was actually removed by asking
    expect(await ada.api.projects.list({ workspaceId: WORKSPACE_ID }).run()).toHaveLength(
      seeded.projectIds.length,
    );

    expect(await refusal(bo.api.projects.remove({ workspaceId: WORKSPACE_ID, id }).committed)).toBe(
      "PolicyDenied",
    );
    expect(
      await refusal(ada.api.projects.remove({ workspaceId: WORKSPACE_ID, id }).committed),
    ).toBe("allowed");

    // a member may still create and move one along; it is the delete that is narrowed
    expect(
      await refusal(
        bo.api.projects.create({
          workspaceId: WORKSPACE_ID,
          teamId: seeded.teamIds.ENG ?? "",
          name: "Bo's idea",
        }).committed,
      ),
    ).toBe("allowed");

    for (const device of [ada, bo]) await device.mesh.stop();
  });

  test("a guest reads the workspace and writes nothing in it", async () => {
    const ada = await openDevice("ada");
    const dalia = await openDevice("dalia");
    const seeded = await seedWorkspace(ada.mesh.on(WORKSPACE).unwrap().db, { issues: 6, now: T0 });
    await settle(ada, dalia);

    expect(await dalia.api.issues.list({ workspaceId: WORKSPACE_ID }).run()).toHaveLength(6);
    expect(await dalia.api.teams.list({ workspaceId: WORKSPACE_ID }).run()).toHaveLength(3);
    expect(
      await refusal(
        dalia.api.issues.create({
          workspaceId: WORKSPACE_ID,
          actorId: accountOf("dalia"),
          teamId: seeded.teamIds.ENG ?? "",
          title: "a guest's idea",
        }).committed,
      ),
    ).toBe("PolicyDenied");

    for (const device of [ada, dalia]) await device.mesh.stop();
  });

  test("`number` belongs to the authority: `patchOnly` refuses a member who reaches for it", async () => {
    const ada = await openDevice("ada");
    const bo = await openDevice("bo");
    const seeded = await seedWorkspace(ada.mesh.on(WORKSPACE).unwrap().db, { issues: 3, now: T0 });
    await settle(ada, bo);
    const id = seeded.issueIds[0] ?? "";

    // reaching past the procedures, straight at the table — which is exactly what a hostile
    // client would do, and exactly what the rule is there for
    const handle = bo.mesh.on(WORKSPACE).unwrap();
    const denied = await handle.db
      .transaction((tx) => tx.update(issue).set({ number: 9999 }).where(eq(issue.id, id)))
      .then(
        () => "allowed",
        (cause: unknown) => why(cause),
      );
    expect(denied).toBe("PolicyDenied");

    // the same statement without `number` in it is admitted: `patchOnly` narrows the columns,
    // not the operation
    const allowed = await handle.db
      .transaction((tx) => tx.update(issue).set({ title: "renamed" }).where(eq(issue.id, id)))
      .then(
        () => "allowed",
        (cause: unknown) => why(cause),
      );
    expect(allowed).toBe("allowed");

    for (const device of [ada, bo]) await device.mesh.stop();
  });

  test("history is appended and never revised: the manifest leaves no update to make", async () => {
    const ada = await openDevice("ada");
    const seeded = await seedWorkspace(ada.mesh.on(WORKSPACE).unwrap().db, { issues: 3, now: T0 });
    const issueId = seeded.issueIds[0] ?? "";

    const feed = await ada.api.history.forIssue({ workspaceId: WORKSPACE_ID, issueId }).run();
    expect(feed.length).toBeGreaterThan(0);
    expect(ada.mesh.can("activity.insert", undefined, WORKSPACE)).toBe(true);
    expect(ada.mesh.can("activity.update", undefined, WORKSPACE)).toBe(false);
    expect(ada.mesh.can("activity.delete", undefined, WORKSPACE)).toBe(false);

    await ada.mesh.stop();
  });
});
