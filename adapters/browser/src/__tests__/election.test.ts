import { describe, expect, test } from "bun:test";

import type { Control, Standing } from "../election.js";
import type { HostScope } from "../host-worker.js";

import { elect } from "../election.js";
import { hostOn } from "../host-worker.js";
import { lockRoom, settle } from "./origin.js";

const LOCK = "syncmesh-mesh:/syncmesh";

let contenders = 0;

/** One contender, and everything it was told, in the order it was told it. */
const contender = (room: ReturnType<typeof lockRoom>) => {
  const owner = { tab: `tab-${(contenders += 1)}` };
  const told: Standing[] = [];
  elect(room.elector(owner), LOCK, (standing) => told.push(standing));
  return { owner, told };
};

describe("elect", () => {
  test("the first contender is leader and the rest are told so before anything else", () => {
    const room = lockRoom();
    const tabs = [contender(room), contender(room), contender(room)];

    expect(tabs.map((tab) => tab.told)).toEqual([
      [{ kind: "role", leader: true }],
      [{ kind: "role", leader: false }],
      [{ kind: "role", leader: false }],
    ]);
    expect(room.holders().map((lock) => lock.name)).toEqual([LOCK]);
  });

  test("a leader that dies promotes exactly one follower", () => {
    const room = lockRoom();
    const [leader, ...followers] = [contender(room), contender(room), contender(room)];

    room.kill(leader.owner);

    const promoted = followers.filter((tab) =>
      tab.told.some((standing) => standing.kind === "elected"),
    );
    expect(promoted).toHaveLength(1);
    expect(room.holders()).toEqual([{ name: LOCK, owner: promoted[0]!.owner }]);
  });

  test("the promotion walks the queue in order, one tab at a time", () => {
    const room = lockRoom();
    const [first, second, third] = [contender(room), contender(room), contender(room)];

    room.kill(first.owner);
    expect(second.told.at(-1)).toEqual({ kind: "elected" });
    expect(third.told.at(-1)).toEqual({ kind: "role", leader: false });

    room.kill(second.owner);
    expect(third.told.at(-1)).toEqual({ kind: "elected" });
    expect(room.holders()).toEqual([{ name: LOCK, owner: third.owner }]);
  });

  test("a follower that closes before its turn is skipped rather than holding the queue", () => {
    const room = lockRoom();
    const [leader, quitter, survivor] = [contender(room), contender(room), contender(room)];

    room.kill(quitter.owner);
    room.kill(leader.owner);

    expect(quitter.told).toEqual([{ kind: "role", leader: false }]);
    expect(survivor.told.at(-1)).toEqual({ kind: "elected" });
  });

  test("a worker with no LockManager elects nobody rather than assuming it is alone", async () => {
    const control = new MessageChannel();
    const told: unknown[] = [];
    const scope: HostScope = {
      postMessage: (standing) => void told.push(standing),
      onmessage: null,
    };
    control.port2.onmessage = (event) => scope.onmessage?.(event);
    hostOn(scope, () => undefined);

    control.port1.postMessage({ kind: "contend", lock: LOCK } satisfies Control);
    await settle();

    expect(told).toEqual([{ kind: "unelectable" }]);
  });
});
