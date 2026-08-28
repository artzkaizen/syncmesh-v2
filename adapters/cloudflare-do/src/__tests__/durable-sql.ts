import type { Database } from "bun:sqlite";

import type { DurableSqlStorage, DurableSqlValue } from "../driver.js";

import { toArrayBuffer } from "../driver.js";

/**
 * A stand-in for `ctx.storage.sql` over `bun:sqlite` that admits **only** what the platform
 * admits — no bigint, no boolean, no `Date`, and bytes as an `ArrayBuffer` in both directions.
 * The narrowing is the point: a driver that forgot a conversion passes against a permissive fake
 * and fails in production, where the failure looks like a signature that no longer verifies.
 *
 * It is not a stand-in for workerd's SQL: statements this accepts may still be refused there.
 */
export function durableSqlOver(db: Database): DurableSqlStorage {
  return {
    exec: (query, ...bindings) => {
      /* oxlint-disable anti-slop/no-runtime-typeof -- the fake stands in for the platform, and this is that I/O boundary */
      const params = bindings.map((value) => {
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (value === null || typeof value === "string" || typeof value === "number") return value;
        throw new TypeError("a Durable Object binds only text, numbers, blobs and NULL");
      });
      /* oxlint-enable anti-slop/no-runtime-typeof */
      // SAFETY: bun:sqlite hands back text, integers, reals, blobs and NULL; each is mapped to
      // the Durable Object's own value set on the way out. A statement with no result set answers
      // `null` here, where the platform answers an empty cursor.
      const rows = (db.query(query).values(...params) ?? []) as (
        | string
        | number
        | Uint8Array
        | null
      )[][];
      const durable = rows.map((row): DurableSqlValue[] =>
        row.map((cell) => (cell instanceof Uint8Array ? toArrayBuffer(cell) : cell)),
      );
      return { raw: () => durable[Symbol.iterator]() };
    },
  };
}
