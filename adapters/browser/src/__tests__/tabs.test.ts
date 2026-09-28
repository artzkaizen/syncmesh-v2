import { describe, expect, test } from "bun:test";

import type { MeshLink } from "../link.js";
import type { Tab } from "./origin.js";

import { NoRendezvous } from "../errors.js";
import { openTab, origin, settle, whoHosts } from "./origin.js";

/** Every tab's own view of who it is: what its link says, and what the host on it answers. */
const census = async (tabs: readonly Tab[]) => {
  const links = tabs.map((tab) => tab.mesh.open().unwrap());
  await settle();
  const hosts = await Promise.all(links.map(whoHosts));
  return links.map((link, at) => ({ tab: tabs[at]?.id, role: link.role, host: hosts[at] }));
};

/** Whether a link has been declared dead, asked after the fact rather than awaited. */
const watch = (link: MeshLink) => {
  let fired = false;
  link.onLost(() => {
    fired = true;
  });
  return () => fired;
};

const three = async () => {
  const where = origin();
  const tabs = [
    await openTab(where, "one"),
    await openTab(where, "two"),
    await openTab(where, "three"),
  ];
  await settle();
  return { where, tabs };
};

describe("a tab's link to the origin's mesh", () => {
  test("three tabs, exactly one leader, and it holds the one exclusive lock", async () => {
    const { where, tabs } = await three();

    const seen = await census(tabs);

    expect(seen.filter((tab) => tab.role === "leader")).toHaveLength(1);
    expect(where.room.holders()).toEqual([
      { name: "syncmesh-mesh:/syncmesh", owner: tabs[0]!.owner },
    ]);
    expect(seen[0]?.role).toBe("leader");
  });

  test("every follower reaches the same host the leader is", async () => {
    const { tabs } = await three();

    const seen = await census(tabs);

    expect(seen.map((tab) => tab.host)).toEqual(["one", "one", "one"]);
    expect(seen.map((tab) => tab.role)).toEqual(["leader", "follower", "follower"]);
  });

  test("closing the leader promotes exactly one survivor and re-plumbs the rest", async () => {
    const { where, tabs } = await three();
    const [leader, ...survivors] = tabs;
    const links = survivors.map((tab) => tab.mesh.open().unwrap());
    const lost = links.map(watch);
    await settle();
    expect(where.room.holders()[0]?.owner).toBe(leader?.owner);

    leader?.close();
    await settle();

    expect(lost.map((fired) => fired())).toEqual([true, true]);
    expect(where.room.holders()).toEqual([
      { name: "syncmesh-mesh:/syncmesh", owner: survivors[0]!.owner },
    ]);
    const seen = await census(survivors);
    expect(seen.map((tab) => tab.role)).toEqual(["leader", "follower"]);
    expect(seen.map((tab) => tab.host)).toEqual(["two", "two"]);
  });

  test("a lost link is closed, so nothing reads from a port whose host is gone", async () => {
    const { tabs } = await three();
    const follower = tabs[1]!.mesh.open().unwrap();
    await settle();
    expect(await whoHosts(follower)).toBe("one");

    tabs[0]?.close();
    await settle();

    let answered = false;
    follower.port.onmessage = () => void (answered = true);
    follower.port.postMessage("who");
    await settle();
    expect(answered).toBe(false);
  });

  test("handover survives twice, and never leaves two tabs believing they are leader", async () => {
    const { where, tabs } = await three();

    tabs[0]?.close();
    await settle();
    tabs[1]?.close();
    await settle();

    const seen = await census([tabs[2]!]);
    expect(seen).toEqual([{ tab: "three", role: "leader", host: "three" }]);
    expect(where.room.holders()).toEqual([
      { name: "syncmesh-mesh:/syncmesh", owner: tabs[2]!.owner },
    ]);
  });

  test("without a rendezvous the elected tab hosts and the rest are told which mode they are in", async () => {
    const where = origin();
    const leader = await openTab(where, "only", false);
    const other = await openTab(where, "second", false);

    expect(leader.mesh.open().unwrap().role).toBe("leader");
    const refused = other.mesh.open();
    expect(refused.isErr() ? refused.error : undefined).toBeInstanceOf(NoRendezvous);
    expect(refused.isErr() ? refused.error.reason : undefined).toBe("declined");
    expect(where.room.holders()).toEqual([
      { name: "syncmesh-mesh:/syncmesh", owner: leader.owner },
    ]);
  });

  test("a single-tab follower becomes the host when the durable tab closes", async () => {
    const where = origin();
    const leader = await openTab(where, "only", false);
    const other = await openTab(where, "second", false);
    expect(other.mesh.open().isErr()).toBe(true);

    leader.close();
    await settle();

    const promoted = other.mesh.open().unwrap();
    expect(promoted.role).toBe("leader");
    expect(await whoHosts(promoted)).toBe("second");
  });
});
