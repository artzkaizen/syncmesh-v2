import { TaggedError } from "@syncmesh/result";

/**
 * There is no rendezvous for this origin, and this tab is not the one holding the mesh.
 *
 * A `SharedWorker` is the only singleton a browser gives an origin, and a follower tab needs one:
 * it cannot address another tab's dedicated worker, and nothing else in the platform will
 * introduce them. Where there is none, the origin falls back to **one durable tab** — the elected
 * one works, every other one gets this, and the remedy is a sentence on screen rather than a
 * retry, which is the same rule the storage badge follows.
 *
 * Distinct from a host that went away, which is not an error at all: that is `onLost` firing on a
 * link that was real, followed by a new election. This is a link that was never possible. The
 * three reasons are three different sentences and one remedy:
 *
 * - `"unsupported"` — the platform has no `SharedWorker` constructor. Chrome on Android is the
 *   case this exists for, and no flag, version or header changes it.
 * - `"refused"` — the constructor is there and threw: a Content-Security-Policy without
 *   `worker-src`, or a bundler that did not emit the rendezvous module beside the one naming it.
 * - `"declined"` — the caller passed `rendezvous: false` and asked for single-tab mode.
 */
export class NoRendezvous extends TaggedError("NoRendezvous")<{
  readonly reason: "unsupported" | "refused" | "declined";
  message: string;
  cause?: unknown;
}> {}

/**
 * This context has no `navigator.locks`, so no tab of this origin can be elected.
 *
 * Reported rather than assumed away, because the assumption is the dangerous one: a tab that
 * cannot ask who the leader is and hosts anyway is the second engine over one log this whole
 * design exists to prevent. `navigator.locks` is present wherever OPFS is — both want a secure
 * context — so in practice this is a page served over plain `http:` to something other than
 * `localhost`, where the database could not have been durable either.
 */
export class NoElection extends TaggedError("NoElection")<{
  message: string;
}> {}

/**
 * The dedicated worker that would have held this tab's mesh could not be started.
 *
 * The factory in {@link MeshLinkOptions.worker} threw: a Content-Security-Policy without
 * `worker-src`, or a bundler that did not follow
 * `new Worker(new URL("./…", import.meta.url), { type: "module" })`. Distinct from a worker that
 * started and could not elect, which is {@link NoElection}.
 */
export class HostWorkerUnavailable extends TaggedError("HostWorkerUnavailable")<{
  cause?: unknown;
}> {}

/** Every way a tab fails to reach a mesh host, and they are three separate facts. */
export type MeshLinkFailure = HostWorkerUnavailable | NoElection | NoRendezvous;
