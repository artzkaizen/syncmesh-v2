import type { Principal, SuiteCase } from "@syncmesh/engine";
import type { CellValue, ColumnName } from "@syncmesh/kernel";
import type { AllowBlock, RoleSet } from "@syncmesh/policy";

import { equal, policyContext } from "@syncmesh/engine";
import {
  all,
  allow,
  any,
  claimEquals,
  claimHas,
  claimIncludes,
  deny,
  evaluate,
  not,
  owner,
  patchOnly,
  resolveAllow,
  role,
  rowIs,
} from "@syncmesh/policy";

import type { SqlDriver } from "../driver.js";
import type { OpenDriver } from "./index.js";

import { installCapture } from "../capture.js";
import { compileRead } from "../read-filter.js";
import { JOBS } from "./fixtures.js";

export const LADDER: RoleSet = { names: ["owner", "dispatcher", "tech", "viewer"], ordered: true };
const col = JOBS.columnNames;

/** Rows as the app inserted them; `title` doubles as the owner column, `rank` as a site id. */
export const ROWS = [
  { id: "a", title: "acct_one", rank: 1, done: false },
  { id: "b", title: "acct_one", rank: 2, done: true },
  { id: "c", title: "acct_two", rank: 3, done: false },
  { id: "d", title: "nobody", rank: 2, done: false },
] as const;

export const asCells = (row: (typeof ROWS)[number]): ReadonlyMap<ColumnName, CellValue> =>
  new Map<ColumnName, CellValue>([
    [col.id, row.id],
    [col.title, row.title],
    [col.rank, row.rank],
    [col.done, row.done],
  ]);

export const PRINCIPALS: readonly (readonly [string, Principal])[] = [
  ["dispatcher", { account: "acct_d", role: "dispatcher", claims: {} }],
  ["one, a tech", { account: "acct_one", role: "tech", claims: { sites: [2, 3], tier: "gold" } }],
  [
    "two, a viewer",
    { account: "acct_two", role: "viewer", claims: { sites: [], modules: ["jobs"] } },
  ],
  ["no role", { account: "acct_x", claims: { tier: "acct_one" } }],
];

export const RULES: readonly (readonly [string, AllowBlock])[] = [
  ["deny all", { $default: deny }],
  ["allow all", { $default: allow }],
  ["a role", { $default: deny, read: role("tech") }],
  ["owner of open rows", { $default: deny, read: all(owner("title"), not(rowIs({ done: true }))) }],
  [
    "dispatchers, or your own, or your sites",
    {
      $default: deny,
      read: any(role("dispatcher"), owner("title"), claimHas("sites", "rank")),
    },
  ],
  ["a claim equal to a column", { $default: deny, read: claimEquals("tier", "title") }],
  ["a module claim", { $default: deny, read: claimIncludes("modules", "jobs") }],
  ["rowIs on a boolean and a number", { $default: deny, read: rowIs({ done: false, rank: 2 }) }],
  ["patchOnly reads as allowed", { $default: deny, read: patchOnly(["title"]) }],
  ["empty any and all", { $default: deny, read: any(all(), any()) }],
  ["a column the table lacks", { $default: allow, read: owner("nope") }],
];

const seed = async (driver: SqlDriver) => {
  (await installCapture(driver, [JOBS])).unwrap();
  for (const row of ROWS)
    await driver.run(`INSERT INTO jobs (id, title, rank, done) VALUES (?, ?, ?, ?)`, [
      row.id,
      row.title,
      row.rank,
      row.done ? 1 : 0,
    ]);
};

export const readFilterCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "read filter: for every rule and principal, the compiled WHERE admits exactly the rows evaluate() admits",
    run: async () => {
      const driver = await openDriver("read-filter");
      await seed(driver);
      for (const [ruleName, block] of RULES) {
        for (const [who, principal] of PRINCIPALS) {
          const expected = ROWS.filter((row) =>
            evaluate(
              resolveAllow(block, "read"),
              policyContext(principal, LADDER, asCells(row), undefined),
            ),
          ).map((row) => row.id);
          const { sql, params } = compileRead(JOBS, LADDER, block, principal);
          const got = (
            await driver.all(`SELECT id FROM jobs WHERE (${sql}) ORDER BY id`, params)
          ).map((r) => String(r[0]));
          equal(got, expected, `${ruleName} / ${who}`);
        }
      }
    },
  },
  {
    name: "read filter: a table with no rules is open to anyone who holds it",
    run: async () => {
      const driver = await openDriver("read-filter-open");
      await seed(driver);
      const { sql, params } = compileRead(JOBS, LADDER, undefined, { account: "x", claims: {} });
      equal(
        Number((await driver.all(`SELECT COUNT(*) FROM jobs WHERE (${sql})`, params))[0]?.[0]),
        4,
        "all rows",
      );
    },
  },
];
