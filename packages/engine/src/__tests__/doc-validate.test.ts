import {
  parseAdapterId,
  parseLineageId,
  parsePartitionKey,
  type Change,
  type DocChange,
  type PeerId,
} from "@syncmesh/kernel";
import { ladder, local, partition, syncSchema, t } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createIdentity, deriveLineage, issueGrant, verifyGrant, type Grant } from "@syncmesh/wire";
import { describe, expect, test } from "bun:test";

import type { ProbeEvent, StateLookup } from "../validate.js";

import { createValidator } from "../validate.js";
import { column, key, row, seq, table } from "./fixtures.js";

const workspace = partition("workspace", { roles: ladder("owner", "editor", "viewer") });
const schema = syncSchema({
  tables: {
    notes: {
      columns: {
        id: t.text().primaryKey(),
        title: t.text(),
        content: t.blob().nullable(),
        cover: t.blob().nullable(),
      },
      partition: workspace,
      allow: ({ role }) => ({
        $default: role("owner"),
        read: role("viewer"),
        insert: role("editor"),
        update: role("editor"),
        delete: role("owner"),
      }),
    },
    drafts: {
      columns: { id: t.text().primaryKey(), content: t.blob().nullable() },
      partition: local,
    },
  },
});

const NOTES = table("notes");
const N1 = key("n1");
const CONTENT = column("content");
const LORO = parseAdapterId("loro@1").unwrap();
const DOCS = new Map([
  [NOTES, new Map([[CONTENT, LORO]])],
  [table("drafts"), new Map([[CONTENT, LORO]])],
]);

const issuer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 50 + i)).unwrap();
const editor = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).unwrap();
const viewer = createIdentity(Uint8Array.from({ length: 32 }, (_, i) => 130 + i)).unwrap();
const NOW = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_000);
const W1 = parsePartitionKey("workspace:w1").unwrap();

const grantFor = (device: PeerId, role: string): Grant =>
  verifyGrant(
    issueGrant(issuer, {
      account: `acct_${role}`,
      device,
      role,
      partitions: [W1],
      validFor: Temporal.Duration.from({ hours: 1 }),
      now: NOW,
    }),
    issuer.peerId,
    NOW,
  ).unwrap();

const grants = new Map([
  [editor.peerId, grantFor(editor.peerId, "editor")],
  [viewer.peerId, grantFor(viewer.peerId, "viewer")],
]);
const validator = createValidator({ schema, grantFor: (peer) => grants.get(peer), docs: DOCS });

const existing = row({ id: "n1", title: "t" });
const HELD: StateLookup = { row: () => existing, partition: () => W1 };
const NONE: StateLookup = { row: () => undefined, partition: () => undefined };

const doc = (extra: Partial<DocChange> = {}): DocChange => ({
  kind: "doc",
  table: NOTES,
  key: N1,
  column: CONTENT,
  adapter: LORO,
  update: { bytes: Uint8Array.of(1) },
  ...extra,
});

const verdict = (changes: readonly Change[], extra: Partial<ProbeEvent> = {}, before = HELD) => {
  const r = validator.validate({ peerId: editor.peerId, partition: W1, changes, ...extra }, before);
  return r.isErr()
    ? { tag: r.error._tag, rung: "rung" in r.error ? r.error.rung : undefined }
    : "ok";
};

describe("a doc change against the schema (RFC-0023 §10)", () => {
  test("an update of a declared doc column with its declared adapter is admitted", () => {
    expect(verdict([doc()])).toBe("ok");
  });

  test("another adapter than the column declares is refused", () => {
    expect(verdict([doc({ adapter: parseAdapterId("automerge@3").unwrap() })])).toEqual({
      tag: "DocChangeRefused",
      rung: "adapter",
    });
  });

  test("a column the table declares as something else is refused", () => {
    expect(verdict([doc({ column: column("cover") })])).toEqual({
      tag: "DocChangeRefused",
      rung: "column",
    });
  });

  test("a column the table does not declare at all is let through, like a newer build's cell", () => {
    expect(verdict([doc({ column: column("addedLater") })])).toBe("ok");
  });

  test("a genesis must name the lineage derived from its place in the log", () => {
    const at = { seqNum: seq(4) };
    const derived = deriveLineage(editor.peerId, seq(4), 0);
    expect(verdict([doc({ genesis: true, lineage: derived })], at)).toBe("ok");
    expect(verdict([doc({ genesis: true })], at)).toEqual({
      tag: "DocChangeRefused",
      rung: "lineage",
    });
    const forged = parseLineageId("ff".repeat(16)).unwrap();
    expect(verdict([doc({ genesis: true, lineage: forged })], at)).toEqual({
      tag: "DocChangeRefused",
      rung: "lineage",
    });
    // a probe is not numbered yet: the engine derives the lineage as it numbers the event
    expect(verdict([doc({ genesis: true, lineage: forged })])).toBe("ok");
  });

  test("one event starts one lineage per document", () => {
    const twice = [doc({ genesis: true, lineage: parseLineageId("01".repeat(16)).unwrap() })];
    expect(verdict([...twice, ...twice])).toEqual({ tag: "DocChangeRefused", rung: "lineage" });
  });

  test("a doc change in a local write is refused: documents live on synced rows", () => {
    const local = { kind: "doc", table: table("drafts") } as const;
    const r = validator.validate(
      { peerId: editor.peerId, local: true, changes: [doc(local)] },
      NONE,
    );
    expect(r.isErr() && r.error._tag === "DocChangeRefused" && r.error.rung).toBe("local");
  });

  test("a row write naming a doc column is DocColumnWrite, in an insert and in an update", () => {
    const insert: Change = {
      kind: "insert",
      table: NOTES,
      key: N1,
      row: row({ id: "n1", title: "t", content: Uint8Array.of(1) }),
    };
    const update: Change = { kind: "update", table: NOTES, key: N1, patch: row({ content: null }) };
    expect(verdict([insert], {}, NONE)).toEqual({ tag: "DocColumnWrite", rung: undefined });
    expect(verdict([update])).toEqual({ tag: "DocColumnWrite", rung: undefined });
  });
});

describe("a doc change against the policy (RFC-0023 §11)", () => {
  test("it is an update of its row: a viewer may not edit the document", () => {
    const r = validator.validate({ peerId: viewer.peerId, partition: W1, changes: [doc()] }, HELD);
    expect(r.isErr() && r.error._tag).toBe("PolicyDenied");
    expect(r.isErr() && "op" in r.error && r.error.op).toBe("update");
  });

  test("on a row the same event inserts, it is judged as part of that insert", () => {
    const insert: Change = {
      kind: "insert",
      table: NOTES,
      key: N1,
      row: row({ id: "n1", title: "t" }),
    };
    expect(verdict([insert, doc()], {}, NONE)).toBe("ok");
    const r = validator.validate(
      { peerId: viewer.peerId, partition: W1, changes: [insert, doc()] },
      NONE,
    );
    expect(r.isErr() && "op" in r.error && r.error.op).toBe("insert");
  });

  test("a doc change against another partition's row is WrongPartition, like any change", () => {
    const elsewhere = {
      row: () => existing,
      partition: () => parsePartitionKey("workspace:w2").unwrap(),
    };
    expect(verdict([doc()], {}, elsewhere)).toEqual({ tag: "WrongPartition", rung: undefined });
  });
});
