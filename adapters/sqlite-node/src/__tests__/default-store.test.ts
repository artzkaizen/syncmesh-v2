import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultStore } from "../index.js";

describe("defaultStore", () => {
  test("a second open of a held store fails now with StoreLocked; close lets the next opener in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "syncmesh-lock-"));

    const held = (await defaultStore({ name: "notes", dir })).unwrap();
    const refused = await defaultStore({ name: "notes", dir });
    expect(refused.isErr()).toBe(true);
    const error = refused.match({ ok: () => undefined, err: (e) => e });
    expect(error?._tag).toBe("StoreLocked");
    expect(error?._tag === "StoreLocked" && error.path).toBe(join(dir, "notes.db"));

    await held.close();
    const admitted = (await defaultStore({ name: "notes", dir })).unwrap();
    await admitted.close();
  });
});
