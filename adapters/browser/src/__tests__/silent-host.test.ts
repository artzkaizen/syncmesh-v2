import { describe, expect, test } from "bun:test";

import { linkOver } from "../link.js";
import { MeshHostGone } from "../protocol.js";
import { openWire } from "../wire.js";

/**
 * A port to a worker that is not there any more.
 *
 * This is the shape a refresh can leave behind: a tab contends, is told it is a follower because
 * the outgoing incarnation still holds the lock, and is handed a port to a worker in the middle of
 * being torn down. `link.ts` says why nothing else can notice — "a `MessagePort` has no death of
 * its own to report — it stays open and silent when the context at the other end is gone" — and
 * the election, which is the better witness, has nothing further to say about a port it already
 * handed over. So the tab waits, and every read it will ever make waits behind it: the list on
 * "Reading the local replica…", the panel on "Opening…", for ever.
 *
 * The one party that can tell is the one waiting. It presumes death, the link says so, and the app
 * asks for a new one.
 */
describe("a host that takes the question and never answers", () => {
  test("the ask fails and the link is declared lost, rather than hanging", async () => {
    const channel = new MessageChannel();
    // nobody is serving channel.port2: the worker it belonged to is gone
    const link = linkOver(channel.port1, "follower");
    let lost = 0;
    link.onLost(() => (lost += 1));

    const wire = openWire(link, 40);
    const asked = wire.ask<string>({ kind: "call", path: "self", args: [] });

    let refusal: unknown;
    try {
      await asked;
    } catch (cause) {
      refusal = cause;
    }
    expect(refusal).toBeInstanceOf(MeshHostGone);
    expect(lost).toBe(1);
    wire.close();
    channel.port1.close();
    channel.port2.close();
  });

  test("an answer keeps the clock from running out", async () => {
    const channel = new MessageChannel();
    channel.port2.onmessage = (event) => {
      // SAFETY: the only sender is the wire under test, whose every post carries the id it paired
      const { id } = event.data as { id: number };
      // slow, but alive — and answering is what proves it
      setTimeout(() => channel.port2.postMessage({ id, ok: true, value: "peer-1" }), 30);
    };
    const link = linkOver(channel.port1, "follower");
    let lost = 0;
    link.onLost(() => (lost += 1));

    const wire = openWire(link, 120);
    expect(await wire.ask<string>({ kind: "call", path: "self", args: [] })).toBe("peer-1");
    expect(lost).toBe(0);
    wire.close();
    channel.port1.close();
    channel.port2.close();
  });
});
