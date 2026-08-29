import type { RowKey } from "@syncmesh/kernel";

import { readRow, readRows } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { createLink } from "../link.js";
import { CREATE, PEER_A, PEER_B, PEER_C, column, key, row, setup, table } from "./fixtures.js";

/**
 * Where a write is thrown away, and where it is not — as a week in the field rather than as a
 * property of a cell.
 *
 * A medical team runs a programme with no internet. A doctor, a nurse and the clinic laptop all
 * see the same patients and all write. Nothing syncs until they are back. The question this file
 * answers is not "does it converge" — it does — but **what did converge cost**, and the answer
 * is decided entirely by the schema, before anyone writes a line of app code.
 *
 * The unsafe representation is asserted explicitly beside the safe one. A same-cell overwrite
 * disappears from the materialized row (although both signed events remain in history), while
 * an append-only observation model keeps every clinical fact visible.
 */

const PATIENT = table("patient");
const OBSERVATION = table("observation");
const P1 = key("p1");

/** The doctor's tablet, the nurse's phone, and the laptop in the clinic tent. */
const team = () => {
  const doctor = setup(PEER_A, 100);
  const nurse = setup(PEER_B, 100);
  const laptop = setup(PEER_C, 100);
  const links = [
    createLink(doctor.engine, nurse.engine),
    createLink(nurse.engine, laptop.engine),
    createLink(doctor.engine, laptop.engine),
  ];
  return {
    doctor,
    nurse,
    laptop,
    everyone: [doctor, nurse, laptop],
    apart: () => links.forEach((l) => l.setOnline(false)),
    /** Back at the clinic: every pair exchanges until nothing moves. */
    reunited: async () => {
      links.forEach((l) => l.setOnline(true));
      for (let round = 0; round < 3; round += 1)
        for (const link of links) (await link.catchUp()).unwrap();
    },
  };
};

const write = async (
  who: ReturnType<typeof setup>,
  at: number,
  tbl: ReturnType<typeof table>,
  rowKey: RowKey,
  values: Readonly<Record<string, string>>,
) => {
  who.clock.set(at);
  (await who.engine.mutate(CREATE, (tx) => tx.update(tbl, rowKey, row(values)))).unwrap();
};

const cellOf = (who: ReturnType<typeof setup>, name: string) =>
  readRow(who.engine.state(), PATIENT, P1)?.get(column(name));

const observationsOn = (who: ReturnType<typeof setup>) =>
  [...readRows(who.engine.state(), OBSERVATION).keys()].map(String).sort();

const noteValuesInHistory = async (who: ReturnType<typeof setup>) => {
  const entries = (await who.store.all()).unwrap();
  return entries
    .flatMap(({ event }) =>
      event.changes.flatMap((change) => {
        if (
          change.table !== PATIENT ||
          change.key !== P1 ||
          (change.kind !== "insert" && change.kind !== "update")
        )
          return [];
        const values = change.kind === "insert" ? change.row : change.patch;
        const note = values.get(column("notes"));
        return note === "reports chest pain" || note === "administered aspirin 300mg" ? [note] : [];
      }),
    )
    .sort();
};

describe("a week in the field", () => {
  test("different columns of one patient: every write survives", async () => {
    const clinic = team();
    await write(clinic.doctor, 100, PATIENT, P1, { name: "R. Okafor" });
    await clinic.reunited();

    clinic.apart();
    await write(clinic.doctor, 200, PATIENT, P1, { bloodPressure: "140/90" });
    await write(clinic.nurse, 300, PATIENT, P1, { allergies: "penicillin" });
    await write(clinic.laptop, 400, PATIENT, P1, { ward: "tent 2" });
    await clinic.reunited();

    // this is what field-level merge buys: three clinicians, one row, nothing lost. Row-level
    // last-writer-wins — which is what most sync engines do — would have kept one of the three
    for (const who of clinic.everyone) {
      expect(cellOf(who, "bloodPressure")).toBe("140/90");
      expect(cellOf(who, "allergies")).toBe("penicillin");
      expect(cellOf(who, "ward")).toBe("tent 2");
    }
  });

  test("the same column of one patient: one clinician's write is thrown away", async () => {
    const clinic = team();
    clinic.apart();
    // both write the patient's notes, neither can see the other
    await write(clinic.doctor, 200, PATIENT, P1, { notes: "reports chest pain" });
    await write(clinic.nurse, 300, PATIENT, P1, { notes: "administered aspirin 300mg" });
    await clinic.reunited();

    // the later stamp wins, and the earlier note is gone from every device. This is a schema
    // mistake rather than an engine one — a clinical note is not one question with one answer
    for (const who of clinic.everyone)
      expect(cellOf(who, "notes")).toBe("administered aspirin 300mg");
    expect(cellOf(clinic.doctor, "notes")).not.toContain("chest pain");

    // The fold is lossy, the replicated log is not. This is enough for an audit/history screen,
    // but not enough for the ordinary patient view to warn that a clinician's note was hidden.
    for (const who of clinic.everyone)
      expect(await noteValuesInHistory(who)).toEqual([
        "administered aspirin 300mg",
        "reports chest pain",
      ]);
  });

  test("the same notes as rows: nothing is thrown away, and the record reads in order", async () => {
    const clinic = team();
    clinic.apart();
    // the same two facts, filed the way a medical record actually works: appended, never
    // overwritten, each carrying who wrote it and when
    await write(clinic.doctor, 200, OBSERVATION, key("p1:200:doctor"), {
      patientId: "p1",
      by: "doctor",
      text: "reports chest pain",
    });
    await write(clinic.nurse, 300, OBSERVATION, key("p1:300:nurse"), {
      patientId: "p1",
      by: "nurse",
      text: "administered aspirin 300mg",
    });
    await clinic.reunited();

    for (const who of clinic.everyone)
      expect(observationsOn(who)).toEqual(["p1:200:doctor", "p1:300:nurse"]);
  });

  test("a week of it: three clinicians, thirty entries, every one of them kept", async () => {
    const clinic = team();
    clinic.apart();
    for (const [name, who] of [
      ["doctor", clinic.doctor],
      ["nurse", clinic.nurse],
      ["laptop", clinic.laptop],
    ] as const) {
      for (let i = 0; i < 10; i += 1)
        await write(who, 1000 + i, OBSERVATION, key(`p1:${name}:${i}`), {
          patientId: "p1",
          by: name,
          text: `entry ${i}`,
        });
    }
    await clinic.reunited();

    const held = observationsOn(clinic.doctor);
    expect(held).toHaveLength(30);
    for (const who of clinic.everyone) expect(observationsOn(who)).toEqual(held);
  });

  test("an update that never met the delete: the later of the two decides, everywhere", async () => {
    const clinic = team();
    await write(clinic.doctor, 100, PATIENT, P1, { name: "R. Okafor" });
    await clinic.reunited();

    clinic.apart();
    clinic.laptop.clock.set(200);
    (await clinic.laptop.engine.mutate(CREATE, (tx) => tx.delete(PATIENT, P1))).unwrap();
    await write(clinic.nurse, 300, PATIENT, P1, { allergies: "penicillin" });
    await clinic.reunited();

    // the later write revives the row rather than being swallowed by the tombstone — and every
    // device agrees which, because both carry stamps and the comparison is the same everywhere
    for (const who of clinic.everyone) expect(cellOf(who, "allergies")).toBe("penicillin");
  });
});
