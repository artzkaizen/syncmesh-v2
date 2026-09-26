import { createHlcClock, parsePartitionKey, readRow } from "@syncmesh/kernel";
import { syncSchema, t, user } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { describe, expect, test } from "bun:test";

import type { ProbeEvent } from "../validate.js";

import { createValidator } from "../validate.js";
import { CREATE, N1, NOTES, PEER_A, PEER_B, column, row, setup } from "./fixtures.js";

const schema = syncSchema({
  tables: {
    notes: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: user },
  },
});

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms);
const DRIFT = Temporal.Duration.from({ minutes: 5 });
const ACCT_B = parsePartitionKey("user:acct_b").unwrap();
const NONE = { row: () => undefined, partition: () => undefined };
const tag = (r: { isErr(): boolean; error?: { _tag: string } }) =>
  r.isErr() ? r.error?._tag : "ok";

/** An insert by B, stamped at `ms` — or, with no `ms`, a probe that has not been stamped yet. */
const insertAt = (ms?: number): ProbeEvent => ({
  peerId: PEER_B,
  partition: ACCT_B,
  changes: [{ kind: "insert", table: NOTES, key: N1, row: row({ id: "n1", body: "late" }) }],
  ...(ms !== undefined && { hlc: createHlcClock({ now: () => at(ms) }).tick() }),
});

describe("the clock rung (D34)", () => {
  const validator = createValidator({
    schema,
    grantFor: null,
    now: () => at(T0),
    maxDrift: DRIFT,
  });

  test("a stamp further ahead than the bound is ClockAhead; one inside it is not judged", () => {
    expect(tag(validator.validate(insertAt(T0 + 10 * MINUTE), NONE))).toBe("ClockAhead");
    expect(tag(validator.validate(insertAt(T0 + 4 * MINUTE), NONE))).toBe("ok");
    expect(tag(validator.validate(insertAt(T0 + 5 * MINUTE), NONE))).toBe("ok"); // the bound itself is inside
  });

  test("the past is history, not drift: a month-old stamp folds", () => {
    expect(tag(validator.validate(insertAt(T0 - 30 * 24 * 60 * MINUTE), NONE))).toBe("ok");
  });

  test("a probe carries no stamp and is not judged by the clock", () => {
    expect(tag(validator.validate(insertAt(), NONE))).toBe("ok");
  });

  test("a validator given no bound, or no clock, judges nothing", () => {
    const unbounded = createValidator({ schema, grantFor: null, now: () => at(T0) });
    expect(tag(unbounded.validate(insertAt(T0 + 10 * MINUTE), NONE))).toBe("ok");
    const clockless = createValidator({ schema, grantFor: null, maxDrift: DRIFT });
    expect(tag(clockless.validate(insertAt(T0 + 10 * MINUTE), NONE))).toBe("ok");
  });

  test("the verdict names the stamp and the limit, so a person can see which clock is wrong", () => {
    const verdict = validator.validate(insertAt(T0 + 10 * MINUTE), NONE);
    if (verdict.isOk() || verdict.error._tag !== "ClockAhead")
      throw new Error("expected ClockAhead");
    expect(verdict.error.peer).toBe(PEER_B);
    expect(verdict.error.at).toBe(at(T0 + 10 * MINUTE).toString());
    expect(verdict.error.limit).toBe(at(T0 + 5 * MINUTE).toString());
  });
});

describe("a peer whose clock runs an hour fast", () => {
  test("its write is parked, not folded; the receiver's clock is not dragged; time clears it", async () => {
    let wall = T0;
    const validate = createValidator({
      schema,
      grantFor: null,
      now: () => at(wall),
      maxDrift: DRIFT,
    });
    const clock = createHlcClock({ now: () => at(wall), maxDrift: DRIFT });
    const a = setup(PEER_A, T0, { validate, clock });
    const b = setup(PEER_B, T0 + 60 * MINUTE);

    const event = (
      await b.engine.mutate(CREATE, (tx) => tx.insert(NOTES, N1, row({ id: "n1", body: "late" })), {
        partition: ACCT_B,
      })
    ).unwrap();
    expect(event.hlc[0].epochMilliseconds).toBe(T0 + 60 * MINUTE);

    const report = (await a.engine.receiveBatch([{ event }])).unwrap();
    expect(report).toEqual({ folded: 0, skipped: 0, quarantined: 1 });
    expect(readRow(a.engine.state(), NOTES, N1)).toBeUndefined();
    expect(a.engine.quarantine()[0]?.verdict._tag).toBe("ClockAhead");
    // the stamp it refused to fold is one it also refused to adopt: the clamp and the rung agree
    expect(clock.last()[0].epochMilliseconds).toBeLessThanOrEqual(T0 + 5 * MINUTE);

    // an hour later the claim is merely true, and the parked event is ordinary history
    wall = T0 + 61 * MINUTE;
    const retried = (await a.engine.retryQuarantined()).unwrap();
    expect(retried.folded).toBe(1);
    expect(readRow(a.engine.state(), NOTES, N1)?.get(column("body"))).toBe("late");
    expect(a.engine.quarantine()).toHaveLength(0);
  });
});
