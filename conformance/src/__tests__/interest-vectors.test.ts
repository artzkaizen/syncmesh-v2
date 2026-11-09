import { describe, expect, test } from "bun:test";

import raw from "../../interest-vectors.json" with { type: "json" };
import { interestVectors } from "../generate-interest-vectors.js";

describe("interest vectors — frozen (D23, O13)", () => {
  test("the generator still produces the frozen file (change the rule, change the vectors — deliberately)", () => {
    expect(JSON.parse(JSON.stringify(interestVectors()))).toEqual(raw);
  });
});
