import { panic } from "@syncmesh/result";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { AuthorityHandlers } from "../api.js";

import { createHandler, httpLink, mutation, query } from "../index.js";

/**
 * The book's grammar end to end (ch. 7, 19): the `.authority()` terminal declares the contract,
 * `AuthorityHandlers` mirrors it as typed bodies on the server, a declared error crosses the
 * wire as its own tag, and the answer parses against `.output()` before anyone consumes it.
 */
const router = {
  products: {
    list: query.route({ method: "GET", path: "/products" }).handler(() => panic("not under test")),
  },
  rooms: {
    reserveName: mutation
      .route({ method: "POST", path: "/room-names", tags: ["Rooms"] })
      .input(z.object({ shopId: z.string(), name: z.string().min(1) }))
      .output(z.object({ roomId: z.string() }))
      .errors({ NAME_TAKEN: { message: "That name is already reserved" } })
      .authority(),
  },
};

const handlers = {
  rooms: {
    reserveName: ({ input, errors }) => {
      const taken = errors.NAME_TAKEN ?? panic("declared on the contract");
      if (input.name === "ward-3") throw taken();
      return { roomId: `room-${input.name}` };
    },
  },
} satisfies AuthorityHandlers<typeof router>;

describe("the .authority() terminal and its mirror", () => {
  test("the contract carries route, errors and output; the def has no handler to call", () => {
    const def = router.rooms.reserveName;
    expect(def.kind).toBe("authority");
    expect(def.via).toBe("mutation");
    expect(def.route?.path).toBe("/room-names");
    expect(def.errors?.NAME_TAKEN?.message).toBe("That name is already reserved");
    expect("handler" in def).toBe(false);
    expect("run" in def).toBe(false);
  });

  test("a bound gate answers; a declared refusal crosses as its own tag", async () => {
    const handler = createHandler({
      procedures: router,
      // SAFETY: the gate path never reaches the api leaves in this test
      api: {} as never,
      gate: { handlers, handle: () => panic("this gate reads no tables") },
    });
    const server = Bun.serve({ port: 0, fetch: (request) => handler(request) });
    try {
      const link = httpLink(`http://localhost:${server.port}`);

      const reserved = await link("rooms.reserveName", { shopId: "s1", name: "annex" });
      expect(reserved.unwrap()).toEqual({ roomId: "room-annex" });

      const refused = await link("rooms.reserveName", { shopId: "s1", name: "ward-3" });
      const error = refused.match({ ok: () => undefined, err: (e) => e });
      expect(error !== undefined && "_tag" in error && error._tag).toBe("ForeignTagged");
      expect(error !== undefined && "tag" in error && error.tag).toBe("NAME_TAKEN");
      expect(error?.message).toBe("That name is already reserved");

      const invalid = await link("rooms.reserveName", { shopId: "s1", name: "" });
      expect(invalid.isErr()).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});
