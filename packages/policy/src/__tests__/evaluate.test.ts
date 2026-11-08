import { describe, expect, test } from "bun:test";

import {
  all,
  allow,
  allowEntry,
  any,
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
import { evaluate, explain, roleAtLeast, type RoleSet } from "../evaluate.js";
import { ruleText } from "../text.js";
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
    expect(evaluate(any(role("admin"), owner("createdBy")), c)).toBe(true);
    expect(evaluate(all(role("admin"), owner("createdBy")), c)).toBe(false);
    expect(evaluate(all(owner("createdBy"), not(rowIs({ status: "approved" }))), c)).toBe(false);
    expect(evaluate(any(), c)).toBe(false);
    expect(evaluate(all(), c)).toBe(true);
  });

  test("the same document and context give the same verdict on every call", () => {
    const rule = all(
      any(owner("createdBy"), role("admin")),
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

describe("roleAtLeast — the ladder's direction, pinned", () => {
  /**
   * Senior first. `ladder("owner", "admin", "member")` means `role("member")` admits owners and
   * admins too, and this is the assertion that stops the array being written the other way round
   * — which would compile, and would quietly invert every permission in an app.
   */
  const ladder = { names: ["owner", "admin", "member"], ordered: true } as const satisfies RoleSet;

  test("a senior holder satisfies a junior requirement", () => {
    expect(roleAtLeast(ladder, "owner", "member")).toBe(true);
    expect(roleAtLeast(ladder, "admin", "member")).toBe(true);
    expect(roleAtLeast(ladder, "member", "member")).toBe(true);
  });

  test("a junior holder never satisfies a senior requirement", () => {
    expect(roleAtLeast(ladder, "member", "admin")).toBe(false);
    expect(roleAtLeast(ladder, "member", "owner")).toBe(false);
    expect(roleAtLeast(ladder, "admin", "owner")).toBe(false);
  });

  test("an unknown role on either side is never enough", () => {
    expect(roleAtLeast(ladder, "auditor", "member")).toBe(false);
    expect(roleAtLeast(ladder, "owner", "auditor")).toBe(false);
    expect(roleAtLeast(ladder, undefined, "member")).toBe(false);
  });

  /**
   * `flat("auditor", "billing")` names two roles with no order between them: position in the
   * array is spelling, not seniority, so `role("billing")` admits billing and nobody else.
   */
  const flat = { names: ["auditor", "billing"], ordered: false } as const satisfies RoleSet;

  test("in a flat set only the exact role passes, in either direction", () => {
    expect(roleAtLeast(flat, "auditor", "auditor")).toBe(true);
    expect(roleAtLeast(flat, "billing", "billing")).toBe(true);
    expect(roleAtLeast(flat, "auditor", "billing")).toBe(false);
    expect(roleAtLeast(flat, "billing", "auditor")).toBe(false);
  });

  test("a flat set is as strict about unknown roles as a ladder is", () => {
    expect(roleAtLeast(flat, "owner", "auditor")).toBe(false);
    expect(roleAtLeast(flat, "auditor", "owner")).toBe(false);
    expect(roleAtLeast(flat, undefined, "auditor")).toBe(false);
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

  test("replace: its own rule, else whatever update resolves to (RFC-0023 §16.2)", () => {
    expect(resolveAllow(block, "replace")).toEqual(role("admin"));
    expect(resolveAllow({ ...block, update: role("editor") }, "replace")).toEqual(role("editor"));
    expect(resolveAllow({ ...block, replace: role("owner") }, "replace")).toEqual(role("owner"));
    expect(resolveAllow({ $default: deny }, "replace")).toEqual(deny);
  });
});

describe("explain — the verdict and the leaves that reached it", () => {
  test("a leaf names itself, at the root", () => {
    expect(explain(role("admin"), ctx())).toEqual({
      allowed: false,
      because: [{ node: role("admin"), path: [], held: false }],
    });
  });

  test("all: denied by its first failing leaf; allowed by every leaf", () => {
    const rule = all(role("member"), owner("createdBy"), role("viewer"));
    const theirs = ctx({ row: row({ createdBy: "acct_b" }) });
    expect(explain(rule, theirs)).toEqual({
      allowed: false,
      because: [{ node: owner("createdBy"), path: [1], held: false }],
    });
    expect(explain(rule, ctx({ row: row({ createdBy: "acct_a" }) })).because).toHaveLength(3);
  });

  test("any: allowed by its first holding leaf; denied by every leaf, since each had to fail", () => {
    const rule = any(role("admin"), all(role("member"), owner("createdBy")));
    expect(explain(rule, ctx({ row: row({ createdBy: "acct_a" }) }))).toEqual({
      allowed: true,
      because: [
        { node: role("member"), path: [1, 0], held: true },
        { node: owner("createdBy"), path: [1, 1], held: true },
      ],
    });
    expect(explain(rule, ctx({ row: row({ createdBy: "acct_b" }) }))).toEqual({
      allowed: false,
      because: [
        { node: role("admin"), path: [0], held: false },
        { node: owner("createdBy"), path: [1, 1], held: false },
      ],
    });
  });

  test("not: the leaf under it, as the leaf said it, and the verdict turned round", () => {
    expect(explain(not(role("member")), ctx())).toEqual({
      allowed: false,
      because: [{ node: role("member"), path: [0], held: true }],
    });
  });

  test("always the verdict evaluate gives, over every node and both outcomes", () => {
    const leaves = [
      allow,
      deny,
      role("member"),
      role("admin"),
      owner("createdBy"),
      claimHas("entities", "entity"),
      claimIncludes("permissions.controls", "update"),
      claimEquals("member", "memberId"),
      rowIs({ status: "open" }),
      patchOnly(["title"]),
    ];
    const contexts = [
      ctx(),
      ctx({ row: row({ createdBy: "acct_a", entity: "e_root", status: "open", memberId: "m_1" }) }),
      ctx({ patch: row({ title: "t", body: "b" }), grant: grantWithoutRole() }),
    ];
    const trees = leaves.flatMap((a) =>
      leaves.flatMap((b) => [all(a, b), any(a, b), not(any(a, not(b))), all(any(a, b), not(a))]),
    );
    for (const tree of trees)
      for (const context of contexts)
        expect(explain(tree, context).allowed).toBe(evaluate(tree, context));
  });
});

describe("allowEntry — which entry of the block answered", () => {
  const block: AllowBlock = { $default: deny, write: role("member"), update: role("admin") };
  test("the operation's own, then write for a write, then $default; replace as update", () => {
    expect(allowEntry(block, "update").key).toBe("update");
    expect(allowEntry(block, "insert").key).toBe("write");
    expect(allowEntry(block, "read").key).toBe("$default");
    expect(allowEntry(block, "replace")).toEqual({ key: "update", node: role("admin") });
    expect(allowEntry({ ...block, replace: allow }, "replace")).toEqual({
      key: "replace",
      node: allow,
    });
    for (const op of ["insert", "update", "delete", "read", "replace", "archive"])
      expect(allowEntry(block, op).node).toBe(resolveAllow(block, op));
  });
});

describe("ruleText — a rule as the builders spell it", () => {
  test("leaves, combinators and constants", () => {
    expect(ruleText(any(role("admin"), owner("createdBy")))).toBe(
      'any(role("admin"), owner("createdBy"))',
    );
    expect(ruleText(not(patchOnly(["title", "body"])))).toBe('not(patchOnly(["title", "body"]))');
    expect(ruleText(rowIs({ status: "open", rank: 2 }))).toBe('rowIs({ status: "open", rank: 2 })');
    expect(ruleText(claimIncludes("permissions.controls", "update"))).toBe(
      'claimIncludes("permissions.controls", "update")',
    );
    expect(ruleText(all(allow, deny))).toBe("all(allow, deny)");
  });
});
