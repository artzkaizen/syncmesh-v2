import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { describe, expect, test } from "bun:test";

import { servedReadDdl, servedReadSettings } from "../served-rls.js";

const mailbox = partition("mailbox", { roles: ladder("owner") });
const columns = { id: t.text().primaryKey(), owner: t.text() };
const schema = syncSchema({
  tables: {
    mail: {
      columns,
      partition: mailbox,
      allow: ({ owner, deny }) => ({ $default: deny, read: owner("owner") }),
      sync: "window",
    },
    notes: {
      columns,
      partition: mailbox,
      allow: ({ owner, deny }) => ({ $default: deny, read: owner("owner") }),
      sync: "window",
    },
    open: { columns, sync: "window" },
  },
});

const ddl = servedReadDdl(schema, { role: "reader", grantTo: ["reads", "reads_b"] });

describe("servedReadDdl — what the read role is given (D43)", () => {
  test("a rule is a restrictive policy reading the principal row, never a setting", () => {
    const rules = ddl.filter((s) => s.startsWith('CREATE POLICY "syncmesh_served_rule"'));
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule).toContain('AS RESTRICTIVE FOR SELECT TO "reader"');
      expect(rule).toContain(`(SELECT "syncmesh_served"."principal"()) ->> 'account'`);
      expect(rule).not.toContain("current_setting");
    }
  });

  test("the role is granted to each login named, never to whoever runs the DDL", () => {
    const text = ddl.join("\n");
    expect(text).not.toContain("CURRENT_USER");
    expect(text).toContain('GRANT "reader" TO "reads"');
    expect(text).toContain('GRANT "reader" TO "reads_b"');
  });

  test("a table with no rule is granted nothing, and kept out of the sweep's list", () => {
    const grants = ddl.filter((s) => s.startsWith("GRANT SELECT"));
    expect(grants).toEqual([
      'GRANT SELECT ON "public"."mail" TO "reader"',
      'GRANT SELECT ON "public"."notes" TO "reader"',
    ]);
    const sweep = ddl.find((s) => s.includes("FROM pg_policy")) ?? "";
    expect(sweep).toContain(`to_regclass('"public"."notes"')`);
    expect(sweep).not.toContain('"open"');
  });

  test("a migrator that may not create roles says the role exists, and the DDL creates none", () => {
    const made = servedReadDdl(schema, { role: "reader", grantTo: "reads", createRole: false });
    expect(made.join("\n")).not.toContain('CREATE ROLE "reader"');
    expect(made[0]).toContain("createRole: false says it was made already");
  });
});

describe("servedReadSettings — the statement a served read starts with", () => {
  test("the principal is written before the transaction turns read-only, and nothing after", () => {
    const { sql, params } = servedReadSettings("reader", {
      account: "alice",
      role: "owner",
      claims: { team: "a" },
    });
    const at = (part: string) => sql.indexOf(part);
    expect(at('"syncmesh_served"."enter"')).toBeGreaterThan(-1);
    expect(at('"syncmesh_served"."enter"')).toBeLessThan(at("'transaction_read_only'"));
    expect(params).toEqual([
      "reader",
      '{"account":"alice","role":"owner","claims":{"team":"a"}}',
      "reader",
      "5000",
    ]);
  });
});
