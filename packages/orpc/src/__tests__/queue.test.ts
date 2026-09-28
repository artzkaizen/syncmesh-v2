import { Result, TaggedError, isTaggedError, panic } from "@syncmesh/result";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { describe, expect, test } from "bun:test";

import type { AuthorityLink } from "../api.js";

import { AuthorityUnreachable } from "../errors.js";
import { createHandler, httpLink, mutation } from "../index.js";
import { queuedLink } from "../queue.js";

class Refused extends TaggedError("Refused")<{ message: string }> {}

const procedures = {
  rooms: {
    reserve: mutation.handler(() => {
      throw new Error("the api leaf answers");
    }),
  },
};

describe("queuedLink — an oRPC link over a request row (D10, re-homed)", () => {
  test("a call that cannot reach the authority is kept, sent on drain under the same id, and its answer delivered", async () => {
    const driver = bunSqliteDriver(":memory:");
    let reachable = false;
    const seen: string[] = [];
    const flaky: AuthorityLink = (path, input, call) => {
      if (!reachable)
        return Promise.resolve(
          Result.err(new AuthorityUnreachable({ path, message: "no route to the authority" })),
        );
      seen.push(call?.requestId ?? "none");
      // SAFETY: the test's own input shape
      const { name } = input as { readonly name: string };
      return Promise.resolve(
        name === "taken"
          ? Result.err(new Refused({ message: "taken" }))
          : Result.ok({ room: name }),
      );
    };
    const queued = queuedLink(flaky, driver);
    const settled: string[] = [];
    queued.onSettled((request, answer) =>
      settled.push(`${request.id}:${answer.isOk() ? "ok" : "err"}`),
    );

    const first = await queued.link("rooms.reserve", { name: "annex" }, { requestId: "r1" });
    const failure = first.match({ ok: () => undefined, err: (e) => e });
    expect(failure !== undefined && isTaggedError(failure) && failure._tag).toBe("AuthorityQueued");
    await queued.link("rooms.reserve", { name: "taken" }, { requestId: "r2" });
    expect((await queued.pending()).map((r) => r.id)).toEqual(["r1", "r2"]);

    // still unreachable: nothing leaves, and the first row counts the attempt
    await queued.drain();
    expect((await queued.pending()).map((r) => [r.id, r.attempts])).toEqual([
      ["r1", 2],
      ["r2", 1],
    ]);

    reachable = true;
    await queued.drain();
    expect(seen).toEqual(["r1", "r2"]); // the same ids the calls were kept under
    expect(await queued.pending()).toEqual([]);
    expect(settled).toEqual(["r1:ok", "r2:err"]); // a refusal is an answer, not a retry

    // reachable now: a call is answered at once and never kept
    expect((await queued.link("rooms.reserve", { name: "live" })).unwrap()).toEqual({
      room: "live",
    });
    expect(await queued.pending()).toEqual([]);
    await driver.close?.();
  });

  test("over a real socket: the server stopped keeps the call; the server back answers it once", async () => {
    const api = {
      rooms: {
        reserve: (input: { readonly name: string }) =>
          Promise.resolve(Result.ok({ room: input.name })),
      },
    };
    // SAFETY: the test api mirrors the router's leaf
    const handler = createHandler({ procedures, api: api as never });
    const driver = bunSqliteDriver(":memory:");
    const server = Bun.serve({ port: 0, fetch: (request) => handler(request) });
    const port = server.port ?? panic("Bun.serve did not bind a port");
    const url = `http://localhost:${String(port)}`;
    await server.stop(true);

    const queued = queuedLink(httpLink(url), driver);
    const kept = await queued.link("rooms.reserve", { name: "annex" });
    expect(kept.match({ ok: () => "ok", err: (e) => (isTaggedError(e) ? e._tag : "?") })).toBe(
      "AuthorityQueued",
    );

    const revived = Bun.serve({ port, fetch: (request) => handler(request) });
    try {
      const answers: unknown[] = [];
      queued.onSettled((_request, answer) => answers.push(answer.unwrap()));
      await queued.drain();
      expect(answers).toEqual([{ room: "annex" }]);
      expect(await queued.pending()).toEqual([]);
    } finally {
      await revived.stop(true);
      await driver.close?.();
    }
  });
});
