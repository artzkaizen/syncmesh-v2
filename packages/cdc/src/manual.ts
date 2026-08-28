import type { ChangeMessage, ChangeSource, ChangeStream, SourceRow, Watermark } from "./source.js";

import { parseWatermark } from "./source.js";

/** What one transaction did, in the source's own terms; the bridge maps it to collections. */
export interface ManualTx {
  readonly insert: (table: string, row: SourceRow) => void;
  /** The whole row after the write, so a replay of it says the same thing as the first pass. */
  readonly update: (table: string, key: string, after: SourceRow) => void;
  readonly delete: (table: string, key: string) => void;
  readonly truncate: (table: string) => void;
}

export interface ManualChangeSource extends ChangeSource {
  /**
   * Records one committed transaction and returns the watermark it committed at. Call it from
   * inside your own transaction's commit path: what this records is what the mesh will publish,
   * so a write that rolls back must never reach here.
   */
  readonly commit: (write: (tx: ManualTx) => void) => Watermark;
  /**
   * Reports that the database changed its own shape. The bridge stops on it — an alarm, never an
   * instruction (RFC-0013) — so this is how a migration on your side becomes a loud failure here
   * instead of a silent divergence.
   */
  readonly schemaChanged: (table: string, detail: string) => void;
  /** Transactions still held because nothing has acked them: the outbox depth, to watch. */
  readonly pending: () => number;
}

export interface ManualOptions {
  /** The name the `_cdc` row is filed under. One per database, because a reader is one. */
  readonly name: string;
}

/**
 * The source for a database that cannot stream: your app calls it when it writes.
 *
 * It is the smallest useful implementation of the port and the one everything else is measured
 * against — Postgres logical replication is the same two types with a replication slot behind
 * them, and is deliberately left as follow-on work rather than half-built here.
 *
 * It is an **outbox**, not a mirror: a transaction stays held until an ack says the derived
 * events are durable, which is what lets a resume replay it after a crash. That also means it
 * lives as long as the process — an app that must survive a restart writes its own transactions
 * to a table and implements this port over that table instead.
 *
 * ```ts
 * const source = manualChangeSource({ name: "app" })
 * source.commit((tx) => {
 *   tx.insert("tasks", { id: "t1", orgId: "acme", title: "wire the panel" })
 *   tx.update("sites", "s1", { id: "s1", orgId: "acme", name: "Depot" })
 * })
 * ```
 */
export function manualChangeSource(options: ManualOptions): ManualChangeSource {
  interface Committed {
    readonly watermark: Watermark;
    readonly messages: readonly ChangeMessage[];
  }
  const held: Committed[] = [];
  let counter = 0;
  let wake: (() => void) | undefined;
  const notify = () => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  // zero-padded, because the port's one assumption is that lexicographic order is stream order
  const nextWatermark = () => parseWatermark(String(++counter).padStart(20, "0")).unwrap();
  const record = (build: (watermark: Watermark) => readonly ChangeMessage[]) => {
    const watermark = nextWatermark();
    held.push({ watermark, messages: build(watermark) });
    notify();
    return watermark;
  };

  return {
    name: options.name,
    commit: (write) => {
      const messages: ChangeMessage[] = [{ t: "begin" }];
      write({
        insert: (table, row) => void messages.push({ t: "insert", table, row }),
        update: (table, key, after) => void messages.push({ t: "update", table, key, after }),
        delete: (table, key) => void messages.push({ t: "delete", table, key }),
        truncate: (table) => void messages.push({ t: "truncate", table }),
      });
      return record((watermark) => [...messages, { t: "commit", watermark }]);
    },
    schemaChanged: (table, detail) => void record(() => [{ t: "schema", table, detail }]),
    pending: () => held.length,
    start: ({ after }) => {
      let stopped = false;
      // the cursor and not an index, so an ack that drops delivered transactions cannot make the
      // stream skip the one it was about to yield
      let cursor = after;
      async function* pump(): AsyncGenerator<ChangeMessage> {
        while (!stopped) {
          const next = held.find((entry) => cursor === null || entry.watermark > cursor);
          if (next === undefined) {
            await new Promise<void>((resolve) => void (wake = resolve));
            continue;
          }
          cursor = next.watermark;
          yield* next.messages;
        }
      }
      const stream: ChangeStream = {
        changes: pump(),
        ack: (watermark) => {
          // only what the consumer has said is durable is forgotten; everything after it stays,
          // which is what makes a restart replay rather than lose
          const keep = held.filter((entry) => entry.watermark > watermark);
          held.length = 0;
          held.push(...keep);
        },
        stop: () => {
          stopped = true;
          notify();
        },
      };
      return Promise.resolve(stream);
    },
  };
}
