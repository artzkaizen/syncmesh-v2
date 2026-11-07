import type { AnyProcedureContract } from "@orpc/contract";

import { getRouterContract } from "@orpc/contract";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { contractJson, openApi, readLeafKind, readRoute, toContract } from "../contract.js";
import { mutation, procedure, query } from "../procedures.js";

const router = {
  products: {
    list: query.route({ method: "GET", path: "/products" }).handler(() => {
      throw new Error("not under test");
    }),
    // a plain device query with no route: in the contract, absent from OpenAPI
    count: query.handler(() => {
      throw new Error("not under test");
    }),
  },
  rooms: {
    reserveName: procedure()
      .route({ method: "POST", path: "/room-names", tags: ["Rooms"] })
      .input(z.object({ shopId: z.string(), name: z.string().min(1) }))
      .output(z.object({ roomId: z.string() }))
      .errors({ NAME_TAKEN: { message: "That name is already reserved" } })
      .authority(),
    close: mutation.input(z.object({ id: z.string() })).handler(() => undefined),
  },
};

describe("toContract — the router as an oRPC contract", () => {
  test("every leaf becomes a procedure contract carrying its route, kind and errors", () => {
    const contract = toContract(router);
    const reserve = getRouterContract(contract, ["rooms", "reserveName"]);
    expect(reserve).toBeDefined();
    // SAFETY: the leaf named exists, as asserted above; a contract at a leaf is a procedure contract
    const leaf = reserve as AnyProcedureContract;
    expect(readRoute(leaf)).toEqual({ method: "POST", path: "/room-names", tags: ["Rooms"] });
    expect(readLeafKind(leaf)).toEqual({ kind: "authority", via: "mutation" });
    expect(leaf["~orpc"].errorMap).toEqual({
      NAME_TAKEN: { message: "That name is already reserved" },
    });

    // SAFETY: same as above, for a device query with no route
    const count = getRouterContract(contract, ["products", "count"]) as AnyProcedureContract;
    expect(readRoute(count)).toBeUndefined();
    expect(readLeafKind(count)).toEqual({ kind: "query", via: "query" });
  });
});

describe("contractJson and openApi — what a build writes down", () => {
  test("the JSON contract lists every leaf; schemas are described when the build can, noted when it cannot", () => {
    const bare = contractJson(router);
    expect(bare.version).toBe(1);
    expect(bare.procedures.map((leaf) => leaf.path)).toEqual([
      "products.list",
      "products.count",
      "rooms.reserveName",
      "rooms.close",
    ]);
    const reserve = bare.procedures.find((leaf) => leaf.path === "rooms.reserveName");
    expect(reserve).toMatchObject({
      kind: "authority",
      via: "mutation",
      route: { method: "POST", path: "/room-names", tags: ["Rooms"] },
      errors: { NAME_TAKEN: { message: "That name is already reserved" } },
      input: true,
      output: true,
    });
    expect(bare.procedures.find((leaf) => leaf.path === "products.count")?.input).toBeUndefined();

    // what a build with zod 4 would pass as `z.toJSONSchema`; here a stand-in that names what it saw
    const described = contractJson(router, {
      jsonSchema: (schema) => ({ type: "object", vendor: schema["~standard"].vendor }),
    });
    const withSchema = described.procedures.find((leaf) => leaf.path === "rooms.reserveName");
    expect(withSchema?.input).toEqual({ type: "object", vendor: "zod" });
    expect(withSchema?.output).toEqual({ type: "object", vendor: "zod" });

    // the spec is read off the same contract, so a routed leaf appears under its method and its schemas
    const spec = openApi(described, { title: "Shop", version: "1.0.0" });
    expect(spec).toMatchObject({
      openapi: "3.1.0",
      paths: {
        "/products": { get: { operationId: "products.list" } },
        "/room-names": {
          post: {
            operationId: "rooms.reserveName",
            tags: ["Rooms"],
            requestBody: { content: { "application/json": { schema: { type: "object" } } } },
            responses: {
              "200": { content: { "application/json": { schema: { type: "object" } } } },
              "422": { description: "That name is already reserved" },
            },
          },
        },
      },
    });
    // the two unrouted leaves must not appear
    expect(Object.keys(spec.paths)).toEqual(["/products", "/room-names"]);
  });
});
