import type { Engine } from "@syncmesh/engine";
import type { RowKey } from "@syncmesh/kernel";

import { describe, expect, test } from "bun:test";

import type { ManualChangeSource } from "../manual.js";

import { startCapture } from "../capture.js";
import { manualChangeSource } from "../manual.js";
import {
  ACME,
  FLAGGED,
  OWNED,
  TASKS,
  WRITE,
  authority,
  failure,
  forgerAt,
  mappings,
  peerAt,
  phone,
  schema,
  until,
} from "./fixtures.js";

// SAFETY: test fixture; a row key is the text of the row's own primary-key cell
const key = (value: string) => value as RowKey;

const taskRow = (id: string) =>
  new Map([
    [schema.tables.tasks.columnNames.id, id],
    [schema.tables.tasks.columnNames.orgId, "acme"],
    [schema.tables.tasks.columnNames.title, "typed by hand"],
    [schema.tables.tasks.columnNames.ownerId, "acct_alice"],
  ]);

const capture = async (engine: Engine, source: ManualChangeSource) =>
  (await startCapture({ engine, source, mappings })).unwrap();

/**
 * Direction is fixed, and a rule is what fixes it: the device's own validator refuses the write
 * before it can become an event, and the authority refuses the same write again if a device
 * with no validator forges one. Same rule, both ends — which is what makes "read-only on
 * devices" a property of the mesh rather than a convention of the app.
 */
describe("a device write to a CDC-backed collection", () => {
  test("is denied locally and quarantined remotely", async () => {
    const device = peerAt(phone);
    const refused = await device.mutate(WRITE, (tx) => tx.insert(TASKS, key("t1"), taskRow("t1")), {
      partition: ACME,
    });
    expect(refused.isErr() && refused.error._tag).toBe("PolicyDenied");
    expect(device.state().has(TASKS)).toBe(false);

    // the same write, authored by an engine that checks nothing, still fails at the authority
    const forged = forgerAt(phone);
    const event = (
      await forged.mutate(WRITE, (tx) => tx.insert(TASKS, key("t1"), taskRow("t1")), {
        partition: ACME,
      })
    ).unwrap();

    const server = peerAt(authority);
    const quarantined: string[] = [];
    server.onQuarantine(({ reason }) => void quarantined.push(reason._tag));
    expect((await server.receive({ event })).unwrap()).toMatchObject({
      folded: 0,
      quarantined: 1,
    });
    expect(quarantined).toEqual(["PolicyDenied"]);
    expect(server.state().has(TASKS)).toBe(false);
  });

  test("the authority's own projection is admitted by the same rule", async () => {
    const engine = peerAt(authority);
    const source = manualChangeSource({ name: "app" });
    const running = await capture(engine, source);
    source.commit((tx) =>
      tx.insert("tasks", { id: "t1", orgId: "acme", title: "from the database", ownerId: "u1" }),
    );
    await until(() => source.pending() === 0, "the projection");
    running.stop();
    await running.done;
    expect(engine.rowsIn(TASKS, ACME).size).toBe(1);
  });
});

/**
 * The authority signs everything CDC produces, so a rule
 * that reads the *author* is answering a question about the authority. `owner()` therefore
 * denies the real owner; a rule that reads the **column** does not.
 */
describe("ownership on a CDC-backed collection", () => {
  test("owner() refuses the projection, because it is asking about the authority", async () => {
    const engine = peerAt(authority);
    const source = manualChangeSource({ name: "app" });
    const running = await capture(engine, source);

    // ownerId is the person's account, and the authority's is `acct_system`
    source.commit((tx) => tx.insert("owned", { id: "o1", orgId: "acme", ownerId: "acct_alice" }));
    const stopped = failure(await running.done);

    expect(stopped._tag).toBe("EventRefused");
    expect(stopped._tag === "EventRefused" && stopped.cause._tag).toBe("PolicyDenied");
    expect(engine.state().has(OWNED)).toBe(false);
  });

  test("rowIs admits it, because it is asking about the row", async () => {
    const engine = peerAt(authority);
    const source = manualChangeSource({ name: "app" });
    const running = await capture(engine, source);

    source.commit((tx) => tx.insert("flagged", { id: "f1", orgId: "acme", ownerId: "acct_alice" }));
    await until(() => source.pending() === 0, "the projection");
    running.stop();
    await running.done;

    expect(engine.rowsIn(FLAGGED, ACME).size).toBe(1);
  });
});
