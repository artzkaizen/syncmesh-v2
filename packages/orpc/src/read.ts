import type { Handle } from "@syncmesh/client";
import type { Runnable } from "@syncmesh/drizzle";
import type { PresenceMap } from "@syncmesh/schema";

import { LOCAL_ONLY } from "@syncmesh/client";
import { Result } from "@syncmesh/result";

import type { QueryCall, ReadAnswer } from "./api.js";
import type { LazyApiMesh } from "./deferred.js";
import type { QueryDef } from "./procedures.js";

import { deferredLive, deferredRunnable, deferredSubscribe } from "./deferred.js";
import { asError } from "./errors.js";
import { validate } from "./validate.js";

/* oxlint-disable anti-slop/no-unknown-parameters -- `input` here is the call's own argument on its way to `validate`, which is the parser: the surface above (`Api<R>`) is typed per procedure, and parsing before the procedure that owns the schema has been chosen would be parsing twice */

/** What a read is built over: the mesh as it may not be there yet, and this api's way of running a query body. */
interface ReadDeps<PC extends PresenceMap> {
  readonly lazy: LazyApiMesh<PC>;
  /** The replica the raw input names, opened per call. */
  readonly handle: (input: unknown) => Handle;
  readonly running: (
    def: QueryDef<never, unknown>,
    parsed: never,
    input: unknown,
  ) => Runnable<unknown>;
  readonly settled: () => Promise<void>;
}

/** One read descriptor: `then` in front, the adapter surface under `~mesh` ({@link QueryCall}). */
export function readOf<PC extends PresenceMap>(
  { lazy, handle, running, settled }: ReadDeps<PC>,
  path: string,
  def: QueryDef<never, unknown>,
  input: unknown,
): QueryCall<unknown> {
  /* thrown, not returned: a live query has no error channel of its own, and the hook has an `error` */
  const runnable = () => running(def, validate<never>(def.schema, input).unwrap(), input);
  // the real builder the moment there is one: `windowOf` reads a Drizzle query's own config to
  // decide whether the query can be maintained, and a stand-in has none to read. Only a call
  // made before the mesh exists gets the wrapper, and that one has nothing to maintain from
  const run = () =>
    lazy.current() === undefined ? deferredRunnable(lazy.ready, runnable) : runnable();
  // one shared object, never a literal: a mesh reached over a port has no coverage yet, and a
  // fresh `{ kind }` per call here is exactly the snapshot loop React refuses
  const coverage = () => lazy.current()?.coverage?.get() ?? LOCAL_ONLY;
  // parsed before anything waits, so a refused input is this Result's Err rather than a throw
  // inside a runner; the coverage is read after the rows land, so it is what they are good to
  const answer = async () => {
    const parsed = validate<never>(def.schema, input);
    if (parsed.isErr()) return parsed;
    return Result.tryPromise({
      try: async (): Promise<ReadAnswer<unknown>> => {
        await lazy.ready;
        return { data: await running(def, parsed.value, input), coverage: coverage() };
      },
      catch: asError,
    });
  };
  return {
    "~mesh": {
      path,
      key: JSON.stringify([path, input ?? null]),
      run,
      // TEMPORARY, for a bisect: one built query rather than the *way to build* it, which is what
      // turns incremental maintenance off — `createLive` only patches a query it can ask again.
      // Restore the factory (`runnable`) once the assignee stall is attributed.
      live: () => deferredLive(lazy, () => handle(input).live(runnable())),
      settled: () => lazy.ready.then(settled),
      coverage,
      onCoverage: (listener) =>
        deferredSubscribe(lazy, (m) => m.coverage?.subscribe(listener) ?? (() => undefined)),
    },
    /* oxlint-disable-next-line unicorn/no-thenable -- a read *is* the one thenable surface (book ch. 9): awaiting a descriptor is how application code runs it, and nothing runs at construction */
    then: (onFulfilled, onRejected) => answer().then(onFulfilled, onRejected),
  };
}
/* oxlint-enable anti-slop/no-unknown-parameters */
