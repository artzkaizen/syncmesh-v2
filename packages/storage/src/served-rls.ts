import type { Principal, ValidatorSchema } from "@syncmesh/engine";

import { Temporal, durationMs } from "@syncmesh/temporal";

import type { PrincipalSource, PrincipalStatement } from "./rls.js";

import { policyPredicate, str } from "./rls.js";

/**
 * The server half of D43's served reads: a Postgres role that may read the `sync: "window"`
 * tables and nothing else, with each table's read rule as its row-level policy; a login that
 * holds that role and nothing else; and the one statement that makes a transaction a served
 * read's.
 *
 * The reader's identity is not a setting. Anything a read can name, it can also change with
 * `set_config` in the same statement, so a policy that read `current_setting('syncmesh.account')`
 * could be told any account. The principal is a row instead, written by {@link SERVED}`.enter`
 * before the transaction turns read-only and never committed. Only that transaction can see it,
 * and nothing after the switch can write another.
 *
 * The role is not enough on its own either. `set_config('role', 'none', true)` takes a
 * transaction back to its login whatever role it was switched to. So a served read logs in as a
 * login that is a member of the read role alone; going back to that login gains nothing.
 */

/** The schema holding the principal rows and the two functions that write and read them. */
export const SERVED = "syncmesh_served";

/** A role or schema name as a quoted identifier: named by the host, never by a caller. */
const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** `mail` → `"public"."mail"`, `crm.mail` → `"crm"."mail"`: a manifest name as the table it names. */
const qualified = (name: string) => {
  const dot = name.indexOf(".");
  const schema = dot < 0 ? "public" : name.slice(0, dot);
  const table = `${ident(schema)}.${ident(dot < 0 ? name : name.slice(dot + 1))}`;
  return { schema, table };
};

/** The principal as a served policy reads it: from this transaction's row, once per statement. */
const PRINCIPAL = `(SELECT ${ident(SERVED)}."principal"())`;

/** {@link PRINCIPAL}'s parts, as the policy compiler takes them. */
export const SERVED_PRINCIPAL = {
  account: `NULLIF(${PRINCIPAL} ->> 'account', '')`,
  role: `NULLIF(${PRINCIPAL} ->> 'role', '')`,
  claims: `(${PRINCIPAL} -> 'claims')`,
} as const satisfies PrincipalSource;

/** What {@link servedReadDdl} reads off a manifest: its entries, and which are served. */
export interface ServedManifest {
  readonly entries: readonly (ValidatorSchema["entries"][number] & {
    readonly sync?: "window";
  })[];
  readonly rolesFor: ValidatorSchema["rolesFor"];
}

export interface ServedReadDdlOptions {
  /** The role served reads run as: it holds the `SELECT` grants and the policies. */
  readonly role: string;
  /**
   * The login, or logins, the served reads' connection logs in as. Each is made a member of
   * `role` and must hold nothing else: no other role, no table of its own, no grant on one. The
   * DDL refuses a login that does, because a read can always go back to its login.
   *
   * Create it before the DDL runs, with a password of its own:
   * `CREATE ROLE syncmesh_reads LOGIN PASSWORD '…'`.
   */
  readonly grantTo: string | readonly string[];
  /**
   * Whether the DDL creates `role`. Pass `false` when whoever runs migrations may not create
   * roles: then `role` must exist, and either it is already granted to each login or the
   * migrator holds it `WITH ADMIN OPTION`.
   * @default true
   */
  readonly createRole?: boolean;
}

/** The DDL that makes {@link SERVED}: its principal rows and the functions over them. */
const servedHome = (): readonly string[] => {
  const home = ident(SERVED);
  return [
    `CREATE SCHEMA IF NOT EXISTS ${home}`,
    // unlogged and never committed: a principal costs a row that only its transaction sees
    `CREATE UNLOGGED TABLE IF NOT EXISTS ${home}."principal" (xact xid8 PRIMARY KEY, principal jsonb NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${home}."login" (login name PRIMARY KEY, reader name NOT NULL)`,
    `CREATE OR REPLACE FUNCTION ${home}."principal"() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$ SELECT principal FROM ${home}."principal" WHERE xact = pg_current_xact_id_if_assigned() $f$`,
    `CREATE OR REPLACE FUNCTION ${home}."enter"(reader_role name, principal_json jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE
  who oid := (SELECT oid FROM pg_roles WHERE rolname = session_user);
  held name;
BEGIN
  IF NOT EXISTS (SELECT FROM ${home}."login" l WHERE l.login = session_user AND l.reader = reader_role) THEN
    RAISE EXCEPTION 'syncmesh: served reads log in as %, which servedReadDdl did not give the read role % (grantTo)', session_user, reader_role USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE oid = who) THEN
    RAISE EXCEPTION 'syncmesh: served reads log in as %, which row-level security does not hold', session_user USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT r.rolname INTO held FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = who AND r.rolname <> reader_role LIMIT 1;
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'syncmesh: served reads log in as %, which is also a member of %, and a read can take that role', session_user, held USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO ${home}."principal" VALUES (pg_current_xact_id(), principal_json);
END $f$`,
    `REVOKE ALL ON FUNCTION ${home}."principal"() FROM PUBLIC`,
    // anyone may try: `enter` refuses every login but the ones granted the role, and says why
    `GRANT USAGE ON SCHEMA ${home} TO PUBLIC`,
    `GRANT EXECUTE ON FUNCTION ${home}."enter"(name, jsonb) TO PUBLIC`,
  ];
};

/** `DO $$ … $$` for a block whose literals are all {@link str}-quoted names. */
const block = (body: string): string => `DO $syncmesh$ ${body} $syncmesh$`;

/** The role, created unless told it exists, and refused if it could read past the policies. */
const roleDdl = (role: string, create: boolean): string => {
  const name = str(role);
  const made = create
    ? `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${name}) THEN
    BEGIN
      CREATE ROLE ${ident(role)} NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'syncmesh: % may not create the read role %', current_user, ${name}
        USING ERRCODE = 'insufficient_privilege',
        HINT = format('Have a role with CREATEROLE run CREATE ROLE %I NOLOGIN, then pass createRole: false.', ${name});
    END;
  END IF;`
    : `IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${name}) THEN
    RAISE EXCEPTION 'syncmesh: the read role % does not exist, and createRole: false says it was made already', ${name}
      USING ERRCODE = 'undefined_object';
  END IF;`;
  return block(`BEGIN
  ${made}
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = ${name}) THEN
    RAISE EXCEPTION 'syncmesh: the read role % is a superuser or bypasses row-level security', ${name}
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END`);
};

/** `login` made a member of `role`, and refused if it holds anything a read could take back. */
const loginDdl = (role: string, login: string): string => {
  const [name, reader] = [str(login), str(role)];
  return block(`DECLARE
  who oid := (SELECT oid FROM pg_roles WHERE rolname = ${name});
  held text;
BEGIN
  IF who IS NULL THEN
    RAISE EXCEPTION 'syncmesh: the login % does not exist', ${name}
      USING ERRCODE = 'undefined_object',
      HINT = format('Create it with CREATE ROLE %I LOGIN PASSWORD ''…'' before granting it the read role.', ${name});
  END IF;
  IF NOT EXISTS (SELECT FROM pg_auth_members m WHERE m.member = who AND m.roleid = (SELECT oid FROM pg_roles WHERE rolname = ${reader})) THEN
    BEGIN
      GRANT ${ident(role)} TO ${ident(login)};
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'syncmesh: % may not grant the read role % to %', current_user, ${reader}, ${name}
        USING ERRCODE = 'insufficient_privilege',
        HINT = format('Have the role''s admin run GRANT %I TO %I.', ${reader}, ${name});
    END;
  END IF;
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE oid = who) THEN
    RAISE EXCEPTION 'syncmesh: the login % is a superuser or bypasses row-level security', ${name}
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO held FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
    WHERE m.member = who AND r.rolname <> ${reader};
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'syncmesh: the login % is also a member of %, which a served read could take with set_config(''role'', …)', ${name}, held
      USING ERRCODE = 'insufficient_privilege',
      HINT = 'Give served reads a login that holds the read role and nothing else.';
  END IF;
  SELECT string_agg(c.oid::regclass::text, ', ' ORDER BY c.relname) INTO held FROM pg_class c
    WHERE c.relowner = who OR EXISTS (SELECT FROM aclexplode(c.relacl) a WHERE a.grantee = who);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'syncmesh: the login % owns or is granted %, which a served read could read after set_config(''role'', ''none'', true)', ${name}, held
      USING ERRCODE = 'insufficient_privilege',
      HINT = 'Give served reads a login that holds the read role and nothing else.';
  END IF;
END`);
};

/**
 * Takes back what the role was given for a table that is no longer served with a rule: its
 * `SELECT`, its policies, and `USAGE` on a schema with no served table left.
 */
const sweepDdl = (role: string, tables: readonly string[], schemas: readonly string[]): string => {
  const reader = str(role);
  const kept = `array_remove(ARRAY[${tables.map((t) => `to_regclass(${str(t)})::oid`).join(", ")}]::oid[], NULL)`;
  const keptSchemas = `ARRAY[${[...new Set([SERVED, ...schemas])].map(str).join(", ")}]::name[]`;
  return block(`DECLARE
  who oid := (SELECT oid FROM pg_roles WHERE rolname = ${reader});
  gone record;
BEGIN
  FOR gone IN SELECT c.oid::regclass AS t FROM pg_class c
    WHERE EXISTS (SELECT FROM aclexplode(c.relacl) a WHERE a.grantee = who) AND NOT c.oid = ANY (${kept})
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM %I', gone.t, ${reader});
  END LOOP;
  FOR gone IN SELECT DISTINCT p.polrelid::regclass AS t FROM pg_policy p
    WHERE p.polname IN ('syncmesh_served_read', 'syncmesh_served_rule') AND who = ANY (p.polroles) AND NOT p.polrelid = ANY (${kept})
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS syncmesh_served_read ON %s', gone.t);
    EXECUTE format('DROP POLICY IF EXISTS syncmesh_served_rule ON %s', gone.t);
  END LOOP;
  FOR gone IN SELECT n.nspname AS s FROM pg_namespace n
    WHERE EXISTS (SELECT FROM aclexplode(n.nspacl) a WHERE a.grantee = who) AND NOT n.nspname = ANY (${keptSchemas})
  LOOP
    EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM %I', gone.s, ${reader});
  END LOOP;
END`);
};

/**
 * A `WARNING` for each `SECURITY DEFINER` function the role can run: it runs as its owner, so a
 * served read could read through it whatever the role may read. Postgres grants `EXECUTE` to
 * `PUBLIC` by default, which is not the role's to give back, so the fix is the app's.
 */
const definerWarnings = (role: string): string => {
  const reader = str(role);
  return block(`DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS fn, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema', ${str(SERVED)})
      AND has_schema_privilege(${reader}, n.oid, 'USAGE') AND has_function_privilege(${reader}, p.oid, 'EXECUTE')
  LOOP
    RAISE WARNING 'syncmesh: the read role % can run %, a SECURITY DEFINER function that runs as %', ${reader}, f.fn, f.owner
      USING HINT = format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, then grant it to the roles that call it.', f.fn);
  END LOOP;
END`);
};

/**
 * The DDL that serves reads to `role` (D43): `SELECT` on each `sync: "window"` table that has a
 * read rule, that rule as a restrictive row-level policy for `role`, and nothing else; each
 * {@link ServedReadDdlOptions.grantTo} login made a member of `role`; and {@link SERVED}, where a
 * served read's principal is kept. Run it as the tables' owner, in a migration, after every
 * schema change to the served tables. Idempotent.
 *
 * A served read runs {@link servedReadSettings} in a transaction on a connection logged in as one
 * of those logins, so even a raw `sql` fragment naming a table reads only what the reader may: a
 * table off the list is `permission denied`, and a listed one is filtered by Postgres.
 *
 * The rule's policy is restrictive, so another policy on the table that is open to `PUBLIC` does
 * not widen what `role` reads. A table that had no row-level security is given an open policy
 * for every role, so enabling it here changes nothing for them. A table that is no longer served
 * with a rule loses its grant and its policies.
 *
 * The DDL warns about every `SECURITY DEFINER` function `role` can run. It refuses a login that
 * holds anything besides `role`, and a migrator that may not create or grant `role` is told
 * which statement to have someone else run.
 *
 * @example
 * // in a migration, as the tables' owner
 * for (const statement of servedReadDdl(schema, { role: "syncmesh_reader", grantTo: "syncmesh_reads" }))
 *   await sql.unsafe(statement);
 * // in the server, over a connection that logs in as syncmesh_reads
 * servedReads({ …, db: drizzle({ client: postgres(readsUrl) }), readRole: "syncmesh_reader" });
 */
export function servedReadDdl(
  schema: ServedManifest,
  options: ServedReadDdlOptions,
): readonly string[] {
  const { role, createRole = true } = options;
  const logins = [options.grantTo].flat();
  const who = ident(role);
  const home = ident(SERVED);
  const served = schema.entries.filter(
    (entry) => entry.sync === "window" && entry.allow !== undefined,
  );
  const tables = served.map((entry) => qualified(entry.table.name));
  const statements = [
    roleDdl(role, createRole),
    ...servedHome(),
    ...logins.map((login) => loginDdl(role, login)),
    `DELETE FROM ${home}."login" WHERE reader = ${str(role)} AND NOT login = ANY (ARRAY[${logins.map(str).join(", ")}]::name[])`,
    ...logins.map(
      (login) =>
        `INSERT INTO ${home}."login" VALUES (${str(login)}, ${str(role)}) ON CONFLICT (login) DO UPDATE SET reader = EXCLUDED.reader`,
    ),
    `GRANT EXECUTE ON FUNCTION ${home}."principal"() TO ${who}`,
    sweepDdl(
      role,
      tables.map((t) => t.table),
      tables.map((t) => t.schema),
    ),
  ];
  for (const [n, entry] of served.entries()) {
    const name = tables[n];
    if (name === undefined || entry.allow === undefined) continue;
    const rule = policyPredicate(
      entry.table,
      schema.rolesFor(entry.partition),
      entry.allow,
      SERVED_PRINCIPAL,
    );
    statements.push(
      // `public` is usable by everyone already: granting it again only says no privilege was granted
      block(
        `BEGIN IF NOT has_schema_privilege(${str(role)}, ${str(name.schema)}, 'USAGE') THEN GRANT USAGE ON SCHEMA ${ident(name.schema)} TO ${who}; END IF; END`,
      ),
      `GRANT SELECT ON ${name.table} TO ${who}`,
      block(
        `BEGIN IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ${str(name.table)}::regclass) THEN ALTER TABLE ${name.table} ENABLE ROW LEVEL SECURITY; CREATE POLICY "syncmesh_served_others" ON ${name.table} FOR ALL TO PUBLIC USING (TRUE) WITH CHECK (TRUE); END IF; END`,
      ),
      `DROP POLICY IF EXISTS "syncmesh_served_read" ON ${name.table}`,
      `CREATE POLICY "syncmesh_served_read" ON ${name.table} AS PERMISSIVE FOR SELECT TO ${who} USING (TRUE)`,
      `DROP POLICY IF EXISTS "syncmesh_served_rule" ON ${name.table}`,
      `CREATE POLICY "syncmesh_served_rule" ON ${name.table} AS RESTRICTIVE FOR SELECT TO ${who} USING (${rule})`,
    );
  }
  statements.push(definerWarnings(role));
  return statements;
}

/** The {@link servedReadSettings} timeout a served read takes when none is given. */
export const SERVED_READ_TIMEOUT = Temporal.Duration.from({ seconds: 5 });

/**
 * The one statement that starts a served read (D43): it writes the principal's row with
 * {@link SERVED}`.enter`, which first checks the login is one the DDL granted `role`, then
 * switches to `role`, turns the transaction read-only, and bounds each statement by `timeout`. Run it first in the transaction, then roll the transaction back: the
 * principal's row is never committed, and the settings end with it.
 *
 * `enter` runs before the switch to read-only, which is what makes it the only write: once the
 * transaction is read-only no statement can write a second principal, or turn it read-write.
 *
 * @example
 * servedReadSettings("syncmesh_reader", principal);
 * // SELECT "syncmesh_served"."enter"($1, $2::jsonb), set_config('role', $3, TRUE), …
 */
export function servedReadSettings(
  role: string,
  principal: Principal,
  timeout = SERVED_READ_TIMEOUT,
): PrincipalStatement {
  const who = { account: principal.account, role: principal.role, claims: principal.claims };
  return {
    sql: `SELECT ${ident(SERVED)}."enter"($1, $2::jsonb), set_config('role', $3, TRUE), set_config('transaction_read_only', 'on', TRUE), set_config('statement_timeout', $4, TRUE)`,
    params: [role, JSON.stringify(who), role, `${Math.max(1, Math.ceil(durationMs(timeout)))}`],
  };
}
