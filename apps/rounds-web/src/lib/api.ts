import type { JsonValue } from "@syncmesh/kernel";
import type { AuthorityDef, MutationDef, QueryDef, WriteResult } from "@syncmesh/orpc";

import { createServerFn } from "@tanstack/react-start";

import type { procedures } from "../rounds.js";

/**
 * The browser's half: one server function carrying a path and an input.
 *
 * A browser has no SQLite — `sqlite-wasm` over OPFS is unbuilt (E04) — so it cannot hold the
 * ward's partition and cannot run a read locally. What it can do is call the very procedures a
 * phone runs in-process, against a mesh on the server that *does* hold the partition and *is* on
 * the relay. One definition of the API, two ways of reaching it.
 *
 * The mesh is imported **inside** the handler. A top-level import would pull SQLite and the relay
 * into the browser graph, and the point of this file is that they never arrive there.
 */
/* oxlint-disable anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- this file is the wire: JSON arrives untyped and a proxy forwards paths it cannot name, and `RemoteApi` is where every one of them regains its type */

/**
 * What the server function answers with — the handler's envelope, not a procedure's shape.
 *
 * `JsonValue` rather than `unknown`, because that is what actually crosses: the server function's
 * own serialiser will not take a type it cannot promise to write.
 */
interface Answer {
  readonly data?: JsonValue;
  readonly error?: string;
}

const call = createServerFn({ method: "POST" })
  .inputValidator((body: { readonly path: string; readonly input?: unknown }) => body)
  .handler(async ({ data }): Promise<Answer> => {
    const { handle } = await import("../server/mesh.js");
    const response = await handle(
      new Request("http://local/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      }),
    );
    const payload = (await response.json()) as Answer;
    if (payload.error !== undefined) throw new Error(payload.error);
    return payload;
  });

/**
 * The same procedures, as promises.
 *
 * Every return type is read off the procedure that produces it, so nothing here is cast and a
 * page that misreads a row does not compile. A query hands back its rows; a mutation hands back
 * the `{ eventId, data }` it always does. What is missing, deliberately, is `QueryCall` — a live
 * read is a fold on the device holding the log, and this browser holds nothing.
 */
export type RemoteApi<R> = {
  readonly [K in keyof R]: R[K] extends QueryDef<infer I, infer T>
    ? (input: I) => Promise<readonly T[]>
    : R[K] extends MutationDef<infer I, infer T>
      ? (input: I) => Promise<WriteResult<Awaited<T>>>
      : R[K] extends AuthorityDef<infer I, infer T>
        ? (input: I) => Promise<T>
        : R[K] extends object
          ? RemoteApi<R[K]>
          : never;
};

const remote = (path: string): unknown =>
  new Proxy(() => undefined, {
    get: (_target, key: string) => remote(path === "" ? key : `${path}.${key}`),
    apply: (_target, _self, [input]: readonly unknown[]) =>
      call({ data: { path, input } }).then((answer) => answer.data),
  });

export const api = remote("") as RemoteApi<typeof procedures>;
/* oxlint-enable anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion */
