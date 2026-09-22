import type { Cursors } from "@syncmesh/engine";
import type { Transport } from "@syncmesh/transport";

import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import { createReadCoverage } from "../read-coverage.js";

const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/** What coverage reads of a medium, and nothing else of it. */
type Medium = Pick<Transport, "name" | "priority" | "whenReady" | "caughtUp">;

/** A medium reduced to its name, its distance, and the moment it caught up. */
const medium = (name: string, priority: number) => {
  let finish = (): void => undefined;
  const caught = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fake: Medium = {
    name,
    priority,
    whenReady: () => Promise.resolve(),
    caughtUp: () => caught,
  };
  // SAFETY: `createReadCoverage` touches exactly the four members `Medium` names; the rest of a Transport is never reached from here
  return { transport: fake as Transport, finish };
};

/** The cursors a device holds: opaque to coverage, which only keeps a reference to them. */
const cursors = (): Cursors => new Map();

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("read coverage — a source and a checkpoint, not one promise (book ch. 9)", () => {
  test("nothing has answered: local-only, and it cannot name a source", () => {
    const near = medium("nearby", 1);
    const view = createReadCoverage({ transports: () => [near.transport], cursors, now: () => T0 });
    expect(view.get()).toEqual({ kind: "local-only" });
  });

  test("with no medium at all it stays local-only forever — `caught-up` needs a source to name", () => {
    const view = createReadCoverage({ transports: () => [], cursors, now: () => T0 });
    expect(view.get()).toEqual({ kind: "local-only" });
  });

  test("near answers first: partial, naming it; far answers: caught-up, naming the far one", async () => {
    const near = medium("nearby", 1);
    const far = medium("internet", 3);
    const atNear = cursors();
    const atFar = cursors();
    let held = atNear;
    let clock = T0;
    const view = createReadCoverage({
      transports: () => [near.transport, far.transport],
      cursors: () => held,
      now: () => clock,
    });
    let notified = 0;
    view.subscribe(() => void (notified += 1));

    near.finish();
    await settle();
    const partial = view.get();
    expect(partial.kind).toBe("partial");
    expect(partial.kind === "partial" && partial.source).toBe("nearby");
    expect(partial.kind === "partial" && partial.checkpoint.at.equals(T0)).toBe(true);
    expect(partial.kind === "partial" && partial.checkpoint.cursors).toBe(atNear);
    expect(notified).toBe(1);

    clock = T0.add({ seconds: 30 });
    held = atFar;
    far.finish();
    await settle();
    const full = view.get();
    expect(full.kind).toBe("caught-up");
    expect(full.kind === "caught-up" && full.source).toBe("internet");
    // the checkpoint is the far source's own moment and cursors, not the near one's
    expect(full.kind === "caught-up" && full.checkpoint.at.equals(clock)).toBe(true);
    expect(full.kind === "caught-up" && full.checkpoint.cursors).toBe(atFar);
    expect(notified).toBe(2);
  });

  test("a medium added later drops the reading back to partial until it answers", async () => {
    const near = medium("nearby", 1);
    const set: Transport[] = [near.transport];
    const view = createReadCoverage({ transports: () => set, cursors, now: () => T0 });
    near.finish();
    await settle();
    expect(view.get().kind).toBe("caught-up");

    const late = medium("internet", 3);
    set.push(late.transport);
    expect(view.get().kind).toBe("partial"); // honest: the new source has not spoken
    late.finish();
    await settle();
    expect(view.get().kind).toBe("caught-up");
  });

  test("a medium that never comes up is one that has not answered, not a crash", async () => {
    const broken: Medium = {
      name: "ble",
      priority: 2,
      whenReady: () => Promise.reject(new Error("radio off")),
      caughtUp: () => Promise.resolve(),
    };
    // SAFETY: as in `medium`
    const view = createReadCoverage({
      transports: () => [broken as Transport],
      cursors,
      now: () => T0,
    });
    await settle();
    expect(view.get()).toEqual({ kind: "local-only" });
  });
});
