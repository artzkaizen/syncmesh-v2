import type { FollowerMesh } from "@syncmesh/browser";
import type { Result as ResultType } from "@syncmesh/result";
import type { SqlDriver, SqlValue } from "@syncmesh/storage";
import type { GrantRegistry, Identity } from "@syncmesh/wire";

import { Result, TaggedError } from "@syncmesh/result";

import type { Actor } from "../actor.js";

import { DEFAULT_ACTOR, actorGrant, forgetActor, rememberActor, storedActor } from "../actor.js";

/**
 * What this install is, told by the worker that holds it to every window of it.
 *
 * **The actor is per install, and in this app the install is a thread nobody can reach.** Who this
 * device acts as is a row in the database (`../actor.ts`), the database is inside the dedicated
 * worker `navigator.locks` elected, and a tab holds a `MessagePort` onto that worker's *mesh* and
 * nothing else. So there is no seam here through which a component could read an actor, and there
 * must not be one it could hold a second copy of: four tabs that each remembered who they were is
 * four windows signing one person's comments under four names, and the log is the place that would
 * say so afterwards.
 *
 * **A `BroadcastChannel`, for the reason `reach.ts` already gives.** That file broadcasts the
 * relay's condition rather than serving it over the mesh port, because a relay is a fact about the
 * *device* and a window is not a device — it is one of several onto one. The actor is the same
 * kind of fact and it is not on `FollowerMesh` for the same reason `transports` is not: issuing a
 * grant is the device's business. A channel is the shape that fits: the worker says it once, and
 * the leader's tab, the follower's tab and a tab opened a minute later all hear the same sentence.
 * A window that arrives late asks, exactly as `watchReach` does.
 *
 * **Switching is a re-register, not a rebuild.** The registry is keyed by device and keeps whichever
 * grant has the newest `issuedAt` (`packages/wire/src/grant-registry.ts`), so minting a fresh one
 * for this same device under a different account supersedes the old one in place. No engine
 * restart, no re-read of state, no resync, and no port torn down — which is why the windows are
 * *told* rather than reloaded. What the mesh signs with never moved: the device key and the account
 * are two different facts and only the second one changed.
 */

/** Who this install is acting as, and whether anybody actually chose it. */
export interface Acting {
  readonly actor: Actor;
  /**
   * Whether a person has chosen, as opposed to this being the default nobody picked.
   *
   * The distinction is what the first launch turns on: `false` means the picker has never run, and
   * the app opens on it rather than on the list. Defaulting silently would make every fresh install
   * Ada and hide the whole feature behind a screen nobody would think to open.
   */
  readonly chosen: boolean;
  /**
   * Why the last attempt to change this did not take, if it did not.
   *
   * Carried in the state rather than returned from a call, because the channel carries facts and
   * not replies: the window that asked hears the same sentence every other window hears, and a
   * picker whose button did nothing has something to show for it.
   */
  readonly failure?: string;
}

/** One origin, one channel. A second app in this origin would name a second one, as D07 does. */
const CHANNEL = "issues:acting";

/** Three asks a window can make, and the two things the worker says back. */
type Said =
  | { readonly ask: true }
  | { readonly enter: Actor }
  | { readonly leave: true }
  | { readonly wipe: true }
  | { readonly tell: Acting }
  | { readonly wiped: true };

/**
 * The grant this install would need could not be minted or would not verify.
 *
 * Fatal only at boot, where it means the device cannot sign anything at all and there is no app to
 * draw. Afterwards it is a refusal to *change* who this is, which leaves the previous actor in
 * place and reaches the screen as {@link Acting.failure}.
 */
export class ActorRefused extends TaggedError("ActorRefused")<{
  message: string;
  cause?: unknown;
}> {}

export interface InstallDeps {
  readonly driver: SqlDriver;
  readonly issuer: Identity;
  readonly device: Identity["peerId"];
  /**
   * This device's own registry, narrowed to the one call that matters.
   *
   * `Pick` rather than the whole of `mesh.grants`, because everything else on it — `grantFor`,
   * `allWires`, `forget` — is a door this module has no business holding open, and the narrowing
   * is what says that in the type rather than in a comment.
   */
  readonly grants: Pick<GrantRegistry, "register">;
  /** Throws this install's database away; see {@link wipeReplica} for what that costs. */
  readonly wipe: () => Promise<void>;
}

const admit = (deps: InstallDeps, actor: Actor): ResultType<unknown, ActorRefused> =>
  deps.grants.register(actorGrant(deps.issuer, { actor, device: deps.device })).mapError(
    (cause) =>
      new ActorRefused({
        message: `this install could not register a grant for ${actor.account} as ${actor.role}: ${cause.message}`,
        cause,
      }),
  );

/**
 * Reads who this install last chose, mints its grant, and answers every window that asks after.
 *
 * Called by the worker and by nothing else. The returned {@link Acting} is the boot state — what
 * the first window will be told the moment it asks — and the error is the one case where there is
 * no app: a device whose own grant will not register cannot sign a write, so seeding, filing and
 * commenting would all fail one layer down with a sentence about policy rather than about this.
 *
 * **Written down before it is registered**, on the way in and on every switch. An install that
 * registered a grant it had not recorded would come back after a crash as whoever it was before,
 * having already made writes under the new name; recording first means the worst case is an
 * install that knows who it is and re-registers on the next boot, which is what a boot does anyway.
 */
export async function serveInstall(deps: InstallDeps): Promise<ResultType<Acting, ActorRefused>> {
  // a read that *fails* is not a read that came back empty, and neither is fatal: the app opens as
  // the default and the picker is shown, which is what an install with a damaged row should do
  const remembered = (await storedActor(deps.driver)).unwrapOr(undefined);
  let held: Acting = { actor: remembered ?? DEFAULT_ACTOR, chosen: remembered !== undefined };
  const opened = admit(deps, held.actor);
  if (opened.isErr()) return opened;

  const channel = new BroadcastChannel(CHANNEL);
  const say = (next: Acting): void => {
    held = next;
    channel.postMessage({ tell: next } satisfies Said);
  };

  const enter = async (actor: Actor): Promise<void> => {
    const written = await rememberActor(deps.driver, actor);
    if (written.isErr()) {
      say({ ...held, failure: written.error.message });
      return;
    }
    const admitted = admit(deps, actor);
    say(admitted.isErr() ? { ...held, failure: admitted.error.message } : { actor, chosen: true });
  };

  /**
   * Signing out forgets the choice and leaves the grant standing, which is the honest pair.
   *
   * There is nothing to revoke: the grant is this device's own and every write it already made is
   * in a log that replays forever. What signing out means here is that the next launch asks again
   * — so `chosen` goes false, the picker comes up, and whatever is chosen there supersedes this.
   */
  const leave = async (): Promise<void> => {
    const forgotten = await forgetActor(deps.driver);
    say(
      forgotten.isErr()
        ? { ...held, failure: forgotten.error.message }
        : { actor: held.actor, chosen: false },
    );
  };

  channel.onmessage = (event) => {
    // SAFETY: the only other end of this channel is the window half below, in this same bundle
    const message = event.data as Said;
    if ("ask" in message) channel.postMessage({ tell: held } satisfies Said);
    else if ("enter" in message) void enter(message.enter);
    else if ("leave" in message) void leave();
    else if ("wipe" in message)
      void deps.wipe().then(() => channel.postMessage({ wiped: true } satisfies Said));
  };

  /**
   * Said once, unprompted, the moment there is something to say — **and the ask is kept as well.**
   *
   * The two cover opposite races and neither covers both. A window's `watchActing` runs on mount,
   * which on a cold boot is *before* this worker has opened its end: the channel does not queue for
   * a listener that does not exist yet, so that ask is dropped and a tab that only asked would wait
   * for ever on a worker that was going to answer. A window opened a minute later has the reverse
   * problem and is why the ask exists. Measured: the boot screen sat on "reaching this origin's
   * mesh" indefinitely with an ask and no tell.
   */
  channel.postMessage({ tell: held } satisfies Said);
  return Result.ok(held);
}

/**
 * One channel per window for everything it says, rather than one per act.
 *
 * A `BroadcastChannel` closed in the same turn it posted is a message the specification allows to
 * be dropped, and "sign in as Bo" silently doing nothing is the worst failure this screen has.
 * Opened on the first ask so a tab that never touches the picker never opens one at all.
 */
let speaking: BroadcastChannel | undefined;

const say = (message: Said): void => {
  speaking ??= new BroadcastChannel(CHANNEL);
  speaking.postMessage(message);
};

/**
 * Acts as somebody else from the next write onward, for **this install** and not for this window.
 *
 * Nothing is returned and nothing is awaited: what comes back is the next {@link Acting} on the
 * channel, in this window and in every other one at the same moment. A tab that quietly disagreed
 * with its neighbour about who was writing is the failure the whole channel exists to prevent.
 */
export const enterAs = (actor: Actor): void => say({ enter: actor });

/** Forgets the choice, so the picker comes back. The log and this device's key are untouched. */
export const leaveWorkspace = (): void => say({ leave: true });

/**
 * Deletes this origin's database and everything in it, then tells every window to reload.
 *
 * The log is the durable thing and it lives on the peers too, so this loses nothing that was
 * acknowledged — it makes this device new again, which is the only way to watch a first sync more
 * than once. Anything written here that no peer has carried yet *is* lost, which is why it is a
 * deliberate act behind a confirmation and not a recovery path.
 */
export const wipeReplica = (): void => say({ wipe: true });

/** The current state, and every one after it. Starts with whatever the worker last said. */
export function watchActing(listener: (acting: Acting) => void): () => void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event) => {
    // SAFETY: the only other end of this channel is `serveInstall` in this same bundle
    const message = event.data as Said;
    if ("tell" in message) listener(message.tell);
  };
  channel.postMessage({ ask: true } satisfies Said);
  return () => channel.close();
}

/**
 * The database this window was reading is gone, and the only honest next frame is a fresh boot.
 *
 * Its own subscription rather than a case inside {@link watchActing}, because a reload is not a
 * state to render: a watcher that navigated would be a watcher every caller has to read twice.
 * Every window hears it, because every window was reading the file that was just removed.
 */
export function onWiped(listener: () => void): () => void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event) => {
    // SAFETY: the only other end of this channel is `serveInstall` in this same bundle
    const message = event.data as Said;
    if ("wiped" in message) listener();
  };
  return () => channel.close();
}

/** How much this device is holding, for reading a sync duration against the work it covered. */
export interface Scale {
  readonly events: number;
  readonly rows: number;
  /** The log's own bytes — `sum(length(core))`, so a compaction is visible as a number going down. */
  readonly bytes: number;
}

/**
 * A count over a log, which is `NULL` on an empty one and a `SqlValue` in every other case.
 *
 * Converted here because here is the boundary: `mesh.query` answers in the driver's vocabulary —
 * text, blobs, `NULL` — and nothing above this line should have to know that `sum` over no rows is
 * not zero. A value that is not a number at all reads as zero rather than as `NaN` on screen.
 */
const tally = (value: SqlValue | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Three `count(*)`s over the origin's database, read across the port like any other query.
 *
 * Deliberately **not** live and deliberately not on {@link Acting}: it is a full scan of the log,
 * which is a real cost and a number nobody watches tick. The settings screen asks once when it
 * opens, which is the moment somebody wanted to know.
 *
 * `undefined` where the mesh serves no `query` at all — a mesh over a bare event store — which
 * this app never builds, but the surface says so rather than asserting.
 */
export async function scaleOf(mesh: FollowerMesh): Promise<Scale | undefined> {
  const counted = await mesh.query?.("SELECT count(*), sum(length(core)) FROM events");
  const stored = await mesh.query?.("SELECT count(*) FROM state_rows");
  if (counted === undefined || stored === undefined) return undefined;
  return {
    events: tally(counted[0]?.[0]),
    bytes: tally(counted[0]?.[1]),
    rows: tally(stored[0]?.[0]),
  };
}
