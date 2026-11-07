import { Result, TaggedError } from "@syncmesh/result";
import { describe, expect, test } from "bun:test";

import { createHandler, httpLink, mutation } from "../index.js";

class NameTaken extends TaggedError("NameTaken")<{ readonly room: string; message?: string }> {}
class QuotaHit extends TaggedError("QuotaHit")<{ readonly used: number; message?: string }> {}

/**
 * The seam alone: a router for the paths, an api whose leaves answer with tagged failures, and
 * a real socket between the handler and the link — no mesh, because the mesh is not on trial.
 */
const procedures = {
  rooms: {
    reserve: mutation.handler(() => {
      throw new Error("the handler never runs: the api leaf below answers");
    }),
  },
};

const api = {
  rooms: {
    reserve: (input: { readonly name: string }) =>
      Promise.resolve(
        input.name === "over-quota"
          ? Result.err(new QuotaHit({ used: 9, message: "quota" }))
          : Result.err(new NameTaken({ room: input.name, message: "already reserved" })),
      ),
  },
};

describe("tagged errors across httpLink", () => {
  test("a declared failure revives as its class; an undeclared one keeps its tag", async () => {
    // SAFETY: the test api mirrors the router's leaves; Api<R>'s full shape is not on trial here
    const handler = createHandler({ procedures, api: api as never });
    const server = Bun.serve({ port: 0, fetch: (request) => handler(request) });
    try {
      const link = httpLink(`http://localhost:${server.port}`, { errors: [NameTaken] });

      const taken = await link("rooms.reserve", { name: "ward-3" });
      expect(taken.isErr()).toBe(true);
      const error = taken.match({ ok: () => undefined, err: (e) => e });
      expect(error instanceof NameTaken).toBe(true);
      expect(error instanceof NameTaken && error.room).toBe("ward-3");

      const foreign = await link("rooms.reserve", { name: "over-quota" });
      const kept = foreign.match({ ok: () => undefined, err: (e) => e });
      expect(kept !== undefined && "_tag" in kept && kept._tag).toBe("ForeignTagged");
    } finally {
      await server.stop(true);
    }
  });
});

describe("request ids across httpLink", () => {
  test("the same id asked twice runs the body once and is answered from what was kept", async () => {
    let ran = 0;
    const counting = {
      rooms: {
        reserve: (input: { readonly name: string }) => {
          ran += 1;
          return Promise.resolve(Result.ok({ room: input.name, nth: ran }));
        },
      },
    };
    // SAFETY: the test api mirrors the router's leaves; Api<R>'s full shape is not on trial here
    const handler = createHandler({ procedures, api: counting as never });
    const server = Bun.serve({ port: 0, fetch: (request) => handler(request) });
    try {
      const link = httpLink(`http://localhost:${server.port}`);
      const first = await link("rooms.reserve", { name: "ward-3" }, { requestId: "req-1" });
      const again = await link("rooms.reserve", { name: "ward-3" }, { requestId: "req-1" });
      expect(first.unwrap()).toEqual({ room: "ward-3", nth: 1 });
      expect(again.unwrap()).toEqual({ room: "ward-3", nth: 1 });
      expect(ran).toBe(1);

      // two in flight at once under one id: one body, both answered the same
      const [a, b] = await Promise.all([
        link("rooms.reserve", { name: "annex" }, { requestId: "req-2" }),
        link("rooms.reserve", { name: "annex" }, { requestId: "req-2" }),
      ]);
      expect(a.unwrap()).toEqual(b.unwrap());
      expect(ran).toBe(2);

      // no id, no memory: a fresh call runs
      expect((await link("rooms.reserve", { name: "annex" })).unwrap()).toEqual({
        room: "annex",
        nth: 3,
      });

      // the in-process door answers the leaf's own Result, no wire in between
      expect((await handler.call("rooms.reserve", { name: "direct" })).unwrap()).toEqual({
        room: "direct",
        nth: 4,
      });
      expect((await handler.call("nowhere.at", {})).isErr()).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});
