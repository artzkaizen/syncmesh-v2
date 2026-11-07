import type { PeerId } from "@syncmesh/kernel";
import type { PageSource } from "@syncmesh/window";

import { commitFeed } from "@syncmesh/cdc";
import { postgresChangeSource } from "@syncmesh/postgres";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createServerWindows, createWindowClient } from "@syncmesh/window";
import { and, desc, eq, sql } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";

import { query } from "../index.js";
import { servedReads } from "../served.js";

/**
 * A real Postgres with `wal_level = logical`, as the change-feed suite in `@syncmesh/postgres`
 * uses: `vp run pg:up` there starts one. Unset outside CI, these suites skip and say so; unset in
 * CI, they fail.
 */
export const POSTGRES_URL = process.env.SYNCMESH_PG_REPLICATION_URL;

if (POSTGRES_URL === undefined) {
  if (process.env.CI !== undefined)
    throw new Error(
      "SYNCMESH_PG_REPLICATION_URL is unset in CI: the served-read suite cannot be skipped there",
    );
  console.warn(
    "SKIPPED: served reads against Postgres — set SYNCMESH_PG_REPLICATION_URL (vp run pg:up in adapters/postgres starts one)",
  );
}

/** A name no other run of this suite uses, so runs never read each other's tables or slots. */
export const runId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const replication = () =>
  postgres(POSTGRES_URL ?? "", {
    max: 1,
    fetch_types: false,
    max_lifetime: null,
    connection: { replication: "database" },
  });

/** Mail, as an app keeps it in Postgres: millions of rows, so the server serves pages of it. */
export const mailTable = (name: string) =>
  pgTable(name, {
    id: text().primaryKey(),
    owner: text().notNull(),
    folder: text().notNull(),
    received: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    subject: text().notNull(),
  });

export type MailTable = ReturnType<typeof mailTable>;

export const MAIL_DDL = (name: string) => `
  CREATE TABLE ${name} (
    id text COLLATE "C" PRIMARY KEY,
    owner text NOT NULL,
    folder text NOT NULL,
    received timestamptz NOT NULL,
    subject text NOT NULL
  );
  CREATE INDEX ${name}_page ON ${name} (owner, folder, received, id);
`;

const mailbox = partition("mailbox", { roles: ladder("owner") });

const mailColumns = {
  id: t.text().primaryKey(),
  owner: t.text(),
  folder: t.text(),
  received: t.timestamp(),
  subject: t.text(),
};

/**
 * The manifest: `mail` is served, and a person reads only their own; `open` is served with no
 * rule at all, which a served read must refuse rather than read.
 */
export const schemaFor = (mail: string, open: string) =>
  syncSchema({
    tables: {
      [mail]: {
        columns: mailColumns,
        partition: mailbox,
        allow: ({ owner, deny }) => ({ $default: deny, read: owner("owner") }),
        sync: "window",
      },
      [open]: { columns: mailColumns, sync: "window" },
    },
  });

/** A page's cursor: the last row shown, by the two columns the page is ordered on. */
const After = z.object({ received: z.string().datetime({ offset: true }), id: z.string() });

/**
 * `mail.inbox`, written as any other read in the repo: a handler that returns the Drizzle query.
 * Newest first, keyset after the last row shown, the id breaking ties under `COLLATE "C"`.
 */
export const proceduresFor = (mail: MailTable, open: MailTable) => ({
  mail: {
    inbox: query
      .input(
        z.object({
          folder: z.string(),
          limit: z.number().int().min(1).max(100),
          after: After.optional(),
        }),
      )
      .handler(({ input, db }) =>
        db
          .select()
          .from(mail)
          .where(
            and(
              eq(mail.folder, input.folder),
              input.after === undefined
                ? undefined
                : sql`(${mail.received}, ${mail.id}) < (${input.after.received}::timestamptz, ${input.after.id})`,
            ),
          )
          .orderBy(desc(mail.received), desc(mail.id))
          .limit(input.limit),
      ),
    /** The reader's mail, only while `db.$count` agrees there are `total` of it: a count is a read too. */
    tallied: query
      .input(z.object({ total: z.number().int(), limit: z.number().int().min(1) }))
      .handler(({ input, db }) =>
        db
          .select()
          .from(mail)
          .where(eq(db.$count(mail), input.total))
          .orderBy(desc(mail.id))
          .limit(input.limit),
      ),
    everyone: query
      .input(z.object({ limit: z.number().int() }))
      .handler(({ input, db }) => db.select().from(open).orderBy(desc(open.id)).limit(input.limit)),
  },
});

export const T0 = Temporal.Instant.from("2026-01-01T00:00:00Z");
/** The instant mail number `n` arrived: one minute apart. */
export const at = (n: number) => T0.add({ minutes: n });
export const mailId = (n: number) => `m-${String(n).padStart(7, "0")}`;

/** A cursor just after mail `n`. */
export const after = (n: number) => ({ received: at(n).toString(), id: mailId(n) });

export const ALICE = { account: "alice", role: "owner", claims: {} } as const;
export const BOB = { account: "bob", role: "owner", claims: {} } as const;
/* oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- a test peer id */
export const SERVER = "server-peer" as PeerId;

/** Every statement the server's Drizzle sent, so a test can explain what a page read cost. */
export interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * One table, its publication and slot, a commit feed over #8's logical replication, and the
 * app's Drizzle beside it. `seed` runs before the slot exists, so a million seeded rows are not
 * a million changes to stream.
 */
export async function served(
  options: { readonly seed?: (sql: postgres.Sql, mail: string) => Promise<void> } = {},
) {
  const id = runId();
  const names = { mail: `mail_${id}`, open: `open_${id}` };
  const pg = postgres(POSTGRES_URL ?? "", { max: 4, onnotice: (notice) => console.log(notice) });
  await pg.unsafe(MAIL_DDL(names.mail));
  await pg.unsafe(MAIL_DDL(names.open));
  await options.seed?.(pg, names.mail);
  await pg.unsafe(`ANALYZE ${names.mail}`);
  const statements: Statement[] = [];
  const db = drizzle({
    client: pg,
    logger: { logQuery: (text, params) => void statements.push({ sql: text, params }) },
  });
  const source = postgresChangeSource({
    sql: pg,
    connect: replication,
    slot: `slot_${id}`,
    publication: `pub_${id}`,
    status: Temporal.Duration.from({ milliseconds: 50 }),
  });
  (await source.publish([names.mail, names.open])).unwrap();
  const feed = commitFeed(await source.start({ after: null }), "postgres");
  const mail = mailTable(names.mail);
  const open = mailTable(names.open);
  const schema = schemaFor(names.mail, names.open);
  const router = proceduresFor(mail, open);
  /** The page source for one principal's socket. */
  const sourceFor = (principal: typeof ALICE | typeof BOB): PageSource =>
    servedReads({ router, schema, db, principal, self: SERVER, onCommit: feed.onCommit });
  return {
    pg,
    db,
    names,
    mail,
    open,
    schema,
    router,
    statements,
    sourceFor,
    insert: (n: number, owner = "alice", folder = "inbox") =>
      pg.unsafe(
        `INSERT INTO ${names.mail} (id, owner, folder, received, subject) VALUES ($1, $2, $3, $4, $5)`,
        [mailId(n), owner, folder, at(n).toString(), `subject ${n}`],
      ),
    close: async () => {
      feed.stop();
      await feed.done;
      await source.drop();
      await pg.unsafe(`DROP PUBLICATION IF EXISTS pub_${id}`);
      await pg.unsafe(`DROP TABLE IF EXISTS ${names.mail}, ${names.open}`);
      await pg.end();
    },
  };
}

/** `count` of alice's inbox mails at 1..count, and bob's mails interleaved between them. */
export const seedMailbox = (count: number) => async (pg: postgres.Sql, mail: string) => {
  await pg.unsafe(
    `INSERT INTO ${mail} (id, owner, folder, received, subject)
     SELECT 'm-' || lpad(n::text, 7, '0'), 'alice', 'inbox', $1::timestamptz + n * interval '1 minute', 'subject ' || n
     FROM generate_series(1, $2::int) AS n`,
    [T0.toString(), count],
  );
};

/**
 * One socket's server windows over `source` and a thin client, joined by a pipe that can lose
 * the server's next frames on purpose: the protocol, end to end, over real reads.
 */
export function pipe(source: PageSource) {
  const client = createWindowClient();
  let lose = 0;
  const frames: Uint8Array[] = [];
  const server = createServerWindows({
    source,
    send: (frame) => {
      frames.push(frame);
      if (lose > 0) lose--;
      else client.receive(frame);
    },
  });
  client.attach((frame) => server.receive(frame));
  return {
    client,
    server,
    frames,
    loseNext: (n = 1) => {
      lose = n;
    },
  };
}

/** Waits for a condition a commit reaches on the replication stream's own schedule. */
export async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Temporal.Now.instant().add({ seconds: 15 });
  while (!(await check())) {
    if (Temporal.Instant.compare(Temporal.Now.instant(), deadline) > 0)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
