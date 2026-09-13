import type { PeerId } from "@syncmesh/kernel";
import type { Transport } from "@syncmesh/transport";

import { seed } from "@syncmesh/kernel/test-fixtures";
import { defineSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createFrameTransport, loopbackPair } from "@syncmesh/transport";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { createMesh } from "../mesh.js";

const schema = () =>
  defineSchema({
    tables: { notes: { columns: { id: t.text().primaryKey(), body: t.text() } } },
  });
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

/** Counts its own opens, because "it came back" is the claim a release has to make. */
const radio = (name: string, opens: { count: number }, reaches?: () => ReadonlySet<PeerId>) => {
  const { a } = loopbackPair();
  const transport = createFrameTransport({
    name,
    kind: "ble",
    open: (_ctx, attach) => {
      opens.count += 1;
      attach(a);
    },
  });
  if (reaches === undefined) return transport;
  return { ...transport, reaches } satisfies Transport;
};

const device = async (transports: readonly Transport[]) =>
  (
    await createMesh({
      driver: bunSqliteDriver(":memory:"),
      schema: schema(),
      identity: createIdentity(seed(11)).unwrap(),
      now: () => T0,
      transports,
    })
  ).unwrap();

describe("forcing a medium into a condition a laptop cannot produce (book ch. 18)", () => {
  test("a held medium keeps its name and its seat, and says what it was told to say", async () => {
    const opens = { count: 0 };
    const mesh = await device([radio("nearby", opens)]);
    await mesh.ready();
    expect(mesh.status.get().sources.get("nearby")?.condition).toBe("ok");

    (await mesh.transports.force("nearby", "radio-off")).unwrap();

    // the medium is still there — a row that vanished would be a device running no radio at all,
    // which is a different fact from a radio that is switched off
    const sources = mesh.status.get().sources;
    expect([...sources.keys()]).toEqual(["nearby"]);
    expect(sources.get("nearby")).toEqual({ kind: "ble", condition: "radio-off" });
    // nothing carries, so the app's own health readout goes offline without knowing why
    expect(mesh.status.get().health).toBe("offline");
    await mesh.stop();
  });

  test("`forced` is what separates a radio that is off from a radio somebody turned off", async () => {
    const opens = { count: 0 };
    const mesh = await device([radio("nearby", opens)]);
    await mesh.ready();
    expect(mesh.transports.forced()).toEqual([]);

    (await mesh.transports.force("nearby", "radio-off")).unwrap();
    expect(mesh.transports.forced()).toEqual([{ name: "nearby", as: "radio-off" }]);

    (await mesh.transports.release("nearby")).unwrap();
    expect(mesh.transports.forced()).toEqual([]);
    await mesh.stop();
  });

  test("releasing starts the medium the app configured, not a copy of it", async () => {
    const opens = { count: 0 };
    const mesh = await device([radio("nearby", opens)]);
    await mesh.ready();
    expect(opens.count).toBe(1);

    (await mesh.transports.force("nearby", "discovery-failed")).unwrap();
    expect(opens.count).toBe(1); // a stand-in opens nothing

    (await mesh.transports.release("nearby")).unwrap();
    expect(opens.count).toBe(2); // the same instance, through the same `start` an `add` runs
    expect(mesh.status.get().sources.get("nearby")?.condition).toBe("ok");
    await mesh.stop();
  });

  test("forcing again changes the condition rather than stacking a second stand-in", async () => {
    const opens = { count: 0 };
    const mesh = await device([radio("nearby", opens)]);
    await mesh.ready();

    (await mesh.transports.force("nearby", "radio-off")).unwrap();
    (await mesh.transports.force("nearby", "no-permission-central")).unwrap();

    expect(mesh.transports.list().map((held) => held.name)).toEqual(["nearby"]);
    expect(mesh.transports.forced()).toEqual([{ name: "nearby", as: "no-permission-central" }]);
    await mesh.stop();
  });

  test("a held medium keeps its position, so attach order survives the round trip", async () => {
    const opens = { count: 0 };
    const mesh = await device([radio("first", opens), radio("second", opens)]);
    await mesh.ready();

    (await mesh.transports.force("first", "radio-off")).unwrap();
    expect(mesh.transports.list().map((held) => held.name)).toEqual(["first", "second"]);

    (await mesh.transports.release("first")).unwrap();
    expect(mesh.transports.list().map((held) => held.name)).toEqual(["first", "second"]);
    await mesh.stop();
  });

  test("the stand-in copies the capability shape: it enumerates nobody, or still cannot say", async () => {
    const opens = { count: 0 };
    const naming = radio("naming", opens, () => new Set<PeerId>());
    const mesh = await device([naming, radio("silent", opens)]);
    await mesh.ready();

    (await mesh.transports.force("naming", "radio-off")).unwrap();
    (await mesh.transports.force("silent", "radio-off")).unwrap();

    const [held, mute] = mesh.transports.list();
    // a radio that is off reaches nobody; one that never could name its links still cannot, and
    // reporting that as zero peers would invent a claim the medium never made
    expect(held?.reaches?.()?.size).toBe(0);
    expect(mute?.reaches).toBeUndefined();
    await mesh.stop();
  });

  test("a name nobody is running, and a name nobody is holding, are refusals and not throws", async () => {
    const opens = { count: 0 };
    const mesh = await device([radio("nearby", opens)]);
    await mesh.ready();

    const missing = await mesh.transports.force("nowhere", "radio-off");
    expect(missing.isErr() && missing.error._tag).toBe("NoSuchTransport");

    const loose = await mesh.transports.release("nearby");
    expect(loose.isErr() && loose.error._tag).toBe("NoSuchTransport");
    await mesh.stop();
  });

  test("removing a held medium takes the instance behind it with the name", async () => {
    const opens = { count: 0 };
    const mesh = await device([radio("nearby", opens)]);
    await mesh.ready();
    (await mesh.transports.force("nearby", "radio-off")).unwrap();

    expect(await mesh.transports.remove("nearby")).toBe(true);
    expect(mesh.transports.forced()).toEqual([]);
    expect(mesh.transports.list()).toEqual([]);
    await mesh.stop();
  });
});
