import type { Interest } from "@syncmesh/engine";

import { interestText } from "@syncmesh/engine";
import { describe, expect, test } from "bun:test";

import type { Peer } from "./fixtures.js";

import { bridgeFramedLink } from "../bridge.js";
import { decodeFrame } from "../frame.js";
import { loopbackPair } from "../link.js";
import { ACME, GLOBEX, T0, bodyOf, peer, write } from "./fixtures.js";

/**
 * A holder and a device on one loopback, the device's link asking with `interest`; every cursors
 * frame the device sends is kept, so a test can say whether it asked from nothing.
 */
const link = (holder: Peer, device: Peer, interest?: Interest) => {
  const { a, b, control } = loopbackPair();
  const asked: number[] = [];
  const watched = {
    ...b,
    send: (bytes: Uint8Array) => {
      const frame = decodeFrame(bytes);
      if (frame.isOk() && frame.value.kind === "cursors") asked.push(frame.value.cursors.size);
      b.send(bytes);
    },
  };
  const side = (p: Peer, end: typeof a, wanted?: Interest) =>
    bridgeFramedLink(end, {
      engine: p.engine,
      identity: p.identity,
      grants: p.grants,
      now: () => T0,
      ...(wanted !== undefined && { interest: wanted }),
    });
  const held = side(holder, a);
  const asking = side(device, watched, interest);
  const settle = async () => {
    for (let round = 0; round < 8; round += 1) {
      await control.flush();
      await held.flush();
      await asking.flush();
    }
  };
  return { asked, settle, close: () => [held.close(), asking.close()] };
};

describe("a peer link asking for more than its cursors are scoped to (D23, O13)", () => {
  test("narrowing then widening re-pages what the narrow scope skipped", async () => {
    const holder = peer(40, "acct_x");
    const device = peer(80, "acct_y");
    (await write(holder, "a1", "acme one")).unwrap();
    (await write(holder, "g1", "globex", GLOBEX)).unwrap();
    (await write(holder, "a2", "acme two")).unwrap();

    // narrowed: state for acme alone, whose coverage stands past globex's event as well
    const acme = { partitions: [ACME] };
    await device.engine.installSnapshot(holder.engine.snapshot({ interest: acme }));
    expect(device.engine.coverage().scope).toBe(interestText(acme));
    expect(bodyOf(device, "g1")).toBeUndefined();

    // widened: a link asking for everything would otherwise answer the cursor at 3 with nothing
    const wide = link(holder, device);
    await wide.settle();
    expect(wide.asked[0]).toBe(0);
    expect(bodyOf(device, "g1")).toBe("globex");
    wide.close();

    // narrowing back is free: a link asking for acme alone keeps the cursor
    const narrow = link(holder, device, acme);
    await narrow.settle();
    expect(narrow.asked.every((size) => size > 0)).toBe(true);
    narrow.close();
  });

  test("a smaller window keeps the cursor, and a window dropped re-pages the rows outside it", async () => {
    const holder = peer(40, "acct_x");
    const device = peer(80, "acct_y");
    for (const id of ["n1", "n2", "n3"]) (await write(holder, id, `body ${id}`)).unwrap();

    const windowed = { partitions: [ACME], window: { newest: 1 } };
    await device.engine.installSnapshot(holder.engine.snapshot({ interest: windowed }));
    expect(bodyOf(device, "n3")).toBe("body n3");
    expect(bodyOf(device, "n1")).toBeUndefined();

    // no more than the window asked for: the cursor is kept, and nothing below it is sent
    const same = link(holder, device, windowed);
    await same.settle();
    expect(same.asked.length).toBeGreaterThan(0);
    expect(same.asked.every((size) => size > 0)).toBe(true);
    expect(bodyOf(device, "n1")).toBeUndefined();
    same.close();

    // the whole partition now: the window's coverage claims nothing about n1 and n2
    const whole = link(holder, device, { partitions: [ACME] });
    await whole.settle();
    expect(bodyOf(device, "n1")).toBe("body n1");
    expect(bodyOf(device, "n2")).toBe("body n2");
    whole.close();
  });
});
