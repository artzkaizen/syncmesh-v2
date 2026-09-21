import type { Live, LiveChange } from "@syncmesh/drizzle";
import type { BaseCollectionConfig, SyncConfig } from "@tanstack/db";

/**
 * A TanStack DB collection over one mesh query (book ch. 11).
 *
 * The adapter opens `~mesh` the way every adapter does: the descriptor's `key` is the
 * collection's identity — a new input is a new question, so dynamic scope falls out for free —
 * `live()` is the sync source, and the rows it yields keep their identity across deliveries, so
 * TanStack's own diffing sees a change only where one happened.
 *
 * Mutation handlers are **explicit bindings to procedures, and non-optimistic**: each returns
 * the write's `committed`. The local commit is already the fast path — it is a write to this
 * device's own SQLite, not a round trip — and layering TanStack's optimistic overlay on top of
 * it is where phantom rollbacks come from: two copies of the same pending state, one of which
 * can be discarded by a server that, here, does not exist.
 */

/** The slice of a mesh query this adapter needs; `@syncmesh/orpc`'s `QueryCall` satisfies it. */
export interface MeshQuery<T> {
  readonly key: string;
  readonly live: () => Live<T>;
  /** Every source that could still fill this scope has answered — what gates the ready state. */
  readonly settled: () => Promise<void>;
}

export interface SyncmeshCollectionOptions<
  T extends object,
  TKey extends string | number,
> extends Omit<BaseCollectionConfig<T, TKey>, "sync" | "getKey"> {
  /**
   * Row identity. Defaults to the row's `id`, which is what a mesh table's primary key is;
   * override it for a query whose projection renamed or joined away that column.
   */
  readonly getKey?: (row: T) => TKey;
}

export function syncmeshCollection<T extends object, TKey extends string | number = string>(
  query: MeshQuery<T>,
  options: SyncmeshCollectionOptions<T, TKey> = {},
): BaseCollectionConfig<T, TKey> & { readonly sync: SyncConfig<T, TKey> } {
  // SAFETY: absent an override, identity is the table's primary key — which every mesh table
  // has and the schema names `id`; a projection that renamed it passes `getKey` instead
  const byId = (row: T): TKey => (row as { readonly id: TKey }).id;
  const keyOf = options.getKey ?? byId;

  const sync: SyncConfig<T, TKey> = {
    sync: ({ begin, write, commit, markReady }) => {
      const live = query.live();
      let held = new Map<TKey, T>();

      /**
       * The delta the mesh already knew, forwarded — the whole delivery, without reading the
       * list.
       *
       * A maintained query hands over exactly which keys moved, which is the shape TanStack's
       * protocol is written in. Rebuilding a map of a thousand rows to rediscover the one the
       * fold named is the cost this exists to avoid.
       */
      const forward = (changes: readonly LiveChange<T>[]): void => {
        begin();
        for (const change of changes) {
          const key = keyOf(change.row);
          if (change.kind === "delete") {
            held.delete(key);
            write({ type: "delete", key });
            continue;
          }
          held.set(key, change.row);
          write({ type: change.kind, value: change.row });
        }
        void commit();
      };

      /** One delivery as TanStack's protocol wants it: the diff, not the snapshot. */
      const publish = (rows: readonly T[], changes?: readonly LiveChange<T>[]): void => {
        if (changes !== undefined) return forward(changes);
        const fresh = new Map(rows.map((row) => [keyOf(row), row]));
        begin();
        for (const [key, row] of fresh) {
          const before = held.get(key);
          // identity is the change decision: the live layer already kept unchanged rows the same
          if (before === row) continue;
          write(
            before === undefined ? { type: "insert", value: row } : { type: "update", value: row },
          );
        }
        for (const key of held.keys()) if (!fresh.has(key)) write({ type: "delete", key });
        held = fresh;
        // the receipt says when the writes became visible; nothing here waits on that, because
        // the next delivery is driven by the mesh's own fold rather than by this one landing
        void commit();
      };

      const off = live.subscribe(publish);
      void live.ready.then(
        (rows) => {
          publish(rows);
          // ready is coverage, not arrival: an empty local store answers instantly, and drawing
          // "nothing here" before the relay has spoken is how offline apps lie
          void query.settled().then(markReady, markReady);
        },
        () => markReady(),
      );

      return () => {
        off();
        live.release();
      };
    },
  };

  return { ...options, getKey: keyOf, sync };
}
