import type { SnapshotInstalled } from "@syncmesh/transport";

import { createHub } from "@syncmesh/engine";
import { describe, expect, test } from "bun:test";

import type { RecoveryDeps } from "../recovery.js";

import { openRecovery } from "../recovery.js";

/**
 * `rebuild` is the last resort (book ch. 18), so what is tested here is mostly what it refuses:
 * the wait that ends in a report rather than a spinner, the pending writes nobody else can give
 * back, and the snapshot nothing vouched for.
 *
 * The adoption itself is not re-tested here — a snapshot install is the join exchange's, and its
 * merge semantics are proven where they live.
 */

// SAFETY: `rebuild` never touches the engine — it asks sources, waits, and reports. Anything
// here that did reach for one would fail loudly rather than pass against a stub that answered
const engine = {} as Parameters<typeof openRecovery>[0];

const deps = (over: Partial<RecoveryDeps> = {}): RecoveryDeps => ({
  sources: () => [{ name: "relay", requestSnapshot: () => undefined }],
  onSnapshot: createHub<SnapshotInstalled>().subscribe,
  pending: () => 0,
  ...over,
});

describe("$recovery.rebuild — the last resort, and what it will not do", () => {
  test("a mesh with no transports is told so, rather than waiting on nobody", async () => {
    const recovery = openRecovery(engine);
    const answer = await recovery.rebuild();
    expect(answer.isErr()).toBe(true);
    expect(answer.isErr() && answer.error._tag).toBe("RebuildRefused");
  });

  test("unsent writes stop it by default, and are named in the refusal", async () => {
    const recovery = openRecovery(engine, deps({ pending: () => 3 }));
    const answer = await recovery.rebuild();
    expect(answer.isErr() && answer.error.message).toContain("3 of this device's writes");
    // nothing was asked for: the refusal happens before any source is touched
    expect(answer.isErr() && answer.error._tag).toBe("RebuildRefused");
  });

  test("saying the writes may wait lets it run — and they are still there", async () => {
    const snapshots = createHub<SnapshotInstalled>();
    const recovery = openRecovery(
      engine,
      deps({
        pending: () => 2,
        onSnapshot: snapshots.subscribe,
        sources: () => [
          {
            name: "relay",
            // the source answers as soon as it is asked, which is what a relay with state does
            requestSnapshot: () =>
              queueMicrotask(() => snapshots.emit({ rows: 41, provisional: false })),
          },
        ],
      }),
    );

    const report = await recovery.rebuild({ preservePending: false, timeoutMs: 200 });
    expect(report.unwrap()).toEqual({ rows: 41, vouched: true, pending: 2 });
  });

  test("state nobody vouched for is not adopted as a rebuild, unless it is asked for", async () => {
    const snapshots = createHub<SnapshotInstalled>();
    const answering = (): RecoveryDeps =>
      deps({
        onSnapshot: snapshots.subscribe,
        sources: () => [
          {
            name: "peer",
            requestSnapshot: () =>
              queueMicrotask(() => snapshots.emit({ rows: 9, provisional: true })),
          },
        ],
      });

    // the rows arrived and merged like any other source's; what is refused is calling it a
    // rebuild, because nothing signed for *which state* this is
    const refused = await openRecovery(engine, answering()).rebuild({ timeoutMs: 60 });
    expect(refused.isErr() && refused.error._tag).toBe("HistoryUnavailable");

    const taken = await openRecovery(engine, answering()).rebuild({
      allowProvisional: true,
      timeoutMs: 200,
    });
    expect(taken.unwrap().vouched).toBe(false);
  });

  test("silence ends in a report naming who was asked, not in a spinner", async () => {
    const recovery = openRecovery(
      engine,
      deps({
        sources: () => [
          { name: "lan", requestSnapshot: () => undefined },
          { name: "relay", requestSnapshot: () => undefined },
          { name: "ble" }, // cannot hand over state at all: not asked, but named
        ],
      }),
    );
    const answer = await recovery.rebuild({ timeoutMs: 40 });
    expect(answer.isErr() && answer.error._tag).toBe("HistoryUnavailable");
    expect(answer.isErr() && "sourcesTried" in answer.error && answer.error.sourcesTried).toEqual([
      "lan",
      "relay",
    ]);
    expect(answer.isErr() && answer.error.message).toContain("export is the exit");
  });

  test("a room where nothing can hand over state says that, and says it immediately", async () => {
    const recovery = openRecovery(engine, deps({ sources: () => [{ name: "ble" }] }));
    const answer = await recovery.rebuild({ timeoutMs: 10_000 });
    expect(answer.isErr() && answer.error._tag).toBe("HistoryUnavailable");
    expect(answer.isErr() && answer.error.message).toContain("no source here can hand over state");
  });
});
