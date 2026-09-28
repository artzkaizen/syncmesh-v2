import { connectMesh, linkOver, serveMesh } from "@syncmesh/browser";
import { createMesh } from "@syncmesh/client";
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";
import { bunSqliteDriver } from "@syncmesh/sqlite-bun";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant } from "@syncmesh/wire";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * What a follower tab's read costs, against the alternative of keeping a mirror.
 *
 * The question this answers is the one `research/browser-durability.md` §4 leaves open: LiveStore
 * gives every tab an in-memory SQLite kept current by replaying the log, and reading over the port
 * instead is far simpler. The objection to reading over the port is not a single statement — a
 * round trip was already measured at 0.0142 ms in a browser — it is that a *live query* re-runs
 * its whole read on every fold, so the profile that matters is "N rows, many times", not "one
 * statement, once".
 *
 * So: the same Drizzle query, over the same database, run in process on the host and over a port
 * from a follower, at four row counts. The difference between the two columns is the entire bill a
 * mirror would buy back.
 */
const book = sqliteTable("book", { id: text().primaryKey(), title: text().notNull() });

const org = partition("org", { roles: ladder("owner", "member", "viewer") });
const schema = syncSchema({
  tables: {
    book: {
      columns: { id: t.text().primaryKey(), title: t.text() },
      partition: org,
      allow: ({ role }) => ({ $default: role("member"), read: role("viewer") }),
    },
  },
});

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)).unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 70 + i)).unwrap();
const T0 = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = "org:acme";

const per = async (times: number, run: () => Promise<void>): Promise<number> => {
  for (let i = 0; i < 20; i += 1) await run(); // warm the connection and the statement cache
  const started = performance.now();
  for (let i = 0; i < times; i += 1) await run();
  return (performance.now() - started) / times;
};

/** The floor: an empty message out and an empty message back, with nothing in between. */
const roundTrip = async (times: number): Promise<number> => {
  const channel = new MessageChannel();
  channel.port2.onmessage = () => channel.port2.postMessage(null);
  let settle: (() => void) | undefined;
  channel.port1.onmessage = () => settle?.();
  const once = () =>
    new Promise<void>((resolve) => {
      settle = resolve;
      channel.port1.postMessage(null);
    });
  const each = await per(times, once);
  channel.port1.close();
  channel.port2.close();
  return each;
};

const main = async (): Promise<void> => {
  const mesh = (
    await createMesh({
      schema,
      identity: device,
      issuer: issuer.peerId,
      driver: bunSqliteDriver(":memory:"),
      now: () => T0,
    })
  ).unwrap();
  mesh.grants
    .register(
      issueGrant(issuer, {
        account: "acct_one",
        device: device.peerId,
        role: "member",
        // SAFETY: a bench fixture instance in the documented kind:id form
        partitions: [ACME] as never,
        validFor: Temporal.Duration.from({ hours: 1 }),
        now: T0,
      }),
    )
    .unwrap();

  const host = serveMesh(mesh);
  const channel = new MessageChannel();
  host.accept(channel.port2);
  // no procedures: this measures the port, not an api, and `{}` is a router like any other
  const follower = connectMesh({
    link: linkOver(channel.port1, "follower"),
    schema,
    procedures: {},
  });

  const local = mesh.on(ACME).unwrap();
  const remote = follower.$mesh.on(ACME).unwrap();

  console.log(`empty round trip over a MessageChannel: ${(await roundTrip(2000)).toFixed(4)} ms`);
  console.log("");
  console.log("| rows | in process | over the port | difference |");
  console.log("|---|---|---|---|");

  let seeded = 0;
  for (const rows of [1, 10, 100, 1000]) {
    // one transaction, so seeding is one event however many rows it writes
    await local.db.transaction(async (tx) => {
      for (let i = seeded; i < rows; i += 1)
        await tx.insert(book).values({ id: `b${i}`, title: `Book number ${i}` });
    });
    seeded = rows;
    const times = rows >= 1000 ? 200 : 1000;
    const here = await per(times, async () => void (await local.db.select().from(book)));
    const there = await per(times, async () => void (await remote.db.select().from(book)));
    console.log(
      `| ${rows} | ${here.toFixed(4)} ms | ${there.toFixed(4)} ms | +${(there - here).toFixed(4)} ms |`,
    );
  }

  await follower.$close();
  host.stop();
  await mesh.stop();
};

await main();
