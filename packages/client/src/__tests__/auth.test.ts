import type { Principal } from "@syncmesh/engine";

import { seed } from "@syncmesh/kernel/test-fixtures";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  syncSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
  });
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const nurse: Principal = { account: "acct_ann", role: "member", claims: {} };

const open = async (auth?: Parameters<typeof createMesh>[0]["auth"], now = () => T0) => {
  const options = {
    driver: bunSqliteDriver(":memory:"),
    schema: schema(),
    identity: createIdentity(seed(7)).unwrap(),
    now,
  };
  if (auth !== undefined) Object.assign(options, { auth });
  return (await createMesh(options)).unwrap();
};

describe("the session — who the user is (book ch. 14)", () => {
  test("no provider means no caller: the device acts as nobody in particular", async () => {
    const mesh = await open();
    expect(mesh.auth.status()).toEqual({ principal: null, expiresAt: null });
    expect(mesh.auth.principal()).toBeUndefined();
    await mesh.stop();
  });

  test("the provider is asked once at construction, and its answer is the status", async () => {
    const asks: string[] = [];
    const mesh = await open((ask) => {
      asks.push(ask.reason);
      return { principal: nurse, expiresAt: T0.add({ hours: 1 }) };
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(asks).toEqual(["initial"]);
    const status = mesh.auth.status();
    expect(status.principal).toEqual(nurse);
    // one source of truth for both the session logic and the "expires in 4 min" a screen renders
    expect(status.expiresAt?.epochMilliseconds).toBe(T0.add({ hours: 1 }).epochMilliseconds);
    await mesh.stop();
  });

  test("an expired credential is not a caller, however the status still reports it", async () => {
    let clock = T0;
    const mesh = await open(
      () => ({ principal: nurse, expiresAt: T0.add({ minutes: 5 }) }),
      () => clock,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(mesh.auth.principal()).toEqual(nurse);

    clock = T0.add({ hours: 1 });
    // the rules would otherwise read a role nobody holds any more
    expect(mesh.auth.principal()).toBeUndefined();
    expect(mesh.auth.status().principal).toEqual(nurse); // the screen still says whose it was
    await mesh.stop();
  });

  test("signOut stops sync, then purges, then drops — in that order", async () => {
    const order: string[] = [];
    const mesh = await open(() => ({ principal: nurse, expiresAt: null }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    mesh.auth.subscribe(() => order.push("changed"));
    await mesh.auth.signOut({
      then: () => {
        // the purge runs while the credential is still in hand and nothing is syncing
        order.push(mesh.auth.principal() === undefined ? "dropped-too-early" : "purge");
      },
    });
    expect(order).toEqual(["purge", "changed"]);
    expect(mesh.auth.status()).toEqual({ principal: null, expiresAt: null });
    await mesh.stop();
  });
});
