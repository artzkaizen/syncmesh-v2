import { portableSchema } from "@syncmesh/schema";
import { describe, expect, test } from "bun:test";

import raw from "../../policy-vectors.json" with { type: "json" };
import { policySchema, policyVectors } from "../generate-policy-vectors.js";

describe("policy vectors — frozen (gap U3)", () => {
  test("the TypeScript ladder still reaches every frozen verdict (change the ladder, change the vectors — deliberately)", async () => {
    expect(JSON.parse(JSON.stringify(await policyVectors()))).toEqual(raw);
  });

  test("the manifest a port reads is the schema's own data", () => {
    expect(JSON.parse(JSON.stringify(portableSchema(policySchema)))).toEqual(raw.schema);
  });

  test("every ladder rung the vectors are for is reached", () => {
    const verdicts = new Set(
      raw.meshes.flatMap((mesh) => [
        ...mesh.steps.flatMap((step) => step.parked.map((p) => p.verdict)),
        ...mesh.probes.map((p) => p.verdict),
      ]),
    );
    for (const tag of [
      "ClockAhead",
      "NoGrant",
      "GrantRevoked",
      "GrantStale",
      "LinkRefused",
      "UnknownTable",
      "TableDropped",
      "RetiredWrite",
      "UnknownChangeKind",
      "PartitionNotGranted",
      "WrongPartition",
      "LocalOnly",
      "ReadOnlyPartition",
      "SchemaViolation",
      "DocChangeRefused",
      "DocColumnWrite",
      "PolicyDenied",
    ])
      expect(verdicts).toContain(tag);
  });
});
