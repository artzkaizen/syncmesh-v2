import { replicaId } from "@syncmesh/docs";
import { parsePeerId } from "@syncmesh/kernel";
import { hexToBytes } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import raw from "../../loro-vectors.json" with { type: "json" };
import { loroVectors } from "../generate-loro-vectors.js";

describe("loro@1 vectors — frozen (RFC-0023 §13)", () => {
  test("the adapter over loro-crdt still produces the frozen file byte for byte", () => {
    expect(JSON.parse(JSON.stringify(loroVectors()))).toEqual(raw);
  });

  test("replica ids derive from the peer and the nonce alone", () => {
    for (const r of raw.replicas)
      expect(String(replicaId(parsePeerId(r.peerId).unwrap(), hexToBytes(r.nonce).unwrap()))).toBe(
        r.replica,
      );
  });

  test("loro#1163 stays fixed: a snapshot then a concurrent insert lands where updates put it", () => {
    const history = raw.histories[0];
    expect(history?.final["c"]?.texts["t"]).toBe("abXef");
  });

  test("replicas that applied the same updates in any order hold one version", () => {
    for (const history of raw.histories.slice(1)) {
      const versions = new Set(Object.values(history.final).map((f) => f.version));
      const texts = new Set(Object.values(history.final).map((f) => JSON.stringify(f.deltas)));
      expect([history.description, versions.size, texts.size]).toEqual([history.description, 1, 1]);
    }
  });
});
