import type { PageCheckpoint } from "@syncmesh/wire";

import { decodeSnapshotPage } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { PAGE_DOCS_BUDGET, PAGE_FRAME_BYTES, fittedPage } from "../join-docs.js";
import { peer, write } from "./fixtures.js";

describe("fittedPage", () => {
  test("large rows leave less room: checkpoints are dropped until the encoded page fits a frame", async () => {
    const holder = peer(40, "acct_x");
    (await write(holder, "n1", "x".repeat(PAGE_FRAME_BYTES - PAGE_DOCS_BUDGET / 2))).unwrap();
    const { rows } = holder.engine.snapshot();
    // inside the checkpoint budget on its own, past the frame beside the row
    const checkpoint = {
      producer: holder.identity.peerId,
      checkpoint: Uint8Array.of(1, 2, 3),
      snapshot: new Uint8Array(PAGE_DOCS_BUDGET - 1024),
    } satisfies PageCheckpoint;
    const page = fittedPage(rows, { checkpoints: [checkpoint], complete: true });
    expect(page.length).toBeLessThanOrEqual(PAGE_FRAME_BYTES);
    const decoded = decodeSnapshotPage(page).unwrap();
    expect(decoded.rows).toHaveLength(1);
    expect(decoded.docs).toEqual({ checkpoints: [], complete: false });
  });
});
