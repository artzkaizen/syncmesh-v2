import type { ColumnName } from "@syncmesh/kernel";
import type { PageSource } from "@syncmesh/window";

import { Result } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { ReadFailed, ReadRefused, createServerWindows, createWindowClient } from "@syncmesh/window";
import { describe, expect, test } from "bun:test";
import { pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";

import { AuthorityUnreachable } from "../errors.js";
import { servedLives } from "../served-live.js";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures */
const ID = "id" as ColumnName;
const V = "v" as ColumnName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

const T = pgTable("t", { id: text().primaryKey(), v: text() });
/** The handler's query, built only to be read: a served read never runs it on the device. */
const handlerQuery = () => drizzle.mock().select().from(T);

/** Long enough that no test sees a retry it did not ask for. */
const NO_RETRY = {
  first: Temporal.Duration.from({ minutes: 1 }),
  most: Temporal.Duration.from({ minutes: 1 }),
} as const;

/** A server whose nth read answers `answers[n]`, the last repeating, joined to one client. */
const joined = (...answers: readonly ("ok" | "fail" | "refuse")[]) => {
  let reads = 0;
  let commit: (tables: ReadonlySet<string>) => void = () => undefined;
  const source: PageSource = {
    readPage: async () => {
      reads++;
      const answer = answers[Math.min(reads, answers.length) - 1];
      if (answer === "fail") return Result.err(new ReadFailed({ message: "statement timeout" }));
      if (answer === "refuse") return Result.err(new ReadRefused({ message: "permission denied" }));
      const row = new Map([
        [ID, "a"],
        [V, `v${reads}`],
      ]);
      return Result.ok({ rows: [{ key: "a", row }], tables: new Set(["t"]) });
    },
    onCommit: (listener) => {
      commit = listener;
      return () => undefined;
    },
  };
  const client = createWindowClient();
  const server = createServerWindows({
    source,
    send: (frame) => client.receive(frame),
    retry: NO_RETRY,
  });
  client.attach((frame) => server.receive(frame));
  return { client, server, commit: () => commit(new Set(["t"])) };
};

describe("a served live read whose window fails (D43)", () => {
  test("a failed re-read turns the snapshot to error with its last rows, and the next commit recovers it", async () => {
    const { client, server, commit } = joined("ok", "fail", "ok");
    const live = servedLives(client).live("p", {}, handlerQuery());
    await server.idle();
    expect(live.snapshot()).toMatchObject({ status: "success", data: [{ id: "a", v: "v1" }] });
    commit();
    await server.idle();
    const failed = live.snapshot();
    expect(failed).toMatchObject({ answered: true, status: "error", data: [{ id: "a", v: "v1" }] });
    expect(failed.error).toBeInstanceOf(ReadFailed);
    commit();
    await server.idle();
    expect(live.snapshot()).toMatchObject({ status: "success", data: [{ id: "a", v: "v3" }] });
    expect(live.snapshot().error).toBeUndefined();
    server.stop();
  });

  test("a refused re-read is an error too, never a stale success", async () => {
    const { client, server, commit } = joined("ok", "refuse");
    const live = servedLives(client).live("p", {}, handlerQuery());
    await server.idle();
    commit();
    await server.idle();
    expect(live.snapshot()).toMatchObject({ answered: true, status: "error" });
    expect(live.snapshot().error).toBeInstanceOf(ReadRefused);
  });

  test("a first read that fails rejects ready, so a one-shot read is told rather than left waiting", async () => {
    const { client, server } = joined("fail");
    const lives = servedLives(client);
    const once = lives.once("p", {}, handlerQuery());
    await server.idle();
    expect(
      await once.then(
        () => undefined,
        (error: Error) => error,
      ),
    ).toBeInstanceOf(ReadFailed);
    server.stop();
  });

  test("a one-shot read on a detached client fails as unreachable", async () => {
    const client = createWindowClient();
    const once = servedLives(client).once("p", {}, handlerQuery());
    expect(
      await once.then(
        () => undefined,
        (error: Error) => error,
      ),
    ).toBeInstanceOf(AuthorityUnreachable);
  });
});
