import { rlsDdl, servedReadDdl } from "@syncmesh/storage";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { servedReads } from "../served.js";
import {
  ALICE,
  MAIL_DDL,
  POSTGRES_URL,
  SERVER,
  dropRoles,
  mailTable,
  proceduresFor,
  rolesFor,
  runId,
  schemaFor,
  urlAs,
} from "./served-fixtures.js";

const suite = POSTGRES_URL === undefined ? describe.skip : describe;

/** Which DDL a deployment ran first: `createMesh({ rls: true })` installs the app's at boot. */
const ORDERS = ["served reads first, the app's RLS at boot", "the app's RLS first"] as const;

for (const order of ORDERS)
  suite(`the app's read rule and served reads in one table, ${order} (D43)`, () => {
    const id = runId();
    const names = { mail: `mail_${id}`, open: `open_${id}`, app: `app_${id}` };
    const roles = rolesFor(id);
    const schema = schemaFor(names.mail, names.open);
    const mail = mailTable(names.mail);
    let pg: postgres.Sql;
    let reads: postgres.Sql;

    const served = () => servedReadDdl(schema, { role: roles.reader, grantTo: roles.login });
    const appRls = () =>
      schema.entries.flatMap((entry) =>
        rlsDdl(entry.table, schema.rolesFor(entry.partition), entry.allow, {
          partitionColumn: false,
        }),
      );

    beforeAll(async () => {
      pg = postgres(POSTGRES_URL ?? "", { max: 1, onnotice: (notice) => console.log(notice) });
      await pg.unsafe(`CREATE ROLE "${roles.login}" LOGIN PASSWORD '${roles.password}'`);
      await pg.unsafe(`CREATE ROLE "${names.app}" NOLOGIN`);
      await pg.unsafe(MAIL_DDL(names.mail));
      await pg.unsafe(MAIL_DDL(names.open));
      await pg.unsafe(
        `INSERT INTO ${names.mail} VALUES ('a-1', 'alice', 'inbox', now(), 'for alice'), ('b-1', 'bob', 'inbox', now(), 'BOB SECRET')`,
      );
      await pg.unsafe(`GRANT SELECT ON ${names.mail} TO "${names.app}"`);
      const steps = order === ORDERS[0] ? [served, appRls] : [appRls, served];
      for (const step of steps) for (const statement of step()) await pg.unsafe(statement);
      reads = postgres(urlAs(roles.login, roles.password), {
        max: 1,
        onnotice: (notice) => console.log(notice),
      });
    });

    afterAll(async () => {
      await reads?.end();
      await pg.unsafe(`DROP TABLE IF EXISTS ${names.mail}, ${names.open}`);
      await pg.unsafe(`DROP ROLE IF EXISTS "${names.app}"`);
      await dropRoles(pg, roles);
      await pg.end();
    });

    test("the app's role, as alice, reads alice's mail and not bob's", async () => {
      const seen = await pg.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE "${names.app}"`);
        // the app's own settings, as `principalSettings` names them
        await tx.unsafe(
          `SELECT set_config('syncmesh.account', $1, TRUE), set_config('syncmesh.role', $2, TRUE)`,
          [ALICE.account, ALICE.role],
        );
        return tx.unsafe(`SELECT id FROM ${names.mail} ORDER BY id`);
      });
      expect(seen.map((row) => row["id"])).toEqual(["a-1"]);
    });

    test("a served read, as alice, reads alice's mail and not bob's", async () => {
      const page = await servedReads({
        router: proceduresFor(mail, mailTable(names.open)),
        schema,
        db: drizzle({ client: reads }),
        principal: ALICE,
        self: SERVER,
        onCommit: () => () => undefined,
        readRole: roles.reader,
      }).readPage({ path: "mail.inbox", input: { folder: "inbox", limit: 10 } });
      expect(page.unwrap().rows.map((row) => row.key)).toEqual(["a-1"]);
    });
  });
