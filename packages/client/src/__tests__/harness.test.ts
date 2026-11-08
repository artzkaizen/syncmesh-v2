import { describe, expect, test } from "bun:test";

import manifest from "../../package.json" with { type: "json" };
import * as harness from "../harness.js";
import * as root from "../index.js";

/**
 * D47: an app has one constructor, `createClient` from `@syncmesh/orpc`. This package's root is
 * public surface, so it carries no constructor of its own; `createMesh` lives at the subpath the
 * layers under an app import.
 */
describe("createMesh is not public surface (D47)", () => {
  test("the root export has no createMesh", () => {
    expect("createMesh" in root).toBe(false);
  });

  test("@syncmesh/client/internal has it, from source and from the build", () => {
    expect(Object.keys(harness)).toEqual(["createMesh"]);
    expect(manifest.exports["./internal"]).toEqual({
      "@syncmesh/source": "./src/harness.ts",
      types: "./dist/harness.d.ts",
      default: "./dist/harness.js",
    });
  });

  test("the storage helpers the options are filled with are on the root", () => {
    expect(root.sqlite({ dir: ".data" })).toEqual({ dialect: "sqlite", dir: ".data" });
    expect("postgres" in root).toBe(true);
  });
});
