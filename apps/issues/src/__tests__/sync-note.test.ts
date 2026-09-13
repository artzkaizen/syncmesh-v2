import type { OperationRecord } from "@syncmesh/react";

import { describe, expect, test } from "bun:test";

import { syncNote } from "../app/sync-note.js";

const applied = { id: "op-1", label: "issue.view", status: "applied" } satisfies OperationRecord;
const blocked = { id: "op-2", label: "issue.remove", status: "blocked" } satisfies OperationRecord;
const overruled = {
  id: "op-3",
  label: "issue.update",
  status: "superseded",
  correction: { by: "cor-1", reason: "the authority renumbered it" },
} satisfies OperationRecord;

describe("what the detail header says about a write", () => {
  test("the ordinary end of a write is silence", () => {
    expect(syncNote("delivered", applied)).toBeUndefined();
    expect(syncNote("remote", applied)).toBeUndefined();
    // and a row nobody on this device wrote has no operation at all
    expect(syncNote("remote", undefined)).toBeUndefined();
  });

  test("not knowing is not a state to draw", () => {
    expect(syncNote(undefined, undefined)).toBeUndefined();
    expect(syncNote(undefined, applied)).toBeUndefined();
  });

  test("a write still on this device is the one reach worth saying", () => {
    const note = syncNote("local", applied);
    expect(note?.label).toBe("On this device only");
    expect(note?.severity).toBe("pending");
  });

  test("an overruled write outranks its reach, because waiting will not fix it", () => {
    expect(syncNote("local", blocked)?.label).toBe("Refused");
    expect(syncNote("delivered", overruled)?.label).toBe("Overruled");
    expect(syncNote("local", overruled)?.severity).toBe("critical");
  });

  test("the correction's own reason is the sentence, where there is one", () => {
    expect(syncNote("delivered", overruled)?.detail).toContain("the authority renumbered it");
    // and where there is not, it says what it knows rather than inventing a cause
    expect(syncNote("delivered", blocked)?.detail).toContain("blocked");
  });
});
