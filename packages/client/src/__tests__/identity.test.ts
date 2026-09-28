import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { describe, expect, test } from "bun:test";

import { deviceIdentity } from "../identity.js";

/**
 * The device key is the one thing a relay makes dangerous to get wrong. Two installs
 * under one `peerId` are one author with two sequence streams, and the failure is not an error —
 * it is a write folded, found to be below a cursor the other install already moved, and dropped.
 * So the two properties are tested directly: it survives a reboot, and it is never shared.
 */

const driverOn = (path: string) => bunSqliteDriver(path);

describe("deviceIdentity", () => {
  test("the same database is the same device, however many times it is opened", async () => {
    const path = `/tmp/issues-identity-${String(Date.now())}-${String(Math.random())}.db`;
    const first = (await deviceIdentity(driverOn(path))).unwrap();
    // a fresh driver over the same file, which is what a reload is
    const again = (await deviceIdentity(driverOn(path))).unwrap();
    expect(again.peerId).toBe(first.peerId);
    // and it can still sign, so what came back is a key and not just an id
    expect(again.sign(Uint8Array.of(1, 2, 3))).toEqual(first.sign(Uint8Array.of(1, 2, 3)));
  });

  test("a second database is a second device, which is what a second browser profile is", async () => {
    const stamp = `${String(Date.now())}-${String(Math.random())}`;
    const one = (await deviceIdentity(driverOn(`/tmp/issues-a-${stamp}.db`))).unwrap();
    const two = (await deviceIdentity(driverOn(`/tmp/issues-b-${stamp}.db`))).unwrap();
    expect(two.peerId).not.toBe(one.peerId);
  });

  test("a key the database cannot hold is a refusal, never a fresh key", async () => {
    // a device that minted a new key whenever it could not read the old one would author under a
    // new name on every reload, which is the crowd-of-strangers log the persistence exists to stop
    const driver = driverOn(":memory:");
    await driver.run(`CREATE TABLE "_device" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`);
    await driver.run(`INSERT INTO "_device" ("key", "value") VALUES ('seed', 'not-hex')`);
    const opened = await deviceIdentity(driver);
    expect(opened.isErr()).toBe(true);
    if (opened.isErr()) expect(opened.error._tag).toBe("DeviceKeyUnavailable");
  });
});
