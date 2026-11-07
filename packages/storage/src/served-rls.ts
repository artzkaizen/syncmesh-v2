import type { Principal, ValidatorSchema } from "@syncmesh/engine";

import type { PrincipalStatement } from "./rls.js";

import { policyPredicate, principalValues, str } from "./rls.js";

/**
 * The server half of D43's served reads: a Postgres role that may read the `sync: "window"`
 * tables and nothing else, with each table's read rule as its row-level policy, and the one
 * statement that makes a transaction run as it.
 */

/** A role or schema name as a quoted identifier: named by the host, never by a caller. */
const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** `mail` → `"public"."mail"`, `crm.mail` → `"crm"."mail"`: a manifest name as the table it names. */
const qualified = (name: string) => {
  const dot = name.indexOf(".");
  const schema = ident(dot < 0 ? "public" : name.slice(0, dot));
  return { schema, table: `${schema}.${ident(dot < 0 ? name : name.slice(dot + 1))}` };
};

/** What {@link servedReadDdl} reads off a manifest: its entries, and which are served. */
export interface ServedManifest {
  readonly entries: readonly (ValidatorSchema["entries"][number] & {
    readonly sync?: "window";
  })[];
  readonly rolesFor: ValidatorSchema["rolesFor"];
}

/**
 * The DDL that makes `role` the one a server's window reads run as (D43): `SELECT` on each
 * `sync: "window"` table that has a read rule, that rule as a row-level policy for `role`, and
 * nothing else. A served read runs `SET LOCAL ROLE role` in a `READ ONLY` transaction with the
 * reader's {@link principalSettings}, so even a raw `sql` fragment naming a table reads only
 * what the reader may: a table off the list is `permission denied`, a listed one is filtered by
 * Postgres. Idempotent.
 *
 * A table that had no row-level security is given an open policy for every other role, so
 * enabling it here changes nothing for them. One that already had it (`rlsDdl`) keeps its own
 * policies for them. Give `role` to the served reads alone: whatever else it is granted, a
 * served read can read too.
 *
 * @example
 * for (const statement of servedReadDdl(schema, "syncmesh_reader")) await sql.unsafe(statement);
 * servedReads({ …, readRole: "syncmesh_reader" });
 */
export function servedReadDdl(schema: ServedManifest, role: string): readonly string[] {
  const who = ident(role);
  const statements = [
    `DO $$ BEGIN CREATE ROLE ${who} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    // whoever serves the reads switches to the role, so it has to be a member
    `GRANT ${who} TO CURRENT_USER`,
  ];
  for (const entry of schema.entries) {
    // a served table with no rule is readable by no one, so the role is never granted it
    if (entry.sync !== "window" || entry.allow === undefined) continue;
    const name = qualified(entry.table.name);
    const predicate = policyPredicate(entry.table, schema.rolesFor(entry.partition), entry.allow);
    statements.push(
      `GRANT USAGE ON SCHEMA ${name.schema} TO ${who}`,
      `GRANT SELECT ON ${name.table} TO ${who}`,
      `DO $$ BEGIN IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ${str(name.table)}::regclass) THEN ALTER TABLE ${name.table} ENABLE ROW LEVEL SECURITY; CREATE POLICY "syncmesh_served_others" ON ${name.table} FOR ALL TO PUBLIC USING (current_user <> ${str(role)}) WITH CHECK (TRUE); END IF; END $$`,
      `DROP POLICY IF EXISTS "syncmesh_served_read" ON ${name.table}`,
      `CREATE POLICY "syncmesh_served_read" ON ${name.table} FOR SELECT TO ${who} USING (${predicate})`,
    );
  }
  return statements;
}

/** `$1, $2` for the `n`th setting of a `set_config` list: its name and its value. */
const settingAt = (n: number): string => `set_config($${2 * n + 1}, $${2 * n + 2}, TRUE)`;

/**
 * The one statement that makes a transaction a served read's (D43): read-only, running as
 * `role` (the `role` setting is what `SET ROLE` sets), and with the principal's settings, so
 * {@link servedReadDdl}'s policies filter what it reads. One round trip, run first in the
 * transaction; all of it ends with the transaction.
 *
 * @example
 * servedReadSettings("syncmesh_reader", principal);
 * // SELECT set_config($1, $2, TRUE), … with ["transaction_read_only", "on", "role", "syncmesh_reader", …]
 */
export function servedReadSettings(role: string, principal: Principal): PrincipalStatement {
  const settings = [
    ["transaction_read_only", "on"],
    ["role", role],
    ...principalValues(principal, undefined),
  ] as const;
  return {
    sql: `SELECT ${settings.map((_, n) => settingAt(n)).join(", ")}`,
    params: settings.flat(),
  };
}
