import type { JsonValue } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import { all, any, deny, not, owner, patchOnly, role, rowIs, claimHas } from "../ast.js";
import { parsePolicyDoc, type PolicyDoc } from "../doc.js";

const doc: PolicyDoc = {
  books: {
    $default: role("member"),
    update: any(owner("createdBy"), role("admin")),
    delete: all(role("admin"), not(rowIs({ rating: 5 })), patchOnly([])),
  },
  controls: { $default: deny, read: claimHas("entities", "entityId") },
};

describe("PolicyDoc", () => {
  test("JSON round-trip is byte-stable — it syncs as data", () => {
    const once = JSON.stringify(doc);
    const parsed = parsePolicyDoc(JSON.parse(once)).unwrap();
    expect(JSON.stringify(parsed)).toBe(once);
    expect(parsed).toEqual(doc);
  });

  test("a malformed document is a value with the path that failed; nothing partial", () => {
    const bad = (json: JsonValue, path: string) => {
      const r = parsePolicyDoc(json);
      expect(r.isErr() && `${r.error.path}: ${r.error.message}`).toContain(path);
    };
    bad([], "expected an object");
    bad({ books: { read: { kind: "allow" } } }, "books: an allow block needs $default");
    bad({ books: { $default: { kind: "nope" } } }, 'books.$default: unknown rule kind "nope"');
    bad({ books: { $default: { kind: "role" } } }, "books.$default: role needs a name");
    bad(
      { books: { $default: { kind: "any", of: [{ kind: "allow" }, { kind: "owner" }] } } },
      "books.$default.of[1]",
    );
    bad({ books: { $default: { kind: "rowIs", where: { a: [1] } } } }, "scalar");
  });
});
