import { Temporal } from "@syncmesh/temporal";
import { decodeFrame } from "@syncmesh/transport";
import { signPresence } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createPresenceHold } from "../presence-hold.js";
import { ACME, peer, tick } from "./fixtures.js";

const a = peer(40, "acct_a");
const value = (topic: string, count: number) =>
  signPresence(
    {
      v: 1,
      peerId: a.identity.peerId,
      topic,
      partition: ACME,
      session: "s1",
      count,
      // SAFETY: test fixture column name; names are brands over these strings
      value: new Map([["x" as never, count]]),
      expires: Date.now() + 60_000,
    },
    a.identity,
  ).wire;

const RECHECK = Temporal.Duration.from({ milliseconds: 2 });

/** A socket whose buffer the test fills and empties, and the presence values that reached it. */
const socket = () => {
  const sent: Uint8Array[] = [];
  const state = { buffered: 0 };
  const dial = { buffered: () => state.buffered };
  const send = (frame: Uint8Array): void => {
    const decoded = decodeFrame(frame).unwrap();
    if (decoded.kind === "presence") sent.push(decoded.wire);
  };
  return { sent, state, dial, send };
};

describe("createPresenceHold (D16, the device's half)", () => {
  test("while the socket's buffer is behind, only the newest value per slot leaves once it empties", async () => {
    const s = socket();
    s.state.buffered = 4096;
    const hold = createPresenceHold(s.send, () => s.dial, RECHECK);
    const cursors = Array.from({ length: 30 }, (_, n) => value("cursor", n + 1));
    for (const wire of cursors) hold.offer(wire);
    const typing = value("typing", 1);
    hold.offer(typing);
    await tick(10);
    expect(s.sent).toHaveLength(0); // nothing joined the socket's own queue
    expect(hold.size()).toBe(2);

    s.state.buffered = 0;
    await tick(10);
    expect(s.sent).toEqual([cursors.at(-1) ?? new Uint8Array(), typing]);
    expect(hold.size()).toBe(0);
  });

  test("a socket that holds nothing sends each value at once", () => {
    const s = socket();
    const hold = createPresenceHold(s.send, () => s.dial, RECHECK);
    hold.offer(value("cursor", 1));
    hold.offer(value("cursor", 2));
    expect(s.sent).toHaveLength(2);
  });

  test("what was held for a socket that went away is dropped, not sent on the next one", async () => {
    const s = socket();
    s.state.buffered = 1;
    let current: typeof s.dial | undefined = s.dial;
    const hold = createPresenceHold(s.send, () => current, RECHECK);
    hold.offer(value("cursor", 1));
    current = undefined;
    await tick(10);
    expect(hold.size()).toBe(0);
    current = { buffered: () => 0 };
    await tick(10);
    expect(s.sent).toHaveLength(0);
  });
});
