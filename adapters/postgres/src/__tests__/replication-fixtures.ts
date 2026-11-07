import type { ChangeMappings, ChangeMessage, ChangeStream, SourceRow } from "@syncmesh/cdc";
import type { PeerId } from "@syncmesh/kernel";

import { cdcAllow } from "@syncmesh/cdc";
import { createEngine, createMemoryEventStore, createValidator } from "@syncmesh/engine";
import { createHlcClock, parsePartitionKey } from "@syncmesh/kernel";
import { ladder, partition, scalarText, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant } from "@syncmesh/wire";
import postgres from "postgres";

import type { PostgresChangeSource, PostgresChangeSourceOptions } from "../index.js";

import { postgresChangeSource } from "../index.js";

/**
 * A real Postgres with `wal_level = logical` — PGlite has no logical replication. CI starts one
 * (`.github/workflows/ci.yml`); locally, `vp run pg:up` in this package does, or point this at
 * your own. Unset outside CI, the suite skips and says so; unset in CI, it fails.
 */
export const POSTGRES_URL = process.env.SYNCMESH_PG_REPLICATION_URL;

if (POSTGRES_URL === undefined) {
  if (process.env.CI !== undefined) {
    throw new Error(
      "SYNCMESH_PG_REPLICATION_URL is unset in CI: the replication suite cannot be skipped there",
    );
  }
  console.warn(
    "SKIPPED: Postgres replication tests — set SYNCMESH_PG_REPLICATION_URL (vp run pg:up starts one)",
  );
}

export const sql = () => postgres(POSTGRES_URL ?? "", { max: 2 });

export const connect = () =>
  postgres(POSTGRES_URL ?? "", {
    max: 1,
    fetch_types: false,
    max_lifetime: null,
    connection: { replication: "database" },
  });

const open = new Set<ChangeStream>();
const pending = new Set<() => Promise<void>>();

/** A source whose streams {@link settle} stops, so a failed assertion cannot leave one reading. */
export function tracked(options: PostgresChangeSourceOptions): PostgresChangeSource {
  const source = postgresChangeSource(options);
  return {
    ...source,
    start: async (at) => {
      const stream = await source.start(at);
      open.add(stream);
      return stream;
    },
  };
}

/** Stops every stream and drops every scratch object a test made; run after each test. */
export async function settle() {
  for (const stream of open) stream.stop();
  open.clear();
  for (const cleanup of pending) await cleanup();
  pending.clear();
}

/** A fresh table, publication and slot per test, so suites never read each other's changes. */
export async function scratch(
  db: postgres.Sql,
  columns = "id text PRIMARY KEY, org_id text, title text",
) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const table = `cdc_${id}`;
  await db.unsafe(`CREATE TABLE ${table} (${columns})`);
  const options = {
    sql: db,
    connect,
    slot: `slot_${id}`,
    publication: `pub_${id}`,
    status: Temporal.Duration.from({ milliseconds: 50 }),
    reconnect: { attempts: 20, delay: Temporal.Duration.from({ milliseconds: 100 }) },
  } satisfies PostgresChangeSourceOptions;
  const source = tracked(options);
  (await source.publish([table])).unwrap();
  const cleanup = async () => {
    await source.drop();
    await db.unsafe(`DROP PUBLICATION IF EXISTS ${options.publication}`);
    await db.unsafe(`DROP TABLE IF EXISTS ${table}`);
  };
  pending.add(cleanup);
  return { table, options, source, cleanup };
}

/** Pulls messages until `enough` says so; fails rather than hanging a suite. */
export async function take(
  iterator: AsyncIterator<ChangeMessage>,
  enough: (seen: readonly ChangeMessage[]) => boolean,
  label: string,
): Promise<ChangeMessage[]> {
  const seen: ChangeMessage[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), 20_000);
  });
  try {
    while (!enough(seen)) {
      const next = await Promise.race([iterator.next(), expired]);
      if (next === "timeout") {
        const last = JSON.stringify(seen.slice(-3));
        throw new Error(
          `timed out waiting for ${label} after ${seen.length} messages; last ${last}`,
        );
      }
      if (next.done === true) throw new Error(`the stream ended before ${label}`);
      seen.push(next.value);
    }
    return seen;
  } finally {
    clearTimeout(timer);
  }
}

/** Enough once `n` commits arrived; counts each message once, so a 50k-row take stays linear. */
export const commits = (n: number) => {
  let counted = 0;
  let found = 0;
  return (seen: readonly ChangeMessage[]) => {
    for (; counted < seen.length; counted += 1) if (seen[counted]?.t === "commit") found += 1;
    return found >= n;
  };
};

export const iterate = (stream: ChangeStream) => stream.changes[Symbol.asyncIterator]();

/** Waits for a condition the server reaches on its own schedule. */
export async function eventually(check: () => Promise<boolean> | boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---- an authority engine, for the end-to-end tests through startCapture ----

const org = partition("org", { roles: ladder("system", "viewer") });

export const schemaFor = (table: string) =>
  syncSchema({
    tables: {
      [table]: {
        columns: { id: t.text().primaryKey(), org_id: t.text(), title: t.text().nullable() },
        partition: org,
        allow: ({ role }) => cdcAllow({ read: role("viewer"), writer: "system" }),
      },
    },
  });

const identityFrom = (byte: number) =>
  createIdentity(Uint8Array.from({ length: 32 }, (_, i) => byte + i)).unwrap();
const issuer = identityFrom(50);
const authority = identityFrom(70);
export const ACME = parsePartitionKey("org:acme").unwrap();

const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const authorityGrant = verifyGrant(
  issueGrant(issuer, {
    account: "acct_system",
    device: authority.peerId,
    role: "system",
    partitions: [ACME],
    validFor: Temporal.Duration.from({ hours: 1 }),
    now: NOW,
  }),
  issuer.peerId,
  NOW,
).unwrap();

export function authorityEngine(schema: ReturnType<typeof schemaFor>) {
  return createEngine({
    peerId: authority.peerId,
    clock: createHlcClock({ now: () => Temporal.Now.instant() }),
    store: createMemoryEventStore(),
    merge: schema.merge,
    validate: createValidator({
      schema,
      grantFor: (peer: PeerId) => (peer === authority.peerId ? authorityGrant : undefined),
      authority: authority.peerId,
    }),
  });
}

export const mappingsFor = (table: string, schema: ReturnType<typeof schemaFor>) => {
  const collection = schema.tables[table];
  if (collection === undefined) throw new Error(`no collection ${table}`);
  return {
    [table]: {
      collection,
      partition: (row: SourceRow) => `org:${scalarText(row.org_id) ?? ""}`,
    },
  } satisfies ChangeMappings;
};
