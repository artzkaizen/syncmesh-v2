import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { EngineError } from "../errors.js";
import type { TelemetryEvent } from "../telemetry.js";

import { createEngine } from "../engine.js";
import { createLink } from "../link.js";
import { createMemoryEventStore, StoreFailure } from "../store.js";
import { CREATE, fakeClock, N1, NOTES, PEER_B, row, setup } from "./fixtures.js";

describe("onError", () => {
  test("a throwing fold listener is reported, and the fold still completes for the others", async () => {
    const { engine } = setup();
    const errors: EngineError[] = [];
    let reached = 0;
    engine.onError((e) => void errors.push(e));
    engine.onFoldBatch(() => {
      throw new Error("bad listener");
    });
    engine.onFoldBatch(() => void reached++);
    const r = await engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ x: 1 })));
    expect(r.isOk()).toBe(true);
    expect(reached).toBe(1);
    expect(errors.map((e) => `${e._tag}:${e.hook}`)).toEqual(["ListenerFailure:onFoldBatch"]);
  });

  test("a link reports a receive that the far store refused", async () => {
    const a = setup();
    const failing = createMemoryEventStore();
    const b = createEngine({
      peerId: PEER_B,
      clock: fakeClock(100),
      store: {
        ...failing,
        appendBatch: () => Promise.resolve(Result.err(new StoreFailure({ message: "disk full" }))),
      },
    });
    const link = createLink(a.engine, b);
    const errors: StoreFailure[] = [];
    link.onError((e) => void errors.push(e));
    await a.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ x: 1 })));
    await link.flush();
    expect(errors.map((e) => e.message)).toEqual(["disk full"]);
  });
});

describe("onTelemetry", () => {
  test("a mutate reports its own duration and one fold with exact sizes", async () => {
    const { engine } = setup();
    const seen: TelemetryEvent[] = [];
    engine.onTelemetry((e) => void seen.push(e));
    await engine.mutate(CREATE, (tx) => {
      tx.insert(NOTES, N1, row({ x: 1 }));
      tx.update(NOTES, N1, row({ y: 2 }));
    });
    expect(seen.map((e) => e.type)).toEqual(["engine.mutate", "engine.fold"]);
    expect(seen[0]?.sizes).toEqual({ changes: 2 });
    expect(seen[1]?.sizes).toEqual({ events: 1, keys: 1 });
    for (const e of seen) {
      expect(e.duration).toBeInstanceOf(Temporal.Duration);
      expect(
        Temporal.Duration.compare(e.duration, Temporal.Duration.from({ seconds: 0 })),
      ).toBeGreaterThanOrEqual(0);
    }
  });
});
