import { parsePartitionKey } from "@syncmesh/kernel";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteDriver } from "../driver.js";
import type { StoreScope } from "../open-stores.js";

import { A, B, event } from "../driver-tests/fixtures.js";
import { scopedStores, storeNameFor } from "../open-stores.js";
import { storeFilesFor } from "../open-stores.js";
import { openPair } from "./pair.js";

const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();

const dir = mkdtempSync(join(tmpdir(), "syncmesh-scopes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// one pair per scope: the log at `path`, with its state file hanging off it
const driver = (logPath: string): Promise<SqliteDriver> => openPair(logPath);

const pathFor = (scope: StoreScope) => join(dir, `${storeNameFor(scope)}.db`);
const set = scopedStores({ driverFor: (scope) => driver(pathFor(scope)) });
const storesFor = async (scope: StoreScope) => (await set.storeFor(scope)).unwrap();

describe("a scope names one database", () => {
  test("kind and id, never a colon — and no two scopes can name the same file", () => {
    expect(storeNameFor("user")).toBe("user");
    expect(storeNameFor(ACME)).toBe("org-acme");
    // the id is escaped and the kind cannot hold a `-`, so the first one is always the seam:
    // `org:a-b` and a kind `org_a` with id `b` are different names, not the same file
    expect(storeNameFor(parsePartitionKey("org:a-b").unwrap())).toBe("org-a-b");
    expect(storeNameFor(parsePartitionKey("org_a:b").unwrap())).toBe("org_a-b");
    expect(storeNameFor(parsePartitionKey("org:a/b").unwrap())).toBe("org-a%2Fb");
  });
});

describe("one engine's storage per scope", () => {
  test("logs never mix, and asking twice opens one connection", async () => {
    const acme = await storesFor(ACME);
    expect(await storesFor(ACME)).toBe(acme);
    const globex = await storesFor(GLOBEX);
    (await acme.events.append({ event: event(A, 1, 100, { partition: ACME }) })).unwrap();
    (await globex.events.append({ event: event(B, 1, 100, { partition: GLOBEX }) })).unwrap();

    // there is no query that spans two scopes, because there is no connection that holds both
    expect((await acme.events.all()).unwrap().map((e) => e.event.peerId)).toEqual([A]);
    expect((await globex.events.all()).unwrap().map((e) => e.event.peerId)).toEqual([B]);
    expect(set.opened()).toEqual([ACME, GLOBEX]);
  });

  test("leaving an org drops one store and nothing else", async () => {
    await storesFor(ACME);
    await storesFor(GLOBEX);
    await set.forget(ACME);
    // both files, because a store is two now and the log is the half that holds the events —
    // deleting only the first leaves every one of them to be found again on the next join
    for (const file of storeFilesFor(pathFor(ACME), "test")) unlinkSync(file);

    expect(set.opened()).toEqual([GLOBEX]);
    expect(existsSync(pathFor(ACME))).toBe(false);
    expect(existsSync(pathFor(GLOBEX))).toBe(true);
    const globex = await storesFor(GLOBEX);
    expect((await globex.events.all()).unwrap().map((e) => e.event.peerId)).toEqual([B]);

    // and re-joining opens a fresh, empty one under the same name
    const rejoined = await storesFor(ACME);
    expect((await rejoined.events.all()).unwrap()).toHaveLength(0);
    await set.close();
    expect(set.opened()).toEqual([]);
  });
});
