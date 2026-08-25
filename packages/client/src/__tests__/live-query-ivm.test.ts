import { defineSchema, t, type Row } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";

import { createMesh } from "../mesh.js";
import { compareRows, matches, type OrderBy, type Where } from "../query.js";

const schema = () =>
  defineSchema({
    tables: {
      items: {
        columns: {
          id: t.text().primaryKey(),
          group: t.integer(),
          label: t.text().nullable(),
          score: t.integer(),
        },
        partition: "local",
      },
    },
  });

type Items = ReturnType<typeof schema>["tables"]["items"];
type ItemRow = Row<Items>;

const ORDER_BY: OrderBy<Items> = [
  ["score", "desc"],
  ["label", "asc"],
];
const WHERE: Where<Items> = { group: 1 };

const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 200 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);

const ids = ["a", "b", "c", "d", "e", "f"] as const;

type Op =
  | {
      readonly kind: "insert";
      readonly id: string;
      readonly group: number;
      readonly score: number;
      readonly label: string | null;
    }
  | { readonly kind: "update"; readonly id: string; readonly group: number; readonly score: number }
  | { readonly kind: "delete"; readonly id: string };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("insert" as const),
    id: fc.constantFrom(...ids),
    group: fc.integer({ min: 0, max: 2 }),
    score: fc.integer({ min: 0, max: 9 }),
    label: fc.option(fc.constantFrom("x", "y"), { nil: null }),
  }),
  fc.record({
    kind: fc.constant("update" as const),
    id: fc.constantFrom(...ids),
    group: fc.integer({ min: 0, max: 2 }),
    score: fc.integer({ min: 0, max: 9 }),
  }),
  fc.record({ kind: fc.constant("delete" as const), id: fc.constantFrom(...ids) }),
);

const oracle = (all: readonly ItemRow[]): readonly string[] =>
  all
    .filter((row) => matches<Items>(WHERE, row))
    .map((row) => ({ key: row.id, row }))
    .sort((a, b) => compareRows<Items>(ORDER_BY, a, b))
    .map((e) => e.key);

describe("the maintained result equals a full re-run, always", () => {
  test("randomised inserts, updates and deletes against the oracle", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        const mesh = createMesh({ schema: schema(), identity: device, now: () => T0 });
        const live = mesh.items.where(WHERE, { orderBy: ORDER_BY });
        for (const op of ops) {
          if (op.kind === "insert" && mesh.items.byId(op.id) === undefined) {
            (
              await mesh.items.insert({
                id: op.id,
                group: op.group,
                score: op.score,
                label: op.label,
              })
            ).unwrap();
          } else if (op.kind === "update" && mesh.items.byId(op.id) !== undefined) {
            const r = await mesh.items.update(op.id, { group: op.group, score: op.score });
            if (r.isErr() && r.error._tag !== "EmptyMutation") r.unwrap();
          } else if (op.kind === "delete" && mesh.items.byId(op.id) !== undefined) {
            (await mesh.items.delete(op.id)).unwrap();
          }
          const maintained = live.rows().map((row) => row.id);
          expect(maintained).toEqual([...oracle(mesh.items.all())]);
        }
        live.release();
      }),
      { numRuns: 60 },
    );
  });
});
