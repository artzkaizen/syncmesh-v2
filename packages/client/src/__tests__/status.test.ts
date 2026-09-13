import { seed } from "@syncmesh/kernel/test-fixtures";
import { syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createFrameTransport, loopbackPair, type TransportCondition } from "@syncmesh/transport";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  syncSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
  });
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/** A medium that can tell the truth about its own radio, the way a native BLE adapter does. */
const radio = (name: string, says: () => TransportCondition) => {
  const { a } = loopbackPair();
  return createFrameTransport({
    name,
    kind: "ble",
    condition: says,
    open: (_ctx, attach) => void attach(a),
  });
};

const device = async (transports?: Parameters<typeof createMesh>[0]["transports"]) => {
  const options = {
    driver: bunSqliteDriver(":memory:"),
    schema: schema(),
    identity: createIdentity(seed(7)).unwrap(),
    now: () => T0,
  };
  if (transports !== undefined) Object.assign(options, { transports });
  return (await createMesh(options)).unwrap();
};

describe("status — diagnosis, not a boolean (book ch. 18)", () => {
  test("a device with no medium at all is offline, and says so per source by saying nothing", async () => {
    const mesh = await device();
    const status = mesh.status.get();
    expect(status.sources.size).toBe(0);
    expect(status.health).toBe("offline"); // nothing carries, so nothing can be caught up
    await mesh.stop();
  });

  test("a medium that names its own trouble is believed, and the mesh reads offline behind it", async () => {
    let says: TransportCondition = "radio-off";
    const mesh = await device([radio("nearby", () => says)]);
    await mesh.ready();

    const off = mesh.status.get();
    expect(off.sources.get("nearby")).toEqual({ kind: "ble", condition: "radio-off" });
    // a UI can now say "Bluetooth is off" instead of drawing a red dot
    expect(off.health).toBe("offline");

    says = "ok";
    expect(mesh.status.get().sources.get("nearby")?.condition).toBe("ok");
    expect(mesh.status.get().health).not.toBe("offline");
    await mesh.stop();
  });

  test("a medium added at runtime joins the diagnosis; removing it takes it out", async () => {
    const mesh = await device([radio("nearby", () => "ok")]);
    await mesh.ready();
    expect([...mesh.status.get().sources.keys()]).toEqual(["nearby"]);

    (await mesh.transports.add(radio("no-permission", () => "no-permission-central"))).unwrap();
    const both = mesh.status.get().sources;
    expect([...both.keys()]).toEqual(["nearby", "no-permission"]);
    // central and peripheral are separate words because the platforms separate the permissions
    expect(both.get("no-permission")?.condition).toBe("no-permission-central");

    expect(await mesh.transports.remove("nearby")).toBe(true);
    expect([...mesh.status.get().sources.keys()]).toEqual(["no-permission"]);
    expect(mesh.status.get().health).toBe("offline"); // the only medium left cannot carry
    await mesh.stop();
  });
});
