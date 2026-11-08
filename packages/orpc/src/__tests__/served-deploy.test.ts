import type { Notice } from "postgres";

import { servedReadDdl } from "@syncmesh/storage";
import { Temporal } from "@syncmesh/temporal";
import { ReadRefused } from "@syncmesh/window";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";

import type { Router } from "../procedures.js";

import { query } from "../index.js";
import { servedReads } from "../served.js";
import {
  ALICE,
  MAIL_DDL,
  POSTGRES_URL,
  SERVER,
  mailTable,
  proceduresFor,
  runId,
  schemaFor,
} from "./served-fixtures.js";

const suite = POSTGRES_URL === undefined ? describe.skip : describe;

/** No wait at all: a refusal in these tests is the deployment's answer, not a deploy in flight. */
const NOW = Temporal.Duration.from({ seconds: 0 });

suite(
  "served reads deployed as a team deploys them: a migrator, an app, a reads login (D43)",
  () => {
    const id = runId();
    const database = `syncmesh_deploy_${id}`;
    /** Every role this run makes, as `name: password`; roles are the cluster's, so each is the run's own. */
    const roles = {
      migrator: `mig_${id}`,
      app: `app_${id}`,
      reads: `reads_${id}`,
      reader: `reader_${id}`,
      later: `later_${id}`,
      laterReads: `later_reads_${id}`,
    };
    const url = (user: string) => {
      const at = new URL(POSTGRES_URL ?? "postgres://localhost");
      at.username = user;
      at.password = `pw-${user}`;
      at.pathname = `/${database}`;
      return at.toString();
    };
    const notices: Notice[] = [];
    const connect = (user: string) =>
      postgres(url(user), {
        max: 2,
        onnotice: (notice) => {
          console.log(notice);
          notices.push(notice);
        },
      });

    const schema = schemaFor("mail", "open");
    const mail = mailTable("mail");
    let root: postgres.Sql;
    let migrator: postgres.Sql;
    let app: postgres.Sql;
    let reads: postgres.Sql;

    /** Why `pending` was rejected, or `undefined` when it was not. */
    const rejection = (pending: Promise<unknown>) =>
      pending.then(
        () => undefined,
        (cause) => (cause instanceof Error ? cause.message : "a rejection that is no Error"),
      );

    /** The DDL, as the migrator runs it in a migration. */
    const migrate = async (
      options: Parameters<typeof servedReadDdl>[1],
      manifest: Parameters<typeof servedReadDdl>[0] = schema,
    ) => {
      for (const statement of servedReadDdl(manifest, options)) await migrator.unsafe(statement);
    };

    /** Alice's inbox, served over `client`'s connection. */
    const inbox = (client: postgres.Sql, router: Router = proceduresFor(mail, mail)) =>
      servedReads({
        router,
        schema,
        db: drizzle({ client }),
        principal: ALICE,
        self: SERVER,
        onCommit: () => () => undefined,
        readRole: roles.reader,
        grace: NOW,
      }).readPage({ path: "mail.inbox", input: { folder: "inbox", limit: 10 } });

    beforeAll(async () => {
      root = postgres(POSTGRES_URL ?? "", { max: 1, onnotice: (notice) => console.log(notice) });
      for (const role of [roles.migrator, roles.app, roles.reads, roles.laterReads])
        await root.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD 'pw-${role}'`);
      await root.unsafe(`ALTER ROLE "${roles.migrator}" CREATEROLE`);
      await root.unsafe(`CREATE DATABASE "${database}" OWNER "${roles.migrator}"`);
      migrator = connect(roles.migrator);
      await migrator.unsafe(MAIL_DDL("mail"));
      await migrator.unsafe(MAIL_DDL("open"));
      await migrator.unsafe(
        `INSERT INTO mail VALUES ('a-1', 'alice', 'inbox', now(), 'for alice'), ('b-1', 'bob', 'inbox', now(), 'BOB SECRET')`,
      );
      await migrator.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON mail, open TO "${roles.app}"`);
      app = connect(roles.app);
      reads = connect(roles.reads);
    });

    afterAll(async () => {
      await Promise.all([migrator?.end(), app?.end(), reads?.end()]);
      await root.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      // the read roles first: the migrator granted them, and a grant depends on its grantor
      const { reader, later, reads: login, laterReads, app: owner, migrator: mig } = roles;
      for (const role of [reader, later, login, laterReads, owner, mig])
        await root.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      await root.end();
    });

    test("the migrator's DDL serves alice her mail over the reads login, and warns of nothing", async () => {
      notices.length = 0;
      await migrate({ role: roles.reader, grantTo: roles.reads });
      // a second run is the same deployment
      await migrate({ role: roles.reader, grantTo: roles.reads });
      expect(notices.filter((notice) => notice.severity !== "NOTICE")).toEqual([]);
      expect(notices.map((notice) => notice.message)).not.toContain(
        'no privileges were granted for "public"',
      );
      const page = await inbox(reads);
      expect(page.unwrap().rows.map((row) => row.key)).toEqual(["a-1"]);
    });

    test("the app's own reads and writes are as they were: row-level security is open to it", async () => {
      await app.unsafe(`INSERT INTO mail VALUES ('a-2', 'alice', 'inbox', now(), 'also alice')`);
      const all = await app.unsafe(`SELECT id FROM mail ORDER BY id`);
      expect(all.map((row) => row["id"])).toEqual(["a-1", "a-2", "b-1"]);
      await app.unsafe(`DELETE FROM mail WHERE id = 'a-2'`);
    });

    test("a policy open to every role does not widen what the read role reads", async () => {
      await migrator.unsafe(`CREATE POLICY wide_open ON mail FOR SELECT TO PUBLIC USING (TRUE)`);
      const page = await inbox(reads);
      expect(page.unwrap().rows.map((row) => row.key)).toEqual(["a-1"]);
      await migrator.unsafe(`DROP POLICY wide_open ON mail`);
    });

    test("served reads over the app's own connection are refused: it is no reads login", async () => {
      const page = await inbox(app);
      expect(page.isErr() && ReadRefused.is(page.error)).toBe(true);
      expect(page.isErr() && page.error.message).toBe(
        `syncmesh: served reads log in as ${roles.app}, which servedReadDdl did not give the read role ${roles.reader} (grantTo)`,
      );
    });

    test("the DDL refuses to make the app's login a reads login: a read could take its grants back", async () => {
      expect(await rejection(migrate({ role: roles.reader, grantTo: roles.app }))).toStartWith(
        `syncmesh: the login ${roles.app} owns or is granted mail, open`,
      );
      // the check is the grant's own statement, so the refusal took the grant back with it
      const [member] = await migrator.unsafe(`SELECT pg_has_role($1, $2, 'MEMBER') AS member`, [
        roles.app,
        roles.reader,
      ]);
      expect(member?.["member"]).toBe(false);
    });

    test("a table that is no longer served loses the read role's grant and policies", async () => {
      // `mail` gone from the manifest: as if it lost its rule, or its `sync: "window"`
      const without = {
        rolesFor: schema.rolesFor,
        entries: schema.entries.filter((entry) => entry.table.name !== "mail"),
      };
      await migrate({ role: roles.reader, grantTo: roles.reads }, without);
      const [granted] = await migrator.unsafe(
        `SELECT has_table_privilege($1, 'mail', 'SELECT') AS granted`,
        [roles.reader],
      );
      expect(granted?.["granted"]).toBe(false);
      const policies = await migrator.unsafe(
        `SELECT policyname FROM pg_policies WHERE tablename = 'mail' AND policyname LIKE 'syncmesh_served_r%'`,
      );
      expect(policies.length).toBe(0);
      const page = await inbox(reads);
      expect(page.isErr() && page.error.message).toStartWith("permission denied for table");
      await migrate({ role: roles.reader, grantTo: roles.reads });
      expect((await inbox(reads)).unwrap().rows.map((row) => row.key)).toEqual(["a-1"]);
    });

    test("a migrator who may not create roles is told so, and runs once the role is made for it", async () => {
      await root.unsafe(`ALTER ROLE "${roles.migrator}" NOCREATEROLE`);
      expect(await rejection(migrate({ role: roles.later, grantTo: roles.laterReads }))).toBe(
        `syncmesh: ${roles.migrator} may not create the read role ${roles.later}`,
      );
      // whoever holds CREATEROLE makes the role and grants it; the migration then says it exists
      await root.unsafe(`CREATE ROLE "${roles.later}" NOLOGIN`);
      await root.unsafe(`GRANT "${roles.later}" TO "${roles.laterReads}"`);
      await migrate({ role: roles.later, grantTo: roles.laterReads, createRole: false });
      const [member] = await migrator.unsafe(`SELECT pg_has_role($1, $2, 'MEMBER') AS member`, [
        roles.laterReads,
        roles.later,
      ]);
      expect(member?.["member"]).toBe(true);
    });

    test("the DDL warns of a SECURITY DEFINER function the read role can run, and the fix it names holds", async () => {
      await migrator.unsafe(
        `CREATE FUNCTION mail_count() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$ SELECT count(*) FROM mail $$`,
      );
      notices.length = 0;
      await migrate({ role: roles.reader, grantTo: roles.reads });
      const warned = notices.filter((notice) => notice.severity === "WARNING");
      expect(warned.map((notice) => notice.message)).toEqual([
        `syncmesh: the read role ${roles.reader} can run mail_count(), a SECURITY DEFINER function that runs as ${roles.migrator}`,
      ]);
      const counting = {
        mail: {
          inbox: query
            .input(z.object({ folder: z.string(), limit: z.number() }))
            .handler(({ db }) =>
              db
                .select({ id: mail.id, all: sql<string>`mail_count()::text` })
                .from(mail)
                .limit(1),
            ),
        },
      };
      // as warned: the function reads as its owner, past every policy
      const before = await inbox(reads, counting);
      expect(Object.fromEntries(before.unwrap().rows[0]?.row ?? [])["all"]).toBe("2");
      await migrator.unsafe(`REVOKE EXECUTE ON FUNCTION mail_count() FROM PUBLIC`);
      const after = await inbox(reads, counting);
      expect(after.isErr() && after.error.message).toBe(
        "permission denied for function mail_count",
      );
    });
  },
);
