import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { Topology } from "./convergence-harness.js";

import { digests, mesh, noLoss } from "./convergence-harness.js";
import { key, table } from "./fixtures.js";

/**
 * The whole system's one promise, checked rather than argued: **after every device has talked to
 * every device it can reach, no write is missing except one a later write to the same cell
 * replaced.**
 *
 * Everything else in this file is a way of making that hard to satisfy by accident — four
 * topologies, several schema shapes, repeated partitions, and a property test over random
 * schedules. The oracle is derived from the writes, so none of it can be quietly wrong in the
 * same direction as the code.
 */

const EVERY: readonly Topology[] = ["pair", "line", "triangle", "star"];

/** A single person's devices; a tenant's rows; a catalogue everyone holds; an append-only log. */
const NOTE = table("note");
const PATIENT = table("patient");
const CATALOG = table("catalog");
const ENTRY = table("entry");

const settled = async (m: Awaited<ReturnType<typeof mesh>>) => {
  await m.heal();
  for (const check of noLoss(m))
    expect(`${check.where} ${check.actual}`).toBe(`${check.where} ${check.expected}`);
  const [first, ...rest] = digests(m);
  for (const d of rest) expect(d).toEqual(first ?? []);
};

for (const topology of EVERY)
  describe(topology, () => {
    const size = topology === "pair" ? 2 : 4;
    const names = Array.from({ length: size }, (_, i) => String.fromCharCode(97 + i));

    test("one person, several devices: concurrent edits to different fields all survive", async () => {
      const m = mesh(topology, size);
      await m.write("a", 100, NOTE, key("n1"), { title: "draft" });
      await m.heal();

      m.apart();
      for (const [i, who] of names.entries())
        await m.write(who, 200 + i * 10, NOTE, key("n1"), { [`field_${who}`]: `by ${who}` });
      await settled(m);
    });

    test("the same field from every device: the latest stamp wins, everywhere", async () => {
      const m = mesh(topology, size);
      m.apart();
      for (const [i, who] of names.entries())
        await m.write(who, 500 - i * 10, NOTE, key("n1"), { title: `by ${who}` });
      await settled(m);
    });

    test("a tenant's rows: one row per device, none of them collide", async () => {
      const m = mesh(topology, size);
      m.apart();
      for (const [i, who] of names.entries())
        await m.write(who, 300 + i, PATIENT, key(`p:${who}`), { name: `patient of ${who}` });
      await settled(m);
    });

    test("an append-only log: every entry from every device is kept", async () => {
      const m = mesh(topology, size);
      m.apart();
      for (const who of names)
        for (let n = 0; n < 5; n += 1)
          await m.write(who, 1000 + n, ENTRY, key(`${who}:${n}`), { by: who, text: `entry ${n}` });
      await settled(m);
      for (const device of m.devices)
        expect(device.engine.state().get(ENTRY)?.size).toBe(names.length * 5);
    });

    test("a catalogue written by one device reaches every device", async () => {
      const m = mesh(topology, size);
      m.apart();
      for (let n = 0; n < 8; n += 1)
        await m.write("a", 700 + n, CATALOG, key(`code:${n}`), { code: `C${n}` });
      await settled(m);
      for (const device of m.devices) expect(device.engine.state().get(CATALOG)?.size).toBe(8);
    });

    test("apart and back four times over: a quiet device keeps receiving", async () => {
      // the shape that hid a wedged link for as long as it existed — a device with nothing of its
      // own to say must not stop hearing the devices that do
      const m = mesh(topology, size);
      await m.write("a", 100, NOTE, key("n1"), { title: "first" });
      await m.heal();
      for (const round of [1, 2, 3, 4]) {
        m.apart();
        await m.write("b", 100 + round * 100, NOTE, key("n1"), { title: `round ${round}` });
        await settled(m);
      }
    });

    test("a delete that crossed an update: the later of the two decides, identically", async () => {
      const m = mesh(topology, size);
      await m.write("a", 100, PATIENT, key("p1"), { name: "R. Okafor" });
      await m.heal();
      m.apart();
      await m.remove("a", 200, PATIENT, key("p1"));
      await m.write("b", 300, PATIENT, key("p1"), { allergies: "penicillin" });
      await settled(m);
    });

    test("a delete after the last update removes the row on every device", async () => {
      const m = mesh(topology, size);
      await m.write("a", 100, PATIENT, key("p1"), { name: "R. Okafor" });
      await m.heal();
      m.apart();
      await m.write("b", 200, PATIENT, key("p1"), { allergies: "penicillin" });
      await m.remove("a", 300, PATIENT, key("p1"));
      await settled(m);
    });
  });

describe("random schedules", () => {
  test("whatever the topology, the writers and the order, nothing is lost", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Topology>("pair", "line", "triangle", "star"),
        fc.array(
          fc.record({
            device: fc.nat({ max: 3 }),
            at: fc.integer({ min: 100, max: 900 }),
            row: fc.nat({ max: 2 }),
            field: fc.nat({ max: 2 }),
            heal: fc.boolean(),
            remove: fc.boolean(),
          }),
          { minLength: 4, maxLength: 20 },
        ),
        async (topology, steps) => {
          const size = topology === "pair" ? 2 : 4;
          const m = mesh(topology, size);
          m.apart();
          for (const step of steps) {
            const who = String.fromCharCode(97 + (step.device % size));
            const k = key(`r${step.row}`);
            // a delete only where the row has been written, so the schedule stays meaningful
            if (step.remove && m.history.some((w) => String(w.key) === `r${step.row}`))
              await m.remove(who, step.at, NOTE, k);
            else await m.write(who, step.at, NOTE, k, { [`f${step.field}`]: `${who}@${step.at}` });
            if (step.heal) await m.heal();
            m.apart();
          }
          await m.heal();
          for (const check of noLoss(m))
            expect(`${check.where} ${check.actual}`).toBe(`${check.where} ${check.expected}`);
          const [first, ...rest] = digests(m);
          for (const d of rest) expect(d).toEqual(first ?? []);
        },
      ),
      { numRuns: 120 },
    );
  });
});
