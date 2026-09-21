/* oxlint-disable anti-slop/no-unknown-parameters -- the far side of a `postMessage`: every argument arrives as `unknown` and the path is the parse, exactly as in protocol.ts */

import type { Row as WireCells } from "@syncmesh/kernel";
import type { SqlValue } from "@syncmesh/storage";

import type { HostMesh } from "./host.js";
import type { CallAnswer, CallPath } from "./protocol.js";

/**
 * The eight mesh methods a window may ask for by name, answered on the thread that has them.
 *
 * Beside `host.ts` rather than inside it because this is the *vocabulary* and that is the
 * *machinery*: a method added here is a line, and `serveMesh` does not grow.
 */

/** An argument the caller did not pass: `null` on the wire, `undefined` to the method. */
const absent = <T>(value: unknown): T | undefined =>
  // SAFETY: the client posts each argument as its own typed method received it, or `null` for none
  value === null || value === undefined ? undefined : (value as T);

export const answer = async (
  mesh: HostMesh,
  path: CallPath,
  args: readonly unknown[],
): Promise<CallAnswer> => {
  // SAFETY: each argument is what the client's own typed method took before it was posted — `Api`
  // types every call site — and a message from anywhere else is a page shouting into a worker it
  // does not own. An absent argument travels as `null`, because a hole in a posted array is one.
  const [first, second, third] = args as [string, string, string];
  if (path === "can")
    return mesh.can(
      // SAFETY: `can` takes `"table.op"`, which is the only thing the client's own `can` accepts
      first as `${string}.${string}`,
      absent<WireCells>(second),
      absent<string>(third),
    );
  if (path === "query") return (await mesh.query?.(first, absent<SqlValue[]>(second))) ?? [];
  if (path === "principal") return mesh.auth.principal();
  if (path === "self") return mesh.engine.peerId;
  // the boolean rather than the stamp: a `Temporal.Instant` does not cross as itself, and neither
  // half of the stamp is a window's to draw — see the `"deleted"` path in protocol.ts
  if (path === "deleted") return mesh.deletedAt(first, second) !== undefined;
  if (path === "running") return mesh.running();
  if (path === "flush") await mesh.flush();
  if (path === "ready") await mesh.ready();
  if (path === "settled") await mesh.settled();
  return null;
};
