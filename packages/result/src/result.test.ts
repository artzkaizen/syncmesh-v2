import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import {
  isTaggedError,
  Panic,
  panic,
  Result,
  TaggedError,
  unreachable,
  type InferErr,
} from "./index.js";

class NoSuchTable extends TaggedError("NoSuchTable")<{ table: string; message: string }> {}
class EmptyTx extends TaggedError("EmptyTx")<{ message: string }> {}

const write = (table: string): Result<number, NoSuchTable | EmptyTx> =>
  table === ""
    ? Result.err(new EmptyTx({ message: "empty" }))
    : table === "notes"
      ? Result.ok(1)
      : Result.err(new NoSuchTable({ table, message: `no such table: ${table}` }));

type WriteError = InferErr<ReturnType<typeof write>>;

const describeError = (e: WriteError): string => {
  switch (e._tag) {
    case "NoSuchTable":
      return e.table;
    case "EmptyTx":
      return "empty";
    default:
      return unreachable(e, "WriteError");
  }
};
const lengthOf = (x: number | string) => String(x).length;
const double = (n: number) => n * 2;

describe("Result (better-result)", () => {
  test("ok and err carry a serialisable discriminant", () => {
    expect(Result.ok(1).status).toBe("ok");
    expect(Result.err("x").status).toBe("error");
    expect(Result.ok(1).isOk()).toBe(true);
    expect(Result.err("x").isErr()).toBe(true);
  });

  test("map / mapError / andThen only touch their side", () => {
    expect(write("notes").map(double).unwrapOr(0)).toBe(2);
    expect(write("nope").map(double).isErr()).toBe(true);
    expect(
      write("notes")
        .mapError(() => "e")
        .unwrapOr(0),
    ).toBe(1);
    expect(
      write("notes")
        .andThen((n) => Result.ok(`v${n}`))
        .unwrapOr(""),
    ).toBe("v1");
  });

  test("match on the Result, then exhaustively on the error tag", () => {
    const render = (table: string) =>
      write(table).match({
        ok: (n) => `ok:${n}`,
        err: (e) =>
          e.match({
            NoSuchTable: (x) => `missing:${x.table}`,
            EmptyTx: () => "empty",
          }),
      });
    expect(render("notes")).toBe("ok:1");
    expect(render("todo")).toBe("missing:todo");
    expect(render("")).toBe("empty");
  });

  test("gen composes and short-circuits on the first Err", () => {
    const both = (a: string, b: string) =>
      Result.gen(function* () {
        const x = yield* write(a);
        const y = yield* write(b);
        return Result.ok(x + y);
      });
    expect(both("notes", "notes").unwrapOr(0)).toBe(2);
    const failed = both("nope", "");
    expect(failed.isErr() && failed.error._tag).toBe("NoSuchTable");
  });

  test("all keeps order and returns the first failure", () => {
    expect(Result.all([Result.ok(1), Result.ok("a")]).unwrapOr(null)).toEqual([1, "a"]);
    const r = Result.all([Result.ok(1), Result.err("first"), Result.err("second")]);
    expect(r.isErr() && r.error).toBe("first");
  });

  test("try captures a throw at the boundary as a value", () => {
    const r = Result.try({
      try: () => JSON.parse("{") as unknown,
      catch: (t) => (t instanceof Error ? t.message : String(t)),
    });
    expect(r.isErr()).toBe(true);
  });

  test("property: map(id) is identity and map composes", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.string()), fc.boolean(), (v, isOkCase) => {
        const r: Result<typeof v, typeof v> = isOkCase ? Result.ok(v) : Result.err(v);
        expect(r.map((x) => x)).toEqual(r);
        expect(r.map(lengthOf).map(double)).toEqual(r.map((x) => double(lengthOf(x))));
      }),
    );
  });
});

describe("TaggedError", () => {
  test("is an Error with a literal tag, typed props, and a class guard", () => {
    const e = new NoSuchTable({ table: "notes", message: "no such table: notes" });
    expect(e).toBeInstanceOf(Error);
    expect(e._tag).toBe("NoSuchTable");
    expect(e.table).toBe("notes");
    expect(e.message).toBe("no such table: notes");
    expect(NoSuchTable.is(e)).toBe(true);
    expect(EmptyTx.is(e)).toBe(false);
    expect(isTaggedError(e)).toBe(true);
  });

  test("a switch over _tag is exhaustive via unreachable", () => {
    expect(describeError(new NoSuchTable({ table: "t", message: "" }))).toBe("t");
    expect(describeError(new EmptyTx({ message: "" }))).toBe("empty");
    expect(() => unreachable("nope" as never)).toThrow(Panic);
  });

  test("panic throws — definition mistakes are not values", () => {
    expect(() => panic("table `x` declared twice")).toThrow(Panic);
  });
});
