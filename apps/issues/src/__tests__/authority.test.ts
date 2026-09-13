import { describe, expect, test } from "bun:test";

import { WORKSPACE_ID } from "../domain.js";
import {
  accountOf,
  openAuthority,
  openDevice,
  openDeviceWithAuthority,
  settle,
} from "./fixtures.js";

/**
 * `ENG-42`: the one call in this tracker that needs a server, over the wire that actually
 * carries it.
 */

const workspace = async () => {
  const authority = await openAuthority();
  const bo = await openDeviceWithAuthority("bo", authority.url);
  const ada = await openDevice("ada");
  const team = (
    await ada.teams.create({
      workspaceId: WORKSPACE_ID,
      key: "ENG",
      name: "Engineering",
      color: "#5E6AD2",
    }).committed
  ).unwrap();
  await settle(ada, authority.server, bo);
  return { authority, bo, ada, teamId: team.data.id };
};

const file = async (
  device: Awaited<ReturnType<typeof openDeviceWithAuthority>>,
  teamId: string,
  title: string,
) =>
  (
    await device.issues.create({
      workspaceId: WORKSPACE_ID,
      actorId: accountOf("bo"),
      teamId,
      title,
    }).committed
  ).unwrap().data.id;

describe("the one call a device cannot make for itself (D10, book ch. 7)", () => {
  test("an issue is filed offline with no number, and numbered when a server is reachable", async () => {
    const { authority, bo, ada, teamId } = await workspace();
    const id = await file(bo, teamId, "the board tears on a slow fold");

    // filed and usable with no server in sight: the tracker does not wait to be given a name
    expect((await bo.issues.get({ workspaceId: WORKSPACE_ID, id }).run())[0]?.number).toBeNull();
    expect((await bo.issues.summary({ workspaceId: WORKSPACE_ID }).run())[0]?.unnumbered).toBe(1);

    await settle(bo, authority.server);
    const claimed = (
      await bo.issues.claimNumber({ workspaceId: WORKSPACE_ID, issueId: id })
    ).unwrap();
    expect(claimed).toEqual({ number: 1, identifier: "ENG-1" });

    // the authority's write is an ordinary event, so it folds on every device like any other
    await settle(authority.server, bo, ada);
    expect((await ada.issues.get({ workspaceId: WORKSPACE_ID, id }).run())[0]?.number).toBe(1);
    const feed = await ada.history.forIssue({ workspaceId: WORKSPACE_ID, issueId: id }).run();
    expect(feed.at(-1)).toMatchObject({ kind: "numbered", toValue: "1", actorId: "authority" });

    await authority.stop();
    for (const device of [bo, ada]) await device.$mesh.stop();
  });

  test("the sequence is gapless per team, and asking twice does not burn a number", async () => {
    const { authority, bo, teamId } = await workspace();
    const first = await file(bo, teamId, "one");
    const second = await file(bo, teamId, "two");
    await settle(bo, authority.server);

    expect(
      (await bo.issues.claimNumber({ workspaceId: WORKSPACE_ID, issueId: first })).unwrap().number,
    ).toBe(1);
    expect(
      (await bo.issues.claimNumber({ workspaceId: WORKSPACE_ID, issueId: second })).unwrap().number,
    ).toBe(2);
    // the retry after a timeout — the ordinary case on the train this was filed from
    expect(
      (await bo.issues.claimNumber({ workspaceId: WORKSPACE_ID, issueId: first })).unwrap(),
    ).toEqual({
      number: 1,
      identifier: "ENG-1",
    });

    await authority.stop();
    await bo.$mesh.stop();
  });

  test("an issue the authority has not received yet is refused by name, not by silence", async () => {
    const { authority, bo, teamId } = await workspace();
    const id = await file(bo, teamId, "still on the train");
    // deliberately no settle: the authority has never heard of this issue
    const answered = await bo.issues.claimNumber({ workspaceId: WORKSPACE_ID, issueId: id });
    expect(answered.isErr()).toBe(true);
    expect(String(answered.isErr() ? answered.error.message : "")).toMatch(/has not reached/i);

    await authority.stop();
    await bo.$mesh.stop();
  });

  test("a device with no link says so, rather than pretending the call did nothing", async () => {
    const alone = await openDevice("bo");
    const answered = await alone.issues.claimNumber({
      workspaceId: WORKSPACE_ID,
      issueId: "whatever",
    });
    expect(answered.isErr()).toBe(true);
    expect(String(answered.isErr() ? answered.error.message : "")).toMatch(/runs on the authority/);
    await alone.$mesh.stop();
  });
});
