import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { QueryDef } from "../api.js";

import { isDef, mutation, procedure, query } from "../api.js";

const input = z.object({ shopId: z.string() });
const output = z.object({ id: z.string() });

/** Def-shape fixtures only: never invoked, so throwing is the honest body. */
const runQuery = (): never => {
  throw new Error("def-shape fixture: not invoked");
};
const runMutation = (): never => {
  throw new Error("def-shape fixture: not invoked");
};

describe("procedure()", () => {
  test("method selects the chain: GET builds what the query chain builds", () => {
    const viaOld = query.route({ method: "GET", path: "/books" }).input(input).handler(runQuery);
    const viaNew = procedure()
      .route({ method: "GET", path: "/books" })
      .input(input)
      .handler(runQuery);
    expect(viaNew).toEqual(viaOld);
    expect(viaNew.run).toBe(runQuery);
  });

  test("QUERY is a query method", () => {
    const def = procedure()
      .route({ method: "QUERY", path: "/books/search" })
      .input(input)
      .handler(runQuery);
    expect(def.kind).toBe("query");
    expect(def.route?.method).toBe("QUERY");
    expect(isDef(def)).toBe(true);
  });

  test("POST builds what the mutation chain builds", () => {
    const viaOld = mutation
      .route({ method: "POST", path: "/books" })
      .input(input)
      .handler(() => ({ id: "b1" }));
    const viaNew = procedure()
      .route({ method: "POST", path: "/books" })
      .input(input)
      .handler(() => ({ id: "b1" }));
    expect({ ...viaNew, run: "fn" }).toEqual({ ...viaOld, run: "fn" });
  });

  test("authority defs carry route unconditionally and match the old chain", () => {
    const viaOld = mutation
      .route({ method: "POST", path: "/issues/number" })
      .input(input)
      .output(output)
      .errors({ NO_SUCH_ISSUE: { message: "gone" } })
      .authority();
    const viaNew = procedure()
      .route({ method: "POST", path: "/issues/number" })
      .input(input)
      .output(output)
      .errors({ NO_SUCH_ISSUE: { message: "gone" } })
      .authority();
    expect(viaNew).toEqual(viaOld);
    expect(viaNew.route).toEqual({ method: "POST", path: "/issues/number" });
    expect(viaNew.via).toBe("mutation");
    expect(isDef(viaNew)).toBe(true);
  });

  test("read-shaped authority gates keep via query", () => {
    const a = procedure().route({ method: "GET", path: "/version" }).output(output).authority();
    expect(a.kind).toBe("authority");
    expect(a.via).toBe("query");
  });

  test("void-input query form works", () => {
    const q = procedure().route({ method: "GET", path: "/health" }).handler(runQuery);
    expect(q.kind).toBe("query");
    expect(q.run).toBe(runQuery);
  });

  test("void-input mutation form works", () => {
    const m = procedure().route({ method: "POST", path: "/flush" }).handler(runMutation);
    expect(m.kind).toBe("mutation");
  });

  test("a POST chain builds mutations, never queries", () => {
    const q = procedure()
      .route({ method: "POST", path: "/books" })
      .input(input)
      .handler(() => ({ id: "b1" }));
    expect(q.kind).toBe("mutation");
    // @ts-expect-error a POST chain builds a MutationDef, which is not a QueryDef
    const asQuery: QueryDef<never, unknown> = q;
    void asQuery;
  });
});
