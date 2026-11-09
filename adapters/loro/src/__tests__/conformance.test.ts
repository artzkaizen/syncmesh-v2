import type { LoroDoc } from "loro-crdt";

import { checkAdapter } from "@syncmesh/docs/testing";
import { describe, expect, test } from "bun:test";

import { loro } from "../index.js";

describe("loro@1 against the document SPI's conformance suite (RFC-0023 §13)", () => {
  test("every property holds: convergence, idempotence, pending, snapshot, since, totality, watchLocal", () => {
    const checked = checkAdapter(loro(), {
      edit: (doc: LoroDoc, n) => {
        doc.getText("body").insert(0, `${String(n)} `);
        doc.commit();
      },
      read: (doc: LoroDoc) => doc.getText("body").toString(),
    });
    expect(checked.isOk() || checked.error.failures).toBe(true);
  });
});
