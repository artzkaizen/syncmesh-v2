import type { Transport, TransportContext } from "@syncmesh/transport";

import { seed } from "@syncmesh/kernel/test-fixtures";
import { relayTransport, startRelay, webSocketDial } from "@syncmesh/relay";
import { authorityTables } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import {
  AUTHORITY,
  CONSULTS,
  onlyClinics,
  gatedSchema,
  idsIn,
  writeConsult,
} from "@syncmesh/transport/test-fixtures";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMesh } from "../mesh.js";

const PHONE = createIdentity(seed(41)).unwrap();

const meshFor = async (identity: typeof PHONE, transports: readonly Transport[]) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: gatedSchema,
      identity,
      authority: AUTHORITY.peerId,
      transports: [...transports],
    })
  ).unwrap();

const until = async (check: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 15));
  return check();
};

describe("mesh.visibility", () => {
  test("a mesh whose transports keep no ordered log answers NoSuchCapability, never a guess", async () => {
    const mesh = await meshFor(PHONE, []);
    const token = mesh.visibility.token();
    expect(token.isErr() && token.error._tag).toBe("NoSuchCapability");
    const waited = await mesh.visibility.visibleAt({ epoch: "e", offset: 1 });
    expect(waited.isErr() && waited.error._tag).toBe("NoSuchCapability");
    await mesh.stop();
  });

  test("the manifest's gated tables are handed to every transport as rows no direct link carries", async () => {
    let seen: TransportContext | undefined;
    const probe: Transport = {
      name: "probe",
      start: (context) => {
        seen = context;
        return Promise.resolve();
      },
      whenReady: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
    const mesh = await meshFor(PHONE, [probe]);
    expect([...(seen?.withheld?.tables ?? [])]).toEqual(["consults"]);
    expect(seen?.withheld?.author).toBe(AUTHORITY.peerId);
    await mesh.stop();
  });

  test("through startRelay's gate: the phone reads its clinic's rows and waits on the authority's token", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "syncmesh-visibility-"));
    const relay = await startRelay(0, {
      keepaliveMs: 60_000,
      blobs: false,
      dataDir,
      admission: {
        tables: authorityTables(gatedSchema),
        entitle: ({ peer }) =>
          peer === AUTHORITY.peerId
            ? { scope: "authority", admits: () => true }
            : { scope: "clinics:a", admits: (event) => onlyClinics(event, ["a"]) },
      },
    });
    const dial = () => relayTransport({ dial: webSocketDial(relay.url), reconnectMs: 20 });
    const authority = await meshFor(AUTHORITY, [dial()]);
    const phone = await meshFor(PHONE, [dial()]);
    await Promise.all([authority.settled(), phone.settled()]);

    (await writeConsult(authority, "x", "a")).unwrap();
    (await writeConsult(authority, "y", "b")).unwrap();
    expect(
      await until(() => (authority.visibility.token().unwrapOr(undefined)?.offset ?? 0) >= 2),
    ).toBe(true);
    const token = authority.visibility.token().unwrap();
    if (token === undefined) throw new Error("the authority holds no token after two acks");

    const reached = await phone.visibility.visibleAt(token);
    expect(reached.isOk()).toBe(true);
    expect(idsIn(phone, CONSULTS)).toEqual(["x"]);

    await phone.stop();
    await authority.stop();
    await relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
