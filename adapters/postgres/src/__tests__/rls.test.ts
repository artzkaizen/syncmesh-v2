import type { Principal, ValidatorSchema } from "@syncmesh/engine";

import { PGlite } from "@electric-sql/pglite";
import { policyContext } from "@syncmesh/engine";
import { parsePartitionKey } from "@syncmesh/kernel";
import { evaluate, resolveAllow } from "@syncmesh/policy";
import { installCapture, installRls, principalSettings } from "@syncmesh/storage";
import { JOBS } from "@syncmesh/storage/driver-tests";
import { LADDER, PRINCIPALS, ROWS, RULES, asCells } from "@syncmesh/storage/driver-tests";
import { describe, expect, test } from "bun:test";

import { pgliteDriver } from "../index.js";

const ACME = parsePartitionKey("org:acme").unwrap();

const schemaFor = (allow: (typeof RULES)[number][1] | undefined): ValidatorSchema => ({
  entries:
    allow === undefined
      ? [{ table: JOBS, partition: "org", visibility: "partition" }]
      : [{ table: JOBS, partition: "org", visibility: "partition", allow }],
  rolesFor: () => LADDER,
});

describe("RLS from the read rules — Postgres itself is the filter", () => {
  test("for every rule and principal, a plain SELECT under the policy returns exactly the rows evaluate() admits", async () => {
    const driver = pgliteDriver(new PGlite());
    (await installCapture(driver, [JOBS])).unwrap();
    for (const row of ROWS)
      await driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES ($1, $2, $3, $4)`, [
        row.id,
        row.title,
        row.rank,
        row.done,
      ]);
    // superusers are outside RLS by Postgres's own rules: the app reads through a plain role
    await driver.run(`CREATE ROLE syncmesh_app NOLOGIN`);
    await driver.run(`GRANT USAGE ON SCHEMA public TO syncmesh_app`);
    await driver.run(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO syncmesh_app`);

    const visible = async (principal: Principal): Promise<readonly string[]> => {
      let ids: readonly string[] = [];
      // SAFETY: the pglite driver always offers transaction
      await (driver.transaction as NonNullable<typeof driver.transaction>)(async () => {
        for (const { sql, params } of principalSettings(principal)) await driver.run(sql, params);
        ids = (await driver.all(`SELECT id FROM jobs ORDER BY id`)).map((r) => String(r[0]));
      });
      return ids;
    };

    for (const [ruleName, block] of RULES) {
      await driver.run(`RESET ROLE`);
      (await installRls(driver, schemaFor(block))).unwrap();
      await driver.run(`SET ROLE syncmesh_app`);
      for (const [who, principal] of PRINCIPALS) {
        const expected = ROWS.filter((row) =>
          evaluate(
            resolveAllow(block, "read"),
            policyContext(principal, LADDER, asCells(row), undefined),
          ),
        ).map((row) => row.id);
        expect(await visible(principal), `${ruleName} / ${who}`).toEqual(expected);
      }
    }
    await driver.run(`RESET ROLE`);
  });

  test("no rules leaves the table open; the partition setting pins reads; nothing survives the transaction", async () => {
    const driver = pgliteDriver(new PGlite());
    (await installCapture(driver, [JOBS])).unwrap();
    await driver.run(
      `INSERT INTO jobs (id, title, rank, done, "_partition") VALUES ('a', 't', 1, false, 'org:acme')`,
    );
    await driver.run(
      `INSERT INTO jobs (id, title, rank, done, "_partition") VALUES ('b', 't', 2, false, 'org:globex')`,
    );
    (await installRls(driver, schemaFor(undefined))).unwrap();
    await driver.run(`CREATE ROLE syncmesh_app NOLOGIN`);
    await driver.run(`GRANT USAGE ON SCHEMA public TO syncmesh_app`);
    await driver.run(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO syncmesh_app`);
    await driver.run(`SET ROLE syncmesh_app`);

    const principal: Principal = { account: "anyone", claims: {} };
    let pinned: readonly string[] = [];
    // SAFETY: the pglite driver always offers transaction
    await (driver.transaction as NonNullable<typeof driver.transaction>)(async () => {
      for (const { sql, params } of principalSettings(principal, { partition: ACME }))
        await driver.run(sql, params);
      pinned = (await driver.all(`SELECT id FROM jobs ORDER BY id`)).map((r) => String(r[0]));
    });
    expect(pinned).toEqual(["a"]); // the pin held inside the transaction
    const after = (await driver.all(`SELECT id FROM jobs ORDER BY id`)).map((r) => String(r[0]));
    expect(after).toEqual(["a", "b"]); // and died with it: no pin, no principal, table open
    await driver.run(`RESET ROLE`);
  });
});
