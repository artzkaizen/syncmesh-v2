import type { Principal } from "@syncmesh/engine";

import { deny, role } from "@syncmesh/policy";
import { flat, ladder } from "@syncmesh/schema";
import { describe, expect, test } from "bun:test";

import { JOBS } from "../driver-tests/fixtures.js";
import { compileRead } from "../read-filter.js";
import { rlsDdl } from "../rls.js";

/**
 * The two shapes a role set takes, as SQL. A ladder compiles to "this rung or one before it";
 * a flat set compiles to equality, because there is no before — and nothing in the DDL may
 * pretend otherwise, or a `billing` reader would see an auditor's rows on the server alone.
 */
const ROLE = `NULLIF(current_setting('syncmesh.role', TRUE), '')`;
const readPolicy = (ddl: readonly string[]): string =>
  ddl.find((sql) => sql.includes('"syncmesh_read"') && sql.startsWith("CREATE")) ?? "";

describe("rlsDdl — a role check compiles to what the set's shape means", () => {
  const read = { $default: deny, read: role("tech") };

  test("a ladder admits the wanted rung and every one before it", () => {
    const policy = readPolicy(rlsDdl(JOBS, ladder("owner", "dispatcher", "tech", "viewer"), read));
    expect(policy).toContain(
      `array_position(ARRAY['owner', 'dispatcher', 'tech', 'viewer']::text[], ${ROLE}) <= 3`,
    );
  });

  test("a flat set admits exactly the wanted name", () => {
    const policy = readPolicy(rlsDdl(JOBS, flat("auditor", "tech"), read));
    expect(policy).toContain(`COALESCE(${ROLE} = 'tech', FALSE)`);
    expect(policy).not.toContain("array_position");
  });

  test("a role the set does not name admits nobody, in either shape", () => {
    expect(readPolicy(rlsDdl(JOBS, flat("auditor"), read))).toContain("USING ((FALSE)");
    expect(readPolicy(rlsDdl(JOBS, ladder("auditor"), read))).toContain("USING ((FALSE)");
  });
});

describe("compileRead — a flat set is equality on the device too", () => {
  const roles = flat("auditor", "billing");
  const asRole = (name: string): Principal => ({ account: "acct", role: name, claims: {} });
  const verdict = (principal: Principal) =>
    compileRead(JOBS, roles, { $default: deny, read: role("billing") }, principal).sql;

  test("exactly billing passes; auditor does not stand in for it", () => {
    expect(verdict(asRole("billing"))).toBe("1");
    expect(verdict(asRole("auditor"))).toBe("0");
    expect(verdict({ account: "acct", claims: {} })).toBe("0");
  });
});
