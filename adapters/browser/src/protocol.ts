/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- this file *is* the thread boundary: a `postMessage` hands over `unknown`, the `kind` is the parse, and a serialized tagged error has no shape until the class that declared it revives (`adapters/sqlite-wasm`'s protocol.ts disables the same two for the same reason) */

import type { ProxyMethod, ProxyResult } from "@syncmesh/drizzle";
import type { Principal } from "@syncmesh/engine";
import type { WirePort } from "@syncmesh/sqlite-wasm";
import type { OperationRow, ReceiptRow, SqlRow } from "@syncmesh/storage";

import {
  EmptyMutation,
  LocalOnly,
  NoGrant,
  PartitionNotGranted,
  PolicyDenied,
  ReadOnlyPartition,
  SchemaViolation,
  StoreFailure,
  UnknownChangeKind,
  UnknownTable,
  WrongPartition,
} from "@syncmesh/engine";
import { TaggedError, createTaggedCatalog } from "@syncmesh/result";

export type { WirePort };

/**
 * A feed the host pushes, rather than a question a client asks.
 *
 * The whole reason this protocol is not the request/reply one `adapters/sqlite-wasm` ships: a
 * live query is a standing interest, and a write in another tab is the host speaking first.
 */
export type Topic =
  | "fold"
  | "ack"
  | "sync"
  | "grant"
  | "writes"
  | "inspect"
  | "forced"
  /**
   * Who the device is acting as, pushed rather than asked.
   *
   * A handler is handed `principal` synchronously and a port answers asynchronously, so a window
   * cannot ask at the moment it needs to know. The origin tells every window instead, at connect
   * and whenever the session changes — which is also the honest shape: the principal is the
   * *device's*, and a window has no session of its own to differ with.
   */
  | "auth";

/** The mesh methods a follower asks for by name; each answers with plain data or throws. */
export type CallPath =
  | "can"
  | "syncOf"
  | "query"
  | "flush"
  | "ready"
  | "settled"
  | "running"
  | "principal";

/** The four reads of the durable write ledger, by the names `OperationsView` already gives them. */
export type LedgerPath = "get" | "byEvent" | "unsettled" | "receiptsOf";

/** A serialized tagged error as {@link failures} revives it: a field bag with no shape until then. */
export type WireFailure = Record<string, unknown>;

export interface CallBody {
  readonly kind: "call";
  readonly path: CallPath;
  readonly args: readonly unknown[];
}

/**
 * Declares a handle — `mesh.on(instance, { as })` — under a number the *client* chose.
 *
 * The client numbers it because `Mesh.on` answers synchronously and a round trip does not, and a
 * port delivers in order: the declaration is always in front of the first statement that names it.
 * What the tab cannot decide locally is whether the instance is sealed to this device, because the
 * key ring is the leader's — so a sealed partition refuses at the first statement rather than at
 * `on`, and the refusal is the same `PartitionSealed` either way.
 */
export interface OpenHandleBody {
  readonly kind: "handle";
  readonly handle: number;
  readonly instance?: string;
  readonly as?: Principal;
}

/**
 * One statement from a follower's Drizzle, headed for the host handle's capture.
 *
 * `begin`, `commit` and `rollback` arrive here too, exactly as Drizzle emits them, which is what
 * makes `db.transaction()` in a tab open a transaction on the leader's connection.
 */
export interface SqlBody {
  readonly kind: "sql";
  readonly handle: number;
  readonly statement: string;
  readonly params: readonly unknown[];
  readonly method: ProxyMethod;
}

/**
 * Opens a host-side scope whose body runs in the tab: `under(id, …)` or `rehearse(…)`.
 *
 * Two messages rather than one call because the body is on the wrong thread — the host enters the
 * scope, the tab's statements flow in under it, and {@link LeaveBody} is what closes it. The host
 * holds the handle for the whole span, so nothing another tab sends can land inside it.
 */
export interface EnterBody {
  readonly kind: "enter";
  readonly handle: number;
  readonly mode: "under" | "rehearse";
  readonly operationId?: string;
  /**
   * The procedure the tab is inside, so the write's durable record carries the name a person
   * used rather than the SQL it turned into.
   *
   * It has to cross the port because of where the two halves live: **the procedures run in the
   * tab and the capture runs on the host.** A window calls `api.issues.move(…)` against its own
   * follower mesh, and every statement that produces travels here as a message — by which point
   * the only thing the host can see is `UPDATE issue SET …`. The name exists on the other side
   * of this message or nowhere.
   */
  readonly label?: string;
}

export interface LeaveBody {
  readonly kind: "leave";
  readonly handle: number;
}

/**
 * One read of the write ledger, answered by the host's own `mesh.operations` or refused.
 *
 * Its own kind rather than another {@link CallPath} because the ledger is a surface that may not
 * be there at all — a mesh over a bare event store keeps none — and "there is no ledger here" is
 * a different sentence from "that row is not in it". A {@link NoWriteLedger} says which.
 */
export interface LedgerBody {
  readonly kind: "ledger";
  readonly path: LedgerPath;
  readonly args: readonly unknown[];
}

/**
 * A read of something this protocol deliberately does not model.
 *
 * The adapter knows the mesh; it does not know what a devtool wants to draw, and encoding that
 * here would make every panel a protocol change. So an inspect ask carries a **name the host's
 * own inspector chose** and an answer this file never inspects — which is why the payload is
 * `unknown` on both ends and why nothing in `@syncmesh/browser` imports `@syncmesh/devtools`.
 *
 * A host that was handed no inspector refuses every one of these with {@link NoInspector}, so a
 * production build is a build where the tab cannot read the mesh's internals at all rather than
 * one where a flag was left unset.
 */
export interface InspectBody {
  readonly kind: "inspect";
  readonly read: string;
  readonly args: readonly unknown[];
}

export interface TopicBody {
  readonly kind: "subscribe" | "unsubscribe";
  readonly topic: Topic;
}

/**
 * What a {@link CallBody} answers with: plain data, and `null` for the calls that answer nothing.
 *
 * Named rather than `unknown` because it is the whole list — the mesh methods a window is allowed
 * to ask for were chosen for this, and one that answered with a class instance would not cross.
 */
export type CallAnswer = boolean | string | null | readonly SqlRow[] | Principal | undefined;

/** What a {@link LedgerBody} answers with — the ledger's own rows, and `undefined` for a miss. */
export type LedgerAnswer =
  | OperationRow
  | readonly OperationRow[]
  | readonly ReceiptRow[]
  | undefined;

/**
 * An inspector's answer, in an envelope this file does not open.
 *
 * Wrapped rather than returned bare so that {@link Answered} stays a closed union: a member typed
 * `unknown` would swallow every other arm and delete the one thing this type is for, which is
 * saying in the type what a host is allowed to say back.
 */
export interface InspectAnswer {
  readonly inspected: unknown;
}

/**
 * Everything a dispatched {@link Ask} can answer with: a call's own answer, a statement's rows, a
 * rehearsal's verdict, a ledger row, an inspector's envelope, or nothing.
 */
export type Answered =
  | CallAnswer
  | ProxyResult
  | LedgerAnswer
  | InspectAnswer
  | { readonly refused: WireFailure }
  | void;

export type Ask =
  | CallBody
  | OpenHandleBody
  | SqlBody
  | EnterBody
  | LeaveBody
  | TopicBody
  | LedgerBody
  | InspectBody;

/** A client's message: an ask paired with the number its reply carries, or the parting word. */
export type ClientMessage = ({ readonly id: number } & Ask) | { readonly kind: "bye" };

/**
 * What the host says. A reply is paired by `id`; an event is not a reply to anything.
 *
 * `commit` is per handle rather than a {@link Topic} because a receipt belongs to the tab whose
 * statement produced it, and the host knows which one that is: it held the handle for that span.
 */
export type HostMessage =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: WireFailure }
  | { readonly kind: "event"; readonly topic: Topic; readonly payload: unknown }
  | { readonly kind: "commit"; readonly handle: number; readonly payload: unknown };

/**
 * The link died with calls still out.
 *
 * Every pending call settles with this rather than hanging, because a tab whose leader closed
 * must re-elect and reconnect, and a promise that never settles is how a UI ends up waiting on a
 * thread that no longer exists.
 */
export class MeshHostGone extends TaggedError("MeshHostGone")<{
  message: string;
}> {}

/** A handle number the host does not hold. Reached by using a handle after the link was replaced. */
export class NoSuchMeshHandle extends TaggedError("NoSuchMeshHandle")<{
  readonly handle: number;
  message: string;
}> {}

/**
 * This origin's mesh keeps no durable write ledger, so there is nothing to read.
 *
 * Distinct from an empty answer on purpose: a window cannot see whether the leader was built over
 * a store or over a bare event log, and a panel that drew "no ledger" as "no writes" would report
 * a mesh that never records anything as one that has never been written to.
 */
export class NoWriteLedger extends TaggedError("NoWriteLedger")<{
  message: string;
}> {}

/**
 * The host serves no inspector, so there is no answer to that read and there never will be.
 *
 * Not a failure to reach the mesh: the mesh is there and answering everything else. A build that
 * passed `serveMesh` no inspector is a build whose tabs cannot read the device's feeds, which is
 * what a production build wants — see {@link InspectBody}.
 */
export class NoInspector extends TaggedError("NoInspector")<{
  readonly read: string;
  message: string;
}> {}

/** The host's own mesh refused the call, and the failure carries no tag of its own. */
export class MeshCallFailed extends TaggedError("MeshCallFailed")<{
  readonly path: string;
  message: string;
}> {}

/**
 * The failures that cross, revived on the tab as the classes it already declares — so
 * `taggedCause(thrown)?._tag === "PolicyDenied"` keeps deciding what it decides today, after a
 * write has been judged on another thread (book ch. 5).
 */
export const failures = createTaggedCatalog([
  MeshHostGone,
  NoSuchMeshHandle,
  MeshCallFailed,
  NoWriteLedger,
  NoInspector,
  StoreFailure,
  PolicyDenied,
  SchemaViolation,
  NoGrant,
  PartitionNotGranted,
  ReadOnlyPartition,
  WrongPartition,
  UnknownTable,
  UnknownChangeKind,
  EmptyMutation,
  LocalOnly,
]);
