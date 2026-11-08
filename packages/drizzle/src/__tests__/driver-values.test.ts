import { describe, expect, test } from "bun:test";
import { QueryBuilder, bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { driverValues } from "../window.js";

const mail = pgTable("mail", {
  id: text().primaryKey(),
  received: timestamp({ withTimezone: true, mode: "date" }).notNull(),
  sent: timestamp({ mode: "date" }),
  size: bigint({ mode: "number" }),
});

const query = new QueryBuilder().select().from(mail);

describe("driverValues", () => {
  test("a timestamptz crosses as text and comes back a Date, as the driver's codec decodes it", () => {
    const received = new Date("2026-01-01T01:40:00.000Z");
    const { toDriver, fromDriver } = driverValues(query);
    const wire = toDriver({ id: "m-1", received, sent: null, size: 7 });
    expect(wire["received"]).toBe("2026-01-01T01:40:00.000Z");
    const back = fromDriver(wire);
    expect(back["received"]).toEqual(received);
    expect(back["sent"]).toBeNull();
  });

  test("a bigint in number mode comes back a number, and a text as the text it was", () => {
    const { fromDriver } = driverValues(query);
    expect(fromDriver({ id: "m-1", size: "7" })).toEqual({ id: "m-1", size: 7 });
  });
});
