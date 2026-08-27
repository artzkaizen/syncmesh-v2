import {
  parsePartitionKey,
  readRow,
  type Change,
  type PartitionKey,
  type PeerId,
} from "@syncmesh/kernel";
import { defineSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, issueGrant, verifyGrant, type Grant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import { can } from "../can.js";
import { createEngine } from "../engine.js";
import { createMemoryEventStore } from "../store.js";
import { createValidator } from "../validate.js";
import { CREATE, fakeClock, key, row, table } from "./fixtures.js";

const schema = defineSchema({
  partitions: { org: {} },
  roles: { org: ["admin", "member"] },
  tables: {
    catalog: { columns: { id: t.text().primaryKey(), code: t.text() } },
    books: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        pages: t.integer().nullable(),
        createdBy: t.text(),
      },
      partition: "org",
      allow: ({ role, owner, any }) => ({
        $default: role("member"),
        update: any(owner("createdBy"), role("admin")),
        delete: role("admin"),
      }),
    },
    notes: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: "user" },
    drafts: { columns: { id: t.text().primaryKey(), body: t.text() }, partition: "local" },
  },
});

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const device = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const other = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 130 + i)).unwrap();
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const ACME = parsePartitionKey("org:acme").unwrap();
const USER = parsePartitionKey("user:acct_a").unwrap();
const BOOKS = table("books");
const B1 = key("b1");

const grantFor = (role: string, dev = device.peerId): Grant =>
  verifyGrant(
    issueGrant(issuer, {
      account: "acct_a",
      device: dev,
      role,
      partitions: [ACME],
      validFor: Temporal.Duration.from({ hours: 1 }),
      now: NOW,
    }),
    issuer.peerId,
    NOW,
  ).unwrap();

const grants = new Map<PeerId, Grant>([[device.peerId, grantFor("member")]]);
const validator = createValidator({ schema, grantFor: (peer) => grants.get(peer) });
const none = () => undefined;
const NONE = { row: none, partition: none };
const tag = (r: { isErr(): boolean; error?: { _tag: string } }) =>
  r.isErr() ? r.error?._tag : "ok";

const insert = (values: Parameters<typeof row>[0], partition = ACME, peerId = device.peerId) =>
  validator.validate(
    { peerId, partition, changes: [{ kind: "insert", table: BOOKS, key: B1, row: row(values) }] },
    NONE,
  );

describe("createValidator — the ladder", () => {
  test("a stranger is NoGrant; a grant naming another device is GrantDeviceMismatch", () => {
    expect(tag(insert({ id: "b1", title: "t", createdBy: "acct_a" }, ACME, other.peerId))).toBe(
      "NoGrant",
    );
    grants.set(other.peerId, grantFor("member", device.peerId));
    expect(tag(insert({ id: "b1", title: "t", createdBy: "acct_a" }, ACME, other.peerId))).toBe(
      "GrantDeviceMismatch",
    );
    grants.delete(other.peerId);
  });

  test("partition rules: kind must match, the grant must list it, user is the account's, local never travels, global is read-only", () => {
    const good = { id: "b1", title: "t", createdBy: "acct_a" };
    expect(tag(insert(good))).toBe("ok");
    expect(tag(insert(good, USER))).toBe("WrongPartition");
    expect(tag(insert(good, parsePartitionKey("org:globex").unwrap()))).toBe("PartitionNotGranted");
    const notesChanges: readonly Change[] = [
      { kind: "insert", table: table("notes"), key: B1, row: row({ id: "n", body: "b" }) },
    ];
    const notes = (partition: PartitionKey | undefined) =>
      partition === undefined
        ? validator.validate({ peerId: device.peerId, changes: notesChanges }, NONE)
        : validator.validate({ peerId: device.peerId, partition, changes: notesChanges }, NONE);
    expect(tag(notes(USER))).toBe("ok");
    expect(tag(notes(parsePartitionKey("user:acct_b").unwrap()))).toBe("WrongPartition");
    expect(tag(notes(undefined))).toBe("WrongPartition");
    const drafts = validator.validate(
      {
        peerId: device.peerId,
        changes: [
          { kind: "insert", table: table("drafts"), key: B1, row: row({ id: "d", body: "b" }) },
        ],
      },
      NONE,
    );
    expect(tag(drafts)).toBe("LocalOnly");
    const catalog = validator.validate(
      {
        peerId: device.peerId,
        changes: [
          { kind: "insert", table: table("catalog"), key: B1, row: row({ id: "c", code: "x" }) },
        ],
      },
      NONE,
    );
    expect(tag(catalog)).toBe("ReadOnlyPartition");
    // isAuthority alone never opens global tables: it would accept here what every
    // device rejects — the same event must get the same verdict on every peer
    const authority = createValidator({
      schema,
      grantFor: (peer) => grants.get(peer),
      isAuthority: true,
    });
    expect(
      tag(
        authority.validate(
          {
            peerId: device.peerId,
            changes: [
              {
                kind: "insert",
                table: table("catalog"),
                key: B1,
                row: row({ id: "c", code: "x" }),
              },
            ],
          },
          NONE,
        ),
      ),
    ).toBe("ReadOnlyPartition");
    expect(
      tag(
        validator.validate(
          {
            peerId: device.peerId,
            partition: ACME,
            changes: [{ kind: "insert", table: table("nope"), key: B1, row: row({}) }],
          },
          NONE,
        ),
      ),
    ).toBe("UnknownTable");
  });

  test("schema runs before policy, and runs even in ungranted mode", () => {
    expect(tag(insert({ id: "b1", title: "t", pages: 1.5, createdBy: "acct_a" }))).toBe(
      "SchemaViolation",
    );
    const ungranted = createValidator({ schema, grantFor: null });
    const bad = ungranted.validate(
      {
        peerId: other.peerId,
        partition: ACME,
        changes: [
          {
            kind: "insert",
            table: BOOKS,
            key: B1,
            row: row({ id: "b1", title: "t", pages: 1.5, createdBy: "x" }),
          },
        ],
      },
      NONE,
    );
    expect(tag(bad)).toBe("SchemaViolation");
    const ok = ungranted.validate(
      {
        peerId: other.peerId,
        partition: ACME,
        changes: [{ kind: "delete", table: BOOKS, key: B1 }],
      },
      NONE,
    );
    expect(tag(ok)).toBe("ok");
  });

  test("policy: the rule for the op, with the stored row and the patch", () => {
    const mine = () => row({ id: "b1", title: "t", createdBy: "acct_a" });
    const theirs = () => row({ id: "b1", title: "t", createdBy: "acct_b" });
    const update = (before: () => ReturnType<typeof row>) =>
      validator.validate(
        {
          peerId: device.peerId,
          partition: ACME,
          changes: [{ kind: "update", table: BOOKS, key: B1, patch: row({ title: "x" }) }],
        },
        { row: before, partition: none },
      );
    expect(tag(update(mine))).toBe("ok");
    expect(tag(update(theirs))).toBe("PolicyDenied");
    const del = validator.validate(
      {
        peerId: device.peerId,
        partition: ACME,
        changes: [{ kind: "delete", table: BOOKS, key: B1 }],
      },
      { row: mine, partition: none },
    );
    expect(tag(del)).toBe("PolicyDenied");
    grants.set(device.peerId, grantFor("admin"));
    expect(tag(update(theirs))).toBe("ok");
    grants.set(device.peerId, grantFor("member"));
  });
});

describe("the engine with a validator", () => {
  const setup = () => {
    const store = createMemoryEventStore();
    const clock = fakeClock(100);
    const engine = createEngine({ peerId: device.peerId, clock, store, validate: validator });
    return { store, clock, engine };
  };

  test("a denied local write is a value: nothing ticks, no sequence number is burned", async () => {
    const { engine, store, clock } = setup();
    const before = clock.last();
    const r = await engine.mutate(
      CREATE,
      (tx) => tx.insert(BOOKS, B1, row({ id: "b1", title: "t", pages: 1.5, createdBy: "acct_a" })),
      { partition: ACME },
    );
    expect(tag(r)).toBe("SchemaViolation");
    expect(clock.last()).toBe(before);
    expect((await store.all()).unwrap()).toHaveLength(0);
    const ok = (
      await engine.mutate(
        CREATE,
        (tx) => tx.insert(BOOKS, B1, row({ id: "b1", title: "t", createdBy: "acct_a" })),
        { partition: ACME },
      )
    ).unwrap();
    expect(Number(ok.seqNum)).toBe(1);
  });

  test("a received event that fails validation is quarantined with its reason, never stored or folded", async () => {
    const { engine, store } = setup();
    const forged = createEngine({
      peerId: other.peerId,
      clock: fakeClock(100),
      store: createMemoryEventStore(),
    });
    const event = (
      await forged.mutate(
        CREATE,
        (tx) => tx.insert(BOOKS, B1, row({ id: "b1", title: "t", createdBy: "acct_b" })),
        { partition: ACME },
      )
    ).unwrap();
    const seen: string[] = [];
    engine.onQuarantine((q) => void seen.push(q.reason._tag));
    expect((await engine.receive({ event })).unwrap()).toEqual({
      folded: 0,
      skipped: 0,
      quarantined: 1,
    });
    expect(seen).toEqual(["NoGrant"]);
    expect((await store.all()).unwrap()).toHaveLength(0);
    expect(readRow(engine.state(), BOOKS, B1)).toBeUndefined();
  });
});

describe("can", () => {
  test("answers from the same rule the receivers enforce", () => {
    const grant = grants.get(device.peerId);
    const mine = row({ createdBy: "acct_a" });
    expect(can(schema, grant, "books.update", mine)).toBe(true);
    expect(can(schema, grant, "books.update", row({ createdBy: "acct_b" }))).toBe(false);
    expect(can(schema, grant, "books.delete", mine)).toBe(false);
    expect(can(schema, grantFor("admin"), "books.delete", mine)).toBe(true);
    expect(can(schema, grant, "notes.insert")).toBe(true);
    expect(can(schema, undefined, "books.read")).toBe(false);
    expect(can(schema, grant, "nope.read")).toBe(false);
  });
});

describe("a row keeps the partition it was born in", () => {
  test("a write to a row held in another instance is WrongPartition, whoever the author is", () => {
    grants.set(device.peerId, grantFor("admin"));
    const validator = createValidator({ schema, grantFor: (peer) => grants.get(peer) });
    const other = parsePartitionKey("org:globex").unwrap();
    const held = { row: none, partition: () => other };
    const verdict = validator.validate(
      {
        peerId: device.peerId,
        partition: ACME,
        changes: [{ kind: "update", table: BOOKS, key: B1, patch: row({ title: "x" }) }],
      },
      held,
    );
    expect(tag(verdict)).toBe("WrongPartition");
    expect(verdict.isErr() && verdict.error.message).toContain("org:globex");
  });
});

describe("global is authored by the authority, verified by authorship", () => {
  const relay = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 170 + i)).unwrap();
  const catalogChanges: readonly Change[] = [
    { kind: "insert", table: table("catalog"), key: key("c1"), row: row({ id: "c1", code: "x" }) },
  ];

  test("a device with the authority configured accepts its global events and nobody else's", () => {
    const validator = createValidator({
      schema,
      grantFor: null,
      authority: relay.peerId,
    });
    expect(tag(validator.validate({ peerId: relay.peerId, changes: catalogChanges }, NONE))).toBe(
      "ok",
    );
    expect(tag(validator.validate({ peerId: device.peerId, changes: catalogChanges }, NONE))).toBe(
      "ReadOnlyPartition",
    );
  });

  test("with an authority configured, even the local isAuthority flag defers to authorship", () => {
    const validator = createValidator({
      schema,
      grantFor: null,
      isAuthority: true,
      authority: relay.peerId,
    });
    expect(tag(validator.validate({ peerId: device.peerId, changes: catalogChanges }, NONE))).toBe(
      "ReadOnlyPartition",
    );
  });
});
