import type { ChangeMessage } from "@syncmesh/cdc";

import { Result } from "@syncmesh/result";

import type { AckLedger } from "./acks.js";
import type { KnownRelation } from "./changes.js";
import type { Lsn } from "./lsn.js";
import type { PgOutputMessage, Relation } from "./pgoutput.js";
import type { PostgresSourceError } from "./replication-errors.js";

import { portChanges } from "./changes.js";
import { lsnWatermark } from "./lsn.js";
import { tableName } from "./slot.js";

/**
 * The decoder's state across one stream and its reconnects: whether a transaction is open, the
 * end of the last one delivered, and the relations this session has been told about.
 */
export interface DecodeSession {
  /** `pgoutput` messages as the port's: `[]` for one that says nothing to the bridge. */
  readonly translate: (
    message: PgOutputMessage,
  ) => Promise<Result<readonly ChangeMessage[], PostgresSourceError>>;
  /** The end of the last transaction delivered whole: where a reconnect resumes. */
  readonly cursor: () => Lsn;
  readonly inTransaction: () => boolean;
  /** The connection dropped: whatever transaction was open will be resent from its begin. */
  readonly abandon: () => void;
}

export interface DecodeSessionDeps {
  readonly start: Lsn;
  readonly acks: AckLedger;
  readonly primaryKey: (oid: number) => Promise<Result<string[], PostgresSourceError>>;
}

const later = (a: Lsn, b: Lsn) => (a > b ? a : b);

const columnList = (relation: Relation) =>
  relation.columns.map((c) => `${c.name}:${c.type}`).join(", ");

export function createDecodeSession(deps: DecodeSessionDeps): DecodeSession {
  let cursor = deps.start;
  let open = false;
  let skipping = false;
  const relations = new Map<number, KnownRelation>();

  /** Which columns key a row: the identity's, or the primary key when the identity is FULL. */
  const resolveKey = async (
    relation: Relation,
  ): Promise<Result<readonly number[], PostgresSourceError>> => {
    if (relation.identity !== "full") {
      return Result.ok(relation.columns.flatMap((c, i) => (c.key ? [i] : [])));
    }
    const names = await deps.primaryKey(relation.oid);
    return names.map((pk) => relation.columns.flatMap((c, i) => (pk.includes(c.name) ? [i] : [])));
  };

  /**
   * A relation, remembered for the session. Seen before with other columns, it is the database
   * changing shape mid-stream: an alarm the bridge stops on.
   */
  const relation = async (
    described: Relation,
  ): Promise<Result<readonly ChangeMessage[], PostgresSourceError>> => {
    const before = relations.get(described.oid)?.relation;
    const resolved = await resolveKey(described);
    if (resolved.isErr()) return Result.err(resolved.error);
    relations.set(described.oid, { relation: described, key: resolved.value });
    if (before === undefined || columnList(before) === columnList(described)) return Result.ok([]);
    return Result.ok([
      {
        t: "schema",
        table: tableName(described),
        detail: `columns were (${columnList(before)}), now (${columnList(described)})`,
      },
    ]);
  };

  return {
    cursor: () => cursor,
    inTransaction: () => open,
    abandon: () => {
      open = false;
      skipping = false;
    },
    translate: async (message) => {
      switch (message.t) {
        case "begin":
          open = true;
          // a commit record before the cursor ended at or before it: already delivered
          skipping = message.final < cursor;
          return Result.ok(skipping ? [] : [{ t: "begin" }]);
        case "commit": {
          const skipped = skipping;
          open = false;
          skipping = false;
          if (skipped) return Result.ok([]);
          cursor = later(cursor, message.end);
          deps.acks.delivered(message.end);
          return Result.ok([{ t: "commit", watermark: lsnWatermark(message.end) }]);
        }
        case "relation":
          return relation(message.relation);
        case "ignored":
          return Result.ok([]);
        default:
          return Result.ok(skipping ? [] : portChanges(message, relations));
      }
    },
  };
}
