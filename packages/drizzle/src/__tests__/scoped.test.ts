import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import { revocable } from "../scoped.js";

const notes = pgTable("notes", { id: text().primaryKey(), body: text().notNull() });

/** A Drizzle over an in-process Postgres that counts every statement it sends. */
const counted = async () => {
  const client = new PGlite();
  await client.exec(`CREATE TABLE notes (id text PRIMARY KEY, body text NOT NULL)`);
  await client.exec(`INSERT INTO notes VALUES ('n1', 'kept')`);
  const sent: string[] = [];
  const db = drizzle({ client, logger: { logQuery: (query) => void sent.push(query) } });
  return { db, sent };
};

const ended = () => new Error("this read has ended");

/** What a statement came to: `sent` if it ran, and the refusal's message if it did not. */
const outcome = (statement: PromiseLike<unknown>) =>
  Promise.resolve(statement).then(
    () => "sent",
    (error: Error) => error.message,
  );

describe("revocable — a db that stops reaching the connection", () => {
  test("before revoke it reads; after, a new select is refused and nothing is sent", async () => {
    const { db, sent } = await counted();
    const fence = revocable(db, ended);
    expect(await fence.db.select().from(notes)).toEqual([{ id: "n1", body: "kept" }]);
    fence.revoke();
    const before = sent.length;
    expect(await outcome(fence.db.select().from(notes).then())).toBe("this read has ended");
    expect(await outcome(fence.db.execute(sql`select 1`).then())).toBe("this read has ended");
    expect(sent.length).toBe(before);
  });

  test("a builder or a prepared query made before revoke is refused after it", async () => {
    const { db, sent } = await counted();
    const fence = revocable(db, ended);
    const built = fence.db.select().from(notes);
    const prepared = fence.db.select().from(notes).prepare("kept_notes");
    const counting = fence.db.$count(notes);
    fence.revoke();
    const before = sent.length;
    expect(await outcome(built.then())).toBe("this read has ended");
    expect(await outcome(prepared.execute())).toBe("this read has ended");
    expect(await outcome(counting.then())).toBe("this read has ended");
    expect(sent.length).toBe(before);
  });

  test("what reflection reaches of a fence, a kept executor or the client itself, is refused after revoke", async () => {
    const { db, sent } = await counted();
    const fence = revocable(db, ended);
    const prepared = fence.db.select().from(notes).prepare("reflected");
    const executor = Reflect.getOwnPropertyDescriptor(prepared, "executor")?.value;
    const session = Reflect.getOwnPropertyDescriptor(fence.db, "session")?.value;
    const client = session.client;
    expect(await client.query("select 1 as one")).toMatchObject({ rows: [{ one: 1 }] });
    fence.revoke();
    const before = sent.length;
    expect(await outcome(executor([]))).toBe("this read has ended");
    // the text a prepared query sends is read when it is sent, so changing it changes nothing
    Object.assign(Object.getOwnPropertyDescriptor(prepared, "query")?.value, {
      sql: "select 'rewritten'",
    });
    expect(await outcome(prepared.execute())).toBe("this read has ended");
    expect(() => client.query("select 1")).toThrow("this read has ended");
    expect(sent.length).toBe(before);
  });

  test("revoking one fence leaves the db it fenced, and another fence over it, working", async () => {
    const { db } = await counted();
    const first = revocable(db, ended);
    const second = revocable(db, ended);
    first.revoke();
    expect(await second.db.select().from(notes)).toHaveLength(1);
    expect(await db.select().from(notes)).toHaveLength(1);
  });
});
