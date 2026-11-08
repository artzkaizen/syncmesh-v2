import type { PolicyNode } from "@syncmesh/policy";

import { str } from "./rls.js";

/**
 * The statements `servedReadDdl` is made of: the role, its logins, the sweep of what a table
 * that left the manifest was given, the warnings, and the view a table with a ruled column is read
 * through. Each is a name-quoted statement or a `DO` block; none is run here.
 */

/** The schema holding the principal rows and the two functions that write and read them. */
export const SERVED = "syncmesh_served";

/** A role or schema name as a quoted identifier: named by the host, never by a caller. */
export const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** `DO $$ … $$` for a block whose literals are all {@link str}-quoted names. */
export const block = (body: string): string => `DO $syncmesh$ ${body} $syncmesh$`;

/** The role, created unless told it exists, and refused if it could read past the policies. */
export const roleDdl = (role: string, create: boolean): string => {
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
export const loginDdl = (role: string, login: string): string => {
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
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO held FROM pg_roles r
    WHERE r.oid <> who AND r.rolname <> ${reader} AND pg_has_role(who, r.oid, 'MEMBER');
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
 * `SELECT`, its policies, its view in {@link SERVED}, and `USAGE` on a schema with no served
 * table left. `tables` are the tables and views kept.
 */
export const sweepDdl = (
  role: string,
  tables: readonly string[],
  schemas: readonly string[],
): string => {
  const reader = str(role);
  const kept = `array_remove(ARRAY[${tables.map((t) => `to_regclass(${str(t)})::oid`).join(", ")}]::oid[], NULL)`;
  const keptSchemas = `ARRAY[${[...new Set([SERVED, ...schemas])].map(str).join(", ")}]::name[]`;
  return block(`DECLARE
  who oid := (SELECT oid FROM pg_roles WHERE rolname = ${reader});
  gone record;
BEGIN
  FOR gone IN SELECT c.oid::regclass AS t FROM pg_class c
    WHERE c.relnamespace = ${str(SERVED)}::regnamespace AND c.relkind = 'v'
      AND EXISTS (SELECT FROM aclexplode(c.relacl) a WHERE a.grantee = who) AND NOT c.oid = ANY (${kept})
  LOOP
    EXECUTE format('DROP VIEW %s', gone.t);
  END LOOP;
  FOR gone IN SELECT c.oid::regclass AS t FROM pg_class c
    WHERE (EXISTS (SELECT FROM aclexplode(c.relacl) a WHERE a.grantee = who)
        OR EXISTS (SELECT FROM pg_attribute at, aclexplode(at.attacl) a WHERE at.attrelid = c.oid AND a.grantee = who))
      AND NOT c.oid = ANY (${kept})
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
export const definerWarnings = (role: string): string => {
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
 * A `WARNING` for each table or view the role can read that `served` does not name: one granted
 * to `PUBLIC`, which every role holds and no role can give back. Postgres's own catalogs are
 * left out; they are readable by every role on every database.
 */
export const readableWarnings = (role: string, served: readonly string[]): string => {
  const reader = str(role);
  const kept = `array_remove(ARRAY[${served.map((t) => `to_regclass(${str(t)})::oid`).join(", ")}]::oid[], NULL)`;
  return block(`DECLARE t record;
BEGIN
  FOR t IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND NOT c.oid = ANY (${kept})
      AND has_schema_privilege(${reader}, n.oid, 'USAGE') AND has_any_column_privilege(${reader}, c.oid, 'SELECT')
  LOOP
    RAISE WARNING 'syncmesh: the read role % can read %, which the manifest does not serve: a served read could read all of it', ${reader}, t.rel
      USING HINT = format('REVOKE SELECT ON %s FROM PUBLIC, then grant it to the roles that read it.', t.rel);
  END LOOP;
END`);
};

/** A served table's view in {@link SERVED}, by the table's manifest name. */
export const viewRelation = (name: string) => ({ schema: SERVED, name: `read:${name}` });

/** {@link viewRelation} as the quoted name SQL writes. */
export const viewName = (name: string) => {
  const view = viewRelation(name);
  return `${ident(view.schema)}.${ident(view.name)}`;
};

/**
 * A served table whose columns have field rules (E06, D40), as a view in {@link SERVED} that a
 * served read selects from: its rows are the ones the read rule admits, and each ruled column is
 * `NULL` where its rule refuses. The role may `SELECT` the view, and of the table itself only the
 * columns no rule hides, so a raw `sql` fragment that names the table cannot read a hidden one.
 *
 * `undefined` for a table with no field rule: a served read selects from the table itself.
 *
 * @example
 * servedView({ table: mail, fields: { subject: role("admin") } });
 * // { schema: "syncmesh_served", name: "read:mail" }
 */
export const servedView = (entry: {
  readonly table: { readonly name: string };
  readonly fields?: Readonly<Record<string, PolicyNode>>;
}): { readonly schema: string; readonly name: string } | undefined =>
  entry.fields !== undefined && Object.keys(entry.fields).length > 0
    ? viewRelation(entry.table.name)
    : undefined;

/**
 * The view {@link servedView} names, rebuilt from the table's columns as they are now, and the
 * role's grants moved onto it: `SELECT` on the view, and on the table only its unruled columns.
 */
export const viewDdl = (
  role: string,
  table: string,
  view: string,
  rule: string,
  hidden: Readonly<Record<string, string>>,
): string =>
  block(`DECLARE
  hidden jsonb := ${str(JSON.stringify(hidden))}::jsonb;
  shown text;
  open text;
BEGIN
  SELECT string_agg(CASE WHEN hidden ? a.attname THEN format('CASE WHEN %s THEN %I END AS %I', hidden ->> a.attname, a.attname, a.attname) ELSE format('%I', a.attname) END, ', ' ORDER BY a.attnum),
      string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum) FILTER (WHERE NOT hidden ? a.attname)
    INTO shown, open
    FROM pg_attribute a WHERE a.attrelid = ${str(table)}::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  DROP VIEW IF EXISTS ${view};
  EXECUTE format('CREATE VIEW %s WITH (security_barrier) AS SELECT %s FROM %s WHERE %s', ${str(view)}, shown, ${str(table)}, ${str(rule)});
  EXECUTE format('GRANT SELECT ON %s TO %I', ${str(view)}, ${str(role)});
  EXECUTE format('REVOKE SELECT ON %s FROM %I', ${str(table)}, ${str(role)});
  EXECUTE format('GRANT SELECT (%s) ON %s TO %I', open, ${str(table)}, ${str(role)});
END`);
