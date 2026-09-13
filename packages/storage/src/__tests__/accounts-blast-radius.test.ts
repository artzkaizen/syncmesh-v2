import type { Engine } from "@syncmesh/engine";
import type { ProbeEvent, StateLookup, Validator } from "@syncmesh/engine";
import type { CellValue, ColumnName, PeerId, Row, RowKey, TableName } from "@syncmesh/kernel";
import type { Grant } from "@syncmesh/wire";
import type { SQLQueryBindings } from "bun:sqlite";

import {
  can,
  createEngine,
  createMemoryEventStore,
  disputes,
  linkDevice,
  linkedAuthor,
  links,
} from "@syncmesh/engine";
import { createValidator } from "@syncmesh/engine";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures; naming rules belong to the schema */
const NOTES = "notes" as TableName;
const N1 = "n1" as RowKey;
const PEER_A = parsePeerId("a".repeat(64)).unwrap();
const PEER_B = parsePeerId("b".repeat(64)).unwrap();
const row = (values: Readonly<Record<string, CellValue>>): Row =>
  new Map(Object.entries(values).map(([name, value]) => [name as ColumnName, value]));
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** A clock a test can move, so a stamp is a fact the test states rather than one it races. */
const fakeClock = (start: number) => {
  let ms = start;
  const clock = createHlcClock({ now: () => Temporal.Instant.fromEpochMilliseconds(ms) });
  return { ...clock, set: (next: number) => void (ms = next) };
};
import {
  createHlcClock,
  getRecord,
  parseAccountId,
  parsePartitionKey,
  parsePeerId,
  readRow,
} from "@syncmesh/kernel";
import { syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import {
  bytesToHex,
  createIdentity,
  decodeCbor,
  encodeGrant,
  hexToBytes,
  issueGrant,
  verifyGrant,
} from "@syncmesh/wire";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import frozen from "../../../../conformance/grant-vectors.json" with { type: "json" };
// this test lives in `storage` rather than `engine` because it must exercise all three engines
// that compile `owner()`, and only here do both resolve to real sources: engine does not depend
// on storage, so from there the package specifier would guard whatever `dist` happened to be
// lying there and this file would pin a stale build instead of the compilers it is guarding
import { compileRead } from "../read-filter.js";
import { principalSettings, rlsDdl } from "../rls.js";

/**
 * The one property the whole account layer rests on: **in a granted mesh a link is never read**
 * (D21). Wire links into the granted path and every `owner()` rule in every deployment becomes
 * answerable by a key nobody vetted, standing in front of the function that decides what a
 * device may do. So this file asserts the property from outside — against all three engines that
 * compile `owner()` independently — rather than against the `grantFor === null` arm that is
 * supposed to hold it. If any of them ever consults a link while a grant is held, one of the
 * frozen tables below moves.
 *
 * The link folded here is not a forgery. It is signed by the account's own key, authored by the
 * device it names, isolated, monotonic, and admitted by a real engine, which is the worst case
 * a link can reach: a leaked account key, or an account nobody but its holder ever vetted. Its
 * being *unimpeachable* is the point — a link that failed a rung would prove nothing about what
 * happens when one passes them all.
 */

const ACME = parsePartitionKey("org:acme").unwrap();
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const HOUR = Temporal.Duration.from({ hours: 1 });

const seeded = (base: number) =>
  createIdentity(Uint8Array.from({ length: 32 }, (_, i) => base + i));

const ISSUER = seeded(50).unwrap();
/** Alice's account key — which the attacker also holds, so its signature is beyond dispute. */
const ALICE = seeded(10).unwrap();
const MALLORY = seeded(90).unwrap();
/** The attacker's device, a real keypair because the mesh resolver is asked about it below. */
const INTRUDER = seeded(200).unwrap();

const ALICE_ID = String(parseAccountId(String(ALICE.peerId)).unwrap());
const MALLORY_ID = String(parseAccountId(String(MALLORY.peerId)).unwrap());

const schema = syncSchema({
  partitions: { org: {} },
  tables: {
    notes: {
      columns: { id: t.text().primaryKey(), title: t.text(), ownerId: t.text() },
      partition: "org",
      allow: ({ owner }) => ({ $default: owner("ownerId") }),
    },
  },
});

const [notes] = schema.entries;
if (notes === undefined) throw new Error("the fixture schema lost its only table");
const LADDER = schema.rolesFor(notes.partition);

/** The issuer mints Alice's two devices with one `account`: `owner()` is already cross-device. */
const issued = (device: PeerId, account: string): Grant =>
  verifyGrant(
    issueGrant(ISSUER, { account, device, partitions: [ACME], validFor: HOUR, now: NOW }),
    ISSUER.peerId,
    NOW,
  ).unwrap();

const GRANTS = new Map<PeerId, Grant>([
  [PEER_A, issued(PEER_A, ALICE_ID)],
  [PEER_B, issued(PEER_B, ALICE_ID)],
  [INTRUDER.peerId, issued(INTRUDER.peerId, MALLORY_ID)],
]);

const grantFor = (peer: PeerId) => GRANTS.get(peer);

const grant = (peer: PeerId): Grant => {
  const held = GRANTS.get(peer);
  if (held === undefined) throw new Error("the fixture grants lost a device");
  return held;
};

/** Accounts unset is what ships today; accounts on is the rung D21 adds. Neither reads a link here. */
const AS_SHIPPED = createValidator({ schema, grantFor });
const WITH_ACCOUNTS = createValidator({ schema, grantFor, accounts: true });

const NOTE = row({ id: "n1", title: "alice's note", ownerId: ALICE_ID });

/** The note this mesh argues over, plus whatever `_links` rows the given engine actually folded. */
const heldBy = (engine: Engine | undefined): StateLookup => {
  const state = engine?.state();
  const isNote = (table: TableName, key: RowKey) => String(table) === String(NOTES) && key === N1;
  return {
    row: (table, key) => {
      if (isNote(table, key)) return NOTE;
      return state === undefined ? undefined : readRow(state, table, key);
    },
    partition: (table, key) => {
      if (isNote(table, key)) return ACME;
      return state === undefined ? undefined : getRecord(state, table, key)?.partition;
    },
    // a link is filed under its own core's digest, so resolving one is a fold over the table
    records: (table) => state?.get(table),
  };
};

const write = (peerId: PeerId, ownerId: string): ProbeEvent => ({
  peerId,
  partition: ACME,
  changes: [
    { kind: "insert", table: NOTES, key: N1, row: row({ id: "n1", title: "n1", ownerId }) },
  ],
});

const tag = (r: { isErr(): boolean; error?: { readonly _tag: string } }) =>
  r.isErr() ? (r.error?._tag ?? "?") : "ok";

/** Engine one — the validator's own ladder, for every device that could be writing. */
const verdicts = (validator: Validator, before: StateLookup) => ({
  "phone writes alice's row": tag(validator.validate(write(PEER_A, ALICE_ID), before)),
  "laptop writes alice's row": tag(validator.validate(write(PEER_B, ALICE_ID), before)),
  "intruder writes alice's row": tag(validator.validate(write(INTRUDER.peerId, ALICE_ID), before)),
  "intruder writes its own row": tag(
    validator.validate(write(INTRUDER.peerId, MALLORY_ID), before),
  ),
});

const ADMITS = {
  "phone writes alice's row": "ok",
  "laptop writes alice's row": "ok",
  "intruder writes alice's row": "PolicyDenied",
  "intruder writes its own row": "ok",
} as const;

/** Engine two — the compiled read filter, and the rows SQLite actually hands back for it. */
const db = new Database(":memory:");
db.run(`CREATE TABLE "notes" ("id" TEXT PRIMARY KEY, "title" TEXT, "ownerId" TEXT)`);
db.run(`INSERT INTO "notes" VALUES (?, ?, ?)`, ["n1", "alice's note", ALICE_ID]);

const selects = (peer: PeerId) => {
  const { sql, params } = compileRead(notes.table, LADDER, notes.allow, grant(peer));
  // SAFETY: a SqlValue is string | number | null | Uint8Array, each one a bun:sqlite binding
  const bound = params as readonly SQLQueryBindings[];
  const ids = db.query(`SELECT "id" FROM "notes" WHERE ${sql}`).values(...bound);
  return { sql, params, ids: ids.flat() };
};

/**
 * Engine three — Postgres RLS. Nothing in this suite has a live database, so the assertion is on
 * the emitted **text**: the DDL, plus the transaction-local settings that carry the principal
 * into it. That is the signal that matters, because the predicate reads the account out of
 * `current_setting('syncmesh.account')` and `principalSettings` puts the *grant's* account
 * there — so the text moving is the same event as the verdict moving.
 */
const RLS_READ_POLICY = `CREATE POLICY "_syncmesh_read" ON "notes" FOR SELECT USING ((COALESCE("ownerId" = NULLIF(current_setting('syncmesh.account', TRUE), ''), FALSE)) AND ((NULLIF(current_setting('syncmesh.partition', TRUE), '') IS NULL OR "_partition" = NULLIF(current_setting('syncmesh.partition', TRUE), ''))))`;

const rlsFor = (peer: PeerId) => ({
  ddl: rlsDdl(notes.table, LADDER, notes.allow),
  account: principalSettings(grant(peer), { partition: ACME })[0]?.params,
});

/** Alice's account key signing for a device that is not hers, admitted by a real engine. */
const attackerLink = async (): Promise<Engine> => {
  const engine = createEngine({
    peerId: INTRUDER.peerId,
    clock: fakeClock(NOW.epochMilliseconds),
    store: createMemoryEventStore(),
    merge: schema.merge,
    validate: createValidator({ schema, grantFor: null, accounts: true }),
  });
  (
    await linkDevice(engine, { account: ALICE, device: INTRUDER.peerId, partition: ACME, at: NOW })
  ).unwrap();
  return engine;
};

describe("the baseline: one account, two devices, three engines that must agree", () => {
  test("the validator admits both of Alice's devices and denies the intruder", () => {
    expect(verdicts(AS_SHIPPED, heldBy(undefined))).toEqual(ADMITS);
  });

  test("the compiled read filter selects the row for both devices and for nobody else", () => {
    expect(selects(PEER_A)).toEqual({ sql: '"ownerId" = ?', params: [ALICE_ID], ids: ["n1"] });
    expect(selects(PEER_B)).toEqual({ sql: '"ownerId" = ?', params: [ALICE_ID], ids: ["n1"] });
    expect(selects(INTRUDER.peerId)).toEqual({
      sql: '"ownerId" = ?',
      params: [MALLORY_ID],
      ids: [],
    });
  });

  test("the RLS policy reads the account out of the settings the grant fills in", () => {
    expect(rlsFor(PEER_A).ddl).toContain(RLS_READ_POLICY);
    expect(rlsFor(PEER_A).account).toEqual([ALICE_ID]);
    expect(rlsFor(PEER_B).account).toEqual([ALICE_ID]);
    expect(rlsFor(INTRUDER.peerId).account).toEqual([MALLORY_ID]);
  });

  test("can() agrees with the validator about who owns the row", () => {
    const source = { partition: ACME, rows: heldBy(undefined).row };
    expect(can(schema, grant(PEER_A), "notes.update", NOTE, undefined, source)).toBe(true);
    expect(can(schema, grant(PEER_B), "notes.update", NOTE, undefined, source)).toBe(true);
    expect(can(schema, grant(INTRUDER.peerId), "notes.update", NOTE, undefined, source)).toBe(
      false,
    );
  });
});

describe("a valid link binding the intruder to that account moves nothing", () => {
  test("the link is real: it passes every rung, and it would name Alice if anything read it", async () => {
    const engine = await attackerLink();
    expect(links(engine)).toEqual([
      {
        account: ALICE_ID,
        device: String(INTRUDER.peerId),
        partition: "org:acme",
        at: NOW,
        linked: true,
      },
    ]);
    // the ungranted resolver — the only one D21 lets read this — does name Alice for the intruder
    const before = heldBy(engine);
    expect(
      linkedAuthor({ peerId: INTRUDER.peerId, partition: ACME, changes: [] }, before)?.account,
    ).toBe(ALICE_ID);
  });

  test("the validator's verdicts are unchanged, with accounts unset and with accounts on", async () => {
    const before = heldBy(await attackerLink());
    expect(verdicts(AS_SHIPPED, before)).toEqual(ADMITS);
    expect(verdicts(WITH_ACCOUNTS, before)).toEqual(ADMITS);
  });

  test("the compiled SQL and the RLS text are identical to the baseline", async () => {
    // the link is folded and live; both compilers are then re-run and must emit the same bytes,
    // because neither has any business asking state who a device is
    await attackerLink();
    expect(selects(INTRUDER.peerId)).toEqual({
      sql: '"ownerId" = ?',
      params: [MALLORY_ID],
      ids: [],
    });
    expect(selects(PEER_A)).toEqual({ sql: '"ownerId" = ?', params: [ALICE_ID], ids: ["n1"] });
    expect(rlsFor(INTRUDER.peerId).ddl).toContain(RLS_READ_POLICY);
    expect(rlsFor(INTRUDER.peerId).account).toEqual([MALLORY_ID]);
  });

  test("can() still refuses the intruder, reading the very rows the validator read", async () => {
    const engine = await attackerLink();
    const source = { partition: ACME, rows: heldBy(engine).row };
    // `can` is handed a principal rather than resolving one, so this pins the half that lives
    // here: the same rows the validator read, and the same verdict. The other half — the
    // resolver that must build that principal from the grant and never from the link — lives in
    // `@syncmesh/client`'s `openAccounts`, which this package cannot import, and needs the
    // matching guard in `packages/client/src/__tests__`
    expect(can(schema, grant(INTRUDER.peerId), "notes.update", NOTE, undefined, source)).toBe(
      false,
    );
    expect(can(schema, grant(PEER_A), "notes.update", NOTE, undefined, source)).toBe(true);
  });

  test("and the disagreement is reported rather than resolved: disputes() names the device", async () => {
    const engine = await attackerLink();
    expect(disputes(engine, grantFor)).toEqual([
      {
        device: String(INTRUDER.peerId),
        partition: "org:acme",
        linked: ALICE_ID,
        granted: MALLORY_ID,
      },
    ]);
  });
});

describe("the migration guard: adding accounts moved nothing that already shipped", () => {
  test("every verdict is what it is today, link or no link, accounts on or unset", async () => {
    const engine = await attackerLink();
    expect({
      "no link, accounts unset": verdicts(AS_SHIPPED, heldBy(undefined)),
      "no link, accounts on": verdicts(WITH_ACCOUNTS, heldBy(undefined)),
      "link held, accounts unset": verdicts(AS_SHIPPED, heldBy(engine)),
      "link held, accounts on": verdicts(WITH_ACCOUNTS, heldBy(engine)),
    }).toEqual({
      "no link, accounts unset": ADMITS,
      "no link, accounts on": ADMITS,
      "link held, accounts unset": ADMITS,
      "link held, accounts on": ADMITS,
    });
  });

  test("D08's frozen grant vectors still decode and re-encode byte-identically", () => {
    const issuer = parsePeerId(frozen.issuerId).unwrap();
    expect(frozen.vectors.length).toBeGreaterThan(0);
    for (const vector of frozen.vectors) {
      const wire = hexToBytes(vector.wireHex).unwrap();
      const held = verifyGrant(wire, issuer, NOW).unwrap();
      expect(String(held.device)).toBe(frozen.deviceId);
      const envelope = decodeCbor(wire).unwrap();
      if (!Array.isArray(envelope) || !(envelope[0] instanceof Uint8Array))
        throw new Error("the frozen vectors are not [core, sig]");
      // re-encoding from the decoded grant reproduces the frozen core, so every integer key in
      // GrantCore's map is exactly where D08 left it — `AccountCore` took a table, not a slot
      expect(bytesToHex(encodeGrant(held))).toBe(bytesToHex(envelope[0]));
    }
  });
});
