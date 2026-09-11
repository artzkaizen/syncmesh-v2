import { describe, expect, test } from "bun:test";

import { TaggedError } from "../index.js";
import { ForeignTagged, createTaggedCatalog, serializeTagged } from "../wire.js";

class NameTaken extends TaggedError("NameTaken")<{
  readonly room: string;
  cause?: unknown;
  message?: string;
}> {}
class Unreachable extends TaggedError("Unreachable")<{
  readonly triedRoutes: number;
  message?: string;
}> {}

describe("tagged errors across the wire", () => {
  test("a declared class survives the round trip as itself", () => {
    const wire = serializeTagged(new NameTaken({ room: "ward-3", message: "already reserved" }));
    const revived = createTaggedCatalog([NameTaken, Unreachable]).revive(
      JSON.parse(JSON.stringify(wire)),
    );
    expect(revived instanceof NameTaken).toBe(true);
    expect(revived?._tag).toBe("NameTaken");
    expect(revived instanceof NameTaken && revived.room).toBe("ward-3");
    expect(revived?.message).toBe("already reserved");
  });

  test("the stack stays home and the cause flattens to its message", () => {
    const wire = serializeTagged(
      new NameTaken({ room: "n", message: "m", cause: new Error("the driver said no") }),
    );
    expect("stack" in wire).toBe(false);
    expect(wire.cause).toBe("the driver said no");
  });

  test("an undeclared tag arrives as ForeignTagged with its facts intact", () => {
    const revived = createTaggedCatalog([]).revive({ _tag: "QuotaExceeded", used: 9 });
    expect(revived instanceof ForeignTagged).toBe(true);
    expect(revived instanceof ForeignTagged && revived.tag).toBe("QuotaExceeded");
    expect(revived instanceof ForeignTagged && revived.fields.used).toBe(9);
  });

  test("a payload that is not a tagged wire revives to nothing", () => {
    const catalog = createTaggedCatalog([NameTaken]);
    expect(catalog.revive("just a string")).toBeUndefined();
    expect(catalog.revive({ message: "no tag here" })).toBeUndefined();
    expect(catalog.revive(null)).toBeUndefined();
  });

  test("an error that never crossed passes through untouched", () => {
    const original = new Unreachable({ triedRoutes: 3 });
    expect(createTaggedCatalog([Unreachable]).revive(original)).toBe(original);
  });
});
