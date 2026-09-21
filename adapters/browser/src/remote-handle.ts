import type { Handle } from "@syncmesh/client";
import type { LiveSource, ProxyMethod, ProxyResult, Span, WriteNaming } from "@syncmesh/drizzle";
import type { Principal, ValidatorSchema } from "@syncmesh/engine";
import type { PartitionKey } from "@syncmesh/kernel";
import type { SqlWriteError } from "@syncmesh/storage";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import { createLive, readPredicate, readScope } from "@syncmesh/drizzle";
import { Result } from "@syncmesh/result";
import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { WireFailure } from "./protocol.js";
import type { MeshWire } from "./wire.js";

import { failures } from "./protocol.js";

export interface RemoteHandleDeps {
  readonly wire: MeshWire;
  /** The number this tab chose for the handle and declared to the host. */
  readonly handle: number;
  readonly schema: ValidatorSchema;
  /** The feed a live query re-runs on: fold batches that crossed the port. */
  readonly source: LiveSource;
  readonly partition?: PartitionKey;
  readonly actor?: Principal;
}

/** The verdict a rehearsal comes back as: absent for a rehearsal nothing refused. */
interface Verdict {
  readonly refused?: WireFailure;
}

/**
 * `mesh.on(…)` in a tab that is not the leader: the same `db`, `read` and `live`, over a port.
 *
 * **Reads cross as SQL and are answered from the leader's database. There is no per-tab mirror,**
 * and that was measured rather than assumed. The alternative LiveStore takes is an in-memory
 * SQLite per tab, kept current by replaying the log into it, which makes a re-run a function call
 * instead of a message. The worry it answers is real — a live query re-runs its *whole* read on
 * every fold, so "one statement, once" is the wrong profile to judge it by. So `bench/browser`
 * runs the same Drizzle query over the same database both ways:
 *
 * ```
 * empty round trip over a MessageChannel: 0.0023 ms
 *
 * | rows | in process | over the port | difference |
 * |    1 | 0.0111 ms  | 0.0129 ms     | +0.0018 ms |
 * |   10 | 0.0100 ms  | 0.0174 ms     | +0.0074 ms |
 * |  100 | 0.0249 ms  | 0.0596 ms     | +0.0347 ms |
 * | 1000 | 0.1940 ms  | 0.4220 ms     | +0.2281 ms |
 * ```
 *
 * A hundred-row list costs **+0.035 ms** per re-run — a browser's page↔worker hop is dearer than
 * bun's in-process one (0.0142 ms against 0.0023 ms, §2), so call it +0.05 ms there. A tab whose
 * every fold re-runs twenty such queries pays a millisecond. It does not scale *per row* the way
 * the objection assumes, because a statement and its whole result set are one round trip: the
 * thousand-row row is 2.2× in process, and a query that returns a thousand rows to a list on a
 * screen is a bug about the query.
 *
 * What a mirror buys back is that 0.035 ms, and what it charges for it is two things this design
 * has already refused: a second materialised copy of every table in every tab, and a second fold
 * pipeline keeping it current — which is a second engine over one log arriving through the back
 * door as a "cache". One engine per origin means one database per origin, and a tab reads from it.
 *
 * What a write does is the same trick read backwards. Drizzle's proxy hands its callback
 * `(statement, params, method)` and tells it nothing about who asked, so `db.transaction()` here
 * posts `begin`, the statements, and `commit` — and the *host* feeds them into its handle's
 * capture. The event is signed by the leader's identity and numbered in the leader's log, which
 * is the whole point: the tab wrote, the origin's one device is the author.
 */
export function remoteHandle(deps: RemoteHandleDeps): Handle {
  const { wire, handle, schema, source, partition, actor } = deps;

  const send = (
    statement: string,
    params: readonly unknown[],
    method: ProxyMethod,
    span?: number,
  ): Promise<ProxyResult> =>
    wire.ask<ProxyResult>({
      kind: "sql",
      handle,
      statement,
      params,
      method,
      ...(span !== undefined && { span }),
    });

  /** The shared sink: an ordinary read, belonging to no span and never landing inside one. */
  const sql = (
    statement: string,
    params: readonly unknown[],
    method: ProxyMethod,
  ): Promise<ProxyResult> => send(statement, params, method);

  const db = drizzle((statement, params, method) => sql(statement, params, method));
  const scoping = { schema };
  if (partition !== undefined) Object.assign(scoping, { partition });
  if (actor !== undefined) Object.assign(scoping, { actor });
  const scope = readScope("sqlite", scoping);
  const read = <T extends SQLiteTable>(table: T) => {
    const name = getTableName(table);
    return db.select().from(table).where(readPredicate(name, scope)).as(name);
  };

  /** This tab's spans on this handle, queued: see {@link scoped} for why there is a queue. */
  let spans = Promise.resolve();
  /** Names this tab's spans apart on the wire; only ever compared for equality by the host. */
  let minted = 0;
  /** The span this tab is inside, if any — one at a time, which is what `scoped` guarantees. */
  let inside: number | undefined;

  /**
   * A host-side scope whose body runs here: the host enters it, holds the handle for the whole
   * span so no other tab's statement can land inside, and closes it when `leave` arrives.
   *
   * **One span at a time from this tab, and the queue is not an optimisation.** The host lets the
   * tab that is *already holding* the turn straight through, because that is exactly what the
   * body's own statements need — so two spans opened in one tick are both let in, the second
   * overwrites the open scope the first is waiting on, and the first is never closed by anything.
   * The handle it wedges is the origin's only one, so every other tab's next statement queues
   * behind it for ever. A detail panel that rehearses a delete while an effect counts a view is
   * precisely that tick. In process a `Handle` serialises `under` and `rehearse` for the same
   * reason; this is that rule kept across a port, on the side that knows it opened two.
   */
  const scoped = async <T>(
    mode: "under" | "rehearse",
    run: () => Promise<T>,
    named: WriteNaming = {},
  ) => {
    const ahead = spans;
    let finished!: () => void;
    spans = new Promise<void>((resolve) => {
      finished = resolve;
    });
    await ahead;
    const token = (minted += 1);
    inside = token;
    try {
      const body = { kind: "enter", handle, mode, span: token } as const;
      await wire.ask({
        ...body,
        ...(named.id !== undefined && { operationId: named.id }),
        ...(named.label !== undefined && { label: named.label }),
      });
      let thrown: unknown;
      let value: T | undefined;
      try {
        value = await run();
      } catch (cause) {
        thrown = cause;
      }
      const verdict = await wire.ask<Verdict | null>({ kind: "leave", handle });
      return { thrown, value, verdict };
    } finally {
      inside = undefined;
      finished();
    }
  };

  const under = async <T>(named: WriteNaming, run: () => Promise<T>): Promise<T> => {
    const { thrown, value } = await scoped("under", run, named);
    if (thrown !== undefined) throw thrown;
    // SAFETY: `run` resolved, so `value` is its `T`; the only path that leaves it unset threw
    return value as T;
  };

  /**
   * The span's own sink: the same statements, tagged with the span they belong to.
   *
   * The authorship is still the host's to assign, but *which* of this tab's statements are the
   * span's is only knowable here. "Everything arriving from this tab" is what the host used to
   * assume, and it is one tick away from being wrong: a detail panel rehearses a delete while its
   * own `issues.get` reads, both from this tab, and the read was fed into the rehearsal's
   * transaction — answering out of rows the rehearsal had staged and would roll back, so a panel
   * said "not on this device" about a row sitting in the list beside it. Tagging is what lets the
   * host place a statement by the sink it came through rather than by who sent it.
   */
  const span = (): Span<typeof db> => {
    const token = inside;
    if (token === undefined) return { db, sql };
    const into = (statement: string, params: readonly unknown[], method: ProxyMethod) =>
      send(statement, params, method, token);
    return {
      db: drizzle((statement, params, method) => into(statement, params, method)),
      sql: into,
    };
  };

  const rehearse = async (
    open: (scope: Span<typeof db>) => Promise<void>,
  ): Promise<Result<void, SqlWriteError>> => {
    const { thrown, verdict } = await scoped("rehearse", () => open(span()));
    // a body that threw never reached the judging, and must surface as itself — the same way it
    // does in process, where `rehearse` lets the throw out past its own rollback
    if (thrown !== undefined) throw thrown;
    const refused = verdict?.refused;
    if (refused === undefined) return Result.ok(undefined);
    // SAFETY: the host serialized a `SqlWriteError` here, and the catalog revives every tag it wears
    return Result.err(failures.revive(refused) as SqlWriteError);
  };

  return {
    db,
    sql,
    span,
    read,
    live: createLive(source),
    onCommit: (listener) => wire.onCommit(handle, listener),
    under,
    rehearse,
  };
}
