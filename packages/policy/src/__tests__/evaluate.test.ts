import { describe, expect, test } from "bun:test";

import {
  allOf,
  allow,
  anyOf,
  claimEquals,
  claimHas,
  claimIncludes,
  deny,
  not,
  owner,
  patchOnly,
  resolveAllow,
  role,
  rowIs,
  type AllowBlock,
} from "../ast.js";
import { evaluate } from "../evaluate.js";
import { ctx, grant, grantWithoutRole, row } from "./fixtures.js";

describe("evaluate — every node, both outcomes", () => {
  test("allow / deny", () => {
    expect(evaluate(allow, ctx())).toBe(true);
    expect(evaluate(deny, ctx())).toBe(false);
  });

  test("role: the grant's role or more senior; unknown roles never pass", () => {
    expect(evaluate(role("member"), ctx())).toBe(true);
    expect(evaluate(role("viewer"), ctx())).toBe(true);
    expect(evaluate(role("admin"), ctx())).toBe(false);
    expect(evaluate(role("admin"), ctx({ grant: grant({ role: "owner" }) }))).toBe(true);
    expect(evaluate(role("nope"), ctx({ grant: grant({ role: "owner" }) }))).toBe(false);
    expect(evaluate(role("member"), ctx({ grant: grant({ role: "nope" }) }))).toBe(false);
    expect(evaluate(role("member"), ctx({ grant: grantWithoutRole() }))).toBe(false);
  });

  test("owner: the row's column equals the account; the patch is read first, then the row", () => {
    expect(evaluate(owner("createdBy"), ctx({ row: row({ createdBy: "acct_a" }) }))).toBe(true);
    expect(evaluate(owner("createdBy"), ctx({ row: row({ createdBy: "acct_b" }) }))).toBe(false);
    expect(evaluate(owner("createdBy"), ctx({ patch: row({ createdBy: "acct_a" }) }))).toBe(true);
    expect(evaluate(owner("createdBy"), ctx())).toBe(false);
  });

  test("claim(...).has / .equals read dotted paths; non-scalars never match", () => {
    expect(
      evaluate(claimHas("entities", "entityId"), ctx({ row: row({ entityId: "e_berlin" }) })),
    ).toBe(true);
    expect(
      evaluate(claimHas("entities", "entityId"), ctx({ row: row({ entityId: "e_munich" }) })),
    ).toBe(false);
    expect(
      evaluate(claimHas("permissions.controls", "action"), ctx({ row: row({ action: "update" }) })),
    ).toBe(true);
    expect(
      evaluate(claimHas("permissions.controls", "action"), ctx({ row: row({ action: "delete" }) })),
    ).toBe(false);
    expect(
      evaluate(claimHas("permissions.nope", "action"), ctx({ row: row({ action: "read" }) })),
    ).toBe(false);
    expect(
      evaluate(claimEquals("member", "ownerMemberId"), ctx({ row: row({ ownerMemberId: "m_1" }) })),
    ).toBe(true);
    expect(
      evaluate(claimEquals("member", "ownerMemberId"), ctx({ row: row({ ownerMemberId: "m_2" }) })),
    ).toBe(false);
    expect(evaluate(claimEquals("permissions", "x"), ctx({ row: row({ x: "anything" }) }))).toBe(
      false,
    );
    expect(evaluate(claimIncludes("permissions.controls", "update"), ctx())).toBe(true);
    expect(evaluate(claimIncludes("permissions.controls", "delete"), ctx())).toBe(false);
    expect(evaluate(claimIncludes("entities", "e_root"), ctx())).toBe(true);
  });

  test("rowIs matches every listed column", () => {
    expect(
      evaluate(rowIs({ status: "open", n: 1 }), ctx({ row: row({ status: "open", n: 1 }) })),
    ).toBe(true);
    expect(
      evaluate(rowIs({ status: "open", n: 1 }), ctx({ row: row({ status: "open", n: 2 }) })),
    ).toBe(false);
    expect(evaluate(rowIs({ status: "open" }), ctx())).toBe(false);
  });

  test("patchOnly: every touched column is listed; no patch passes", () => {
    expect(evaluate(patchOnly(["title", "body"]), ctx({ patch: row({ title: "x" }) }))).toBe(true);
    expect(
      evaluate(patchOnly(["title"]), ctx({ patch: row({ title: "x", status: "done" }) })),
    ).toBe(false);
    expect(evaluate(patchOnly(["title"]), ctx())).toBe(true);
  });

  test("any / all / not compose", () => {
    const c = ctx({ row: row({ createdBy: "acct_a", status: "approved" }) });
    expect(evaluate(anyOf(role("admin"), owner("createdBy")), c)).toBe(true);
    expect(evaluate(allOf(role("admin"), owner("createdBy")), c)).toBe(false);
    expect(evaluate(allOf(owner("createdBy"), not(rowIs({ status: "approved" }))), c)).toBe(false);
    expect(evaluate(anyOf(), c)).toBe(false);
    expect(evaluate(allOf(), c)).toBe(true);
  });

  test("the same document and context give the same verdict on every call", () => {
    const rule = allOf(
      anyOf(owner("createdBy"), role("admin")),
      patchOnly(["title"]),
      not(rowIs({ locked: true })),
    );
    const c = ctx({ row: row({ createdBy: "acct_a", locked: false }), patch: row({ title: "t" }) });
    expect([
      evaluate(rule, c),
      evaluate(rule, c),
      evaluate(JSON.parse(JSON.stringify(rule)), c),
    ]).toEqual([true, true, true]);
  });
});

describe("resolveAllow", () => {
  const block: AllowBlock = {
    $default: role("member"),
    write: role("admin"),
    delete: role("owner"),
    approve: role("admin"),
  };
  test("op, then write for writes, then $default", () => {
    expect(resolveAllow(block, "read")).toEqual(role("member"));
    expect(resolveAllow(block, "insert")).toEqual(role("admin"));
    expect(resolveAllow(block, "update")).toEqual(role("admin"));
    expect(resolveAllow(block, "delete")).toEqual(role("owner"));
    expect(resolveAllow(block, "approve")).toEqual(role("admin"));
    expect(resolveAllow(block, "export")).toEqual(role("member"));
    expect(resolveAllow({ $default: deny }, "insert")).toEqual(deny);
  });
});
