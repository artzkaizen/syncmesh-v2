import type { ChangeSource, TableRead } from "@syncmesh/cdc";
import type { Result } from "@syncmesh/result";
import type { Temporal } from "@syncmesh/temporal";

import type { PostgresQuerier } from "./index.js";
import type { ReplicationClient } from "./link.js";
import type { PostgresSourceError } from "./replication-errors.js";
import type { SlotStatus } from "./slot.js";

import { Link } from "./link.js";
import { lsnWatermark, parseLsnWatermark } from "./lsn.js";
import { ReplicationFailed } from "./replication-errors.js";
import { createSlot } from "./slot.js";

export interface LagAlarm {
  /** Lag past this many bytes raises the alarm, and so does a `wal_status` of `unreserved`. */
  readonly bytes: number;
  /** How often the slot is read while a stream is open. Default 30 seconds. */
  readonly every?: Temporal.Duration;
  readonly alarm: (status: SlotStatus) => void;
}

export interface PostgresChangeSourceOptions {
  /** An ordinary connection, for the slot, the publication and the backfill read. */
  readonly sql: PostgresQuerier;
  /** Opens a replication-mode connection; called once per stream and once per reconnect. */
  readonly connect: () => ReplicationClient;
  /** `[a-z0-9_]{1,63}`, as Postgres requires of a slot. Created on first start if absent. */
  readonly slot: string;
  /** Same alphabet as `slot`. Must exist before `start`; `publish()` makes it. */
  readonly publication: string;
  /** The `_cdc` row the watermark is filed under. Default: the slot name. */
  readonly name?: string;
  /** How often the confirmed position is reported when nothing else prompts it. Default 10 seconds. */
  readonly status?: Temporal.Duration;
  /** Reconnects after the replication connection drops. Default 5 attempts, 1 second apart. */
  readonly reconnect?: { readonly attempts: number; readonly delay: Temporal.Duration };
  readonly lag?: LagAlarm;
}

export interface PostgresChangeSource extends ChangeSource {
  /** The backfill reader: the slot's position first, then each table as of now. */
  readonly read: TableRead;
  /** The slot as the server reports it; `null` when it does not exist. */
  readonly status: () => Promise<Result<SlotStatus | null, PostgresSourceError>>;
  /**
   * Drops the slot, after any stream this source opened has closed. Releases the WAL it held,
   * and forgets every position: the next start creates a fresh slot, which needs a backfill.
   * `false` when there was no slot.
   */
  readonly drop: () => Promise<Result<boolean, PostgresSourceError>>;
  /** Creates the publication over exactly `tables`, or sets an existing one to them. */
  readonly publish: (tables: readonly string[]) => Promise<Result<void, PostgresSourceError>>;
}

const NAME = /^[a-z0-9_]{1,63}$/;

/**
 * Postgres logical replication as a `ChangeSource`: a slot read through `pgoutput`, decoded
 * here, and acked only for what was decoded **and** acked by the bridge.
 *
 * The slot's `confirmed_flush_lsn` is the only thing that lets Postgres forget a change, and the
 * only thing that moves it is a standby status update. This source sends one carrying the
 * newest position that is (a) the end of a transaction it delivered whole and the bridge acked,
 * or (b) a keepalive position received when nothing delivered was still unacked and no
 * transaction was open. Nothing else: not a received transaction, not a keepalive while a
 * transaction is pending, not a watermark beyond what was decoded.
 *
 * The watermark is the commit's end LSN as sixteen hex digits, so lexicographic order is LSN
 * order. A restart passes it back as the start point and Postgres skips every transaction that
 * ended at or before it; this source skips them too, rather than trusting that.
 *
 * Rows are keyed by the table's replica identity, which must be one column — the primary key
 * under `REPLICA IDENTITY DEFAULT`, or the primary key looked up when it is `FULL`. Under
 * `DEFAULT`, an update that leaves a TOASTed column alone does not carry it, and the update the
 * bridge receives leaves that column out: an update is a patch, so the mesh keeps the value it
 * holds. `FULL` fills it from the old row instead.
 *
 * A dropped connection reconnects from the end of the last transaction delivered, so a
 * transaction cut off half-way is sent again from its `begin` — which is the port's rule that a
 * `begin` discards whatever came after the previous `commit`.
 *
 * ```ts
 * const source = postgresChangeSource({ sql, connect, slot: "syncmesh", publication: "syncmesh" })
 * ;(await source.publish(["tasks", "sites"])).unwrap()
 * const running = (await startCapture({ engine, source, mappings, backfill: source.read })).unwrap()
 * ```
 */
export function postgresChangeSource(options: PostgresChangeSourceOptions): PostgresChangeSource {
  if (!NAME.test(options.slot)) throw new TypeError(`slot "${options.slot}": [a-z0-9_]{1,63}`);
  if (!NAME.test(options.publication)) {
    throw new TypeError(`publication "${options.publication}": [a-z0-9_]{1,63}`);
  }
  const { slot } = options;
  const queries = createSlot(options.sql, slot, options.publication);
  const closing = new Set<Promise<void>>();
  const settled = async () => void (await Promise.all(closing));
  const track = (pending: Promise<void>) => {
    closing.add(pending);
    void pending.then(() => closing.delete(pending));
  };

  return {
    name: options.name ?? slot,
    read: {
      watermark: async () => lsnWatermark(thrown(await queries.ensure())),
      rows: (table) => queries.rows(table),
    },
    status: queries.status,
    publish: queries.publish,
    drop: async () => {
      await settled();
      return queries.drop();
    },
    start: async ({ after }) => {
      await settled();
      thrown(await queries.requirePublication());
      const at = thrown(await queries.ensure());
      const start =
        after === null
          ? at
          : thrown(
              parseLsnWatermark(after).mapError(
                (cause) =>
                  new ReplicationFailed({ slot, message: `${slot}: ${cause.message}`, cause }),
              ),
            );
      const link = new Link({
        options,
        start,
        primaryKey: queries.primaryKey,
        status: queries.status,
        track,
      });
      thrown(await link.open());
      return link.stream();
    },
  };
}

/**
 * The port's `start` and `TableRead` fail by rejecting, and the bridge turns the rejection into
 * `SourceFailed` with this error as its cause; this is that one conversion back.
 */
function thrown<T>(result: Result<T, PostgresSourceError>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}
