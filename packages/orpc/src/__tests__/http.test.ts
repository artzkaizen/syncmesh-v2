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
