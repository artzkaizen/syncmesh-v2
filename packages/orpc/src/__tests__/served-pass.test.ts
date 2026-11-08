import { Temporal } from "@syncmesh/temporal";
import { ReadFailed, ReadRefused } from "@syncmesh/window";
import { describe, expect, test } from "bun:test";

import { failures } from "../served-pass.js";

/** An error as postgres.js throws it, under Drizzle's wrapper: a SQLSTATE and Postgres's message. */
const postgresError = (code: string, message: string) =>
  new Error("Failed query: …", { cause: Object.assign(new Error(message), { code }) });

describe("failures — how a statement Postgres answered with an error is read (D43)", () => {
  const { classify } = failures(Temporal.Duration.from({ seconds: 0 }));

  test("a transaction an earlier statement aborted is a failure, read again, not a refusal", () => {
    const answer = classify(
      "r",
      postgresError(
        "25P02",
        "current transaction is aborted, commands ignored until end of transaction block",
      ),
    );
    expect(ReadFailed.is(answer)).toBe(true);
  });

  test("a write inside the read-only transaction is still the read's own fault", () => {
    const answer = classify(
      "r",
      postgresError("25006", "cannot execute INSERT in a read-only transaction"),
    );
    expect(ReadRefused.is(answer)).toBe(true);
  });
});
