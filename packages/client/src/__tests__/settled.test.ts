import type { Transport } from "@syncmesh/transport";

import { describe, expect, test } from "bun:test";

import { runTransports } from "../transports.js";

/** A source that answers when told to, and records that it was asked. */
const source = (
  name: string,
  priority: number,
  asked: string[],
): Transport & {
  readonly finish: () => void;
} => {
  let done = (): void => undefined;
  const caught = new Promise<void>((resolve) => (done = resolve));
  return {
    name,
    priority,
    start: () => Promise.resolve(),
    whenReady: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    caughtUp: () => {
      asked.push(name);
      return caught;
    },
    finish: done,
  };
};

// the mesh context a transport is started with; these sources never look at it
// SAFETY: the fakes above ignore their context entirely, so nothing here is ever read
const context = {} as Parameters<Transport["start"]>[0];

describe("source priority", () => {
  test("nearest first: a radio holding nothing never answers ahead of the relay", async () => {
    const asked: string[] = [];
    const radio = source("radio", 2, asked);
    const relay = source("relay", 1, asked);
    // configured in the wrong order on purpose: priority decides, not the array
    const links = runTransports([radio, relay], context);

    const settled = links.settled().then(() => "settled");
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    expect(asked).toEqual(["relay"]); // the radio has not even been asked yet

    radio.finish(); // the far source is done first, and that changes nothing
    await tick();
    expect(await Promise.race([settled, Promise.resolve("waiting")])).toBe("waiting");

    relay.finish();
    expect(await settled).toBe("settled");
    expect(asked).toEqual(["relay", "radio"]);
    await links.stop();
  });

  test("a source that cannot say when it is done is settled once it is ready", async () => {
    const links = runTransports(
      [
        {
          name: "quiet",
          start: () => Promise.resolve(),
          whenReady: () => Promise.resolve(),
          stop: () => Promise.resolve(),
        },
      ],
      context,
    );
    expect(await links.settled().then(() => "settled")).toBe("settled");
    await links.stop();
  });
});
