import type { Principal } from "@syncmesh/engine";
import type { Temporal } from "@syncmesh/temporal";

/**
 * Who the user is, and how to prove it (book ch. 14) — the session, as distinct from the grant.
 * `auth` says who the *user* is; a grant says whose *events* peers admit. A device needs both,
 * and confusing them is how "acting as" bugs ship.
 *
 * Application calls never name a principal. A device has one caller, and letting a call site
 * pick one is the bug this shape exists to make unrepresentable.
 */

/** Why the provider is being asked. One callback covers all three, so none can be forgotten. */
export interface SessionAsk {
  readonly reason: "initial" | "refresh" | "expired";
  /** When the current credential dies; `null` where the provider does not say. */
  readonly deadline: Temporal.Instant | null;
}

/** What a provider hands back: who is calling, and until when. */
export interface Session {
  readonly principal: Principal;
  readonly expiresAt: Temporal.Instant | null;
}

/**
 * Supplies the session and refreshes it. **Required at construction** when `auth` is used at
 * all, which is the point: Ditto's equivalent is optional-until-sync-start and throws when it
 * is missing, and a mistake that can only be made at runtime is one a type could have refused.
 */
export type SessionProvider = (ask: SessionAsk) => Promise<Session> | Session;

export interface AuthStatus {
  readonly principal: Principal | null;
  readonly expiresAt: Temporal.Instant | null;
}

export interface Auth {
  /** One source of truth for both session logic and the "expires in 4 min" a screen renders. */
  readonly status: () => AuthStatus;
  /** Swaps the credential and wakes whatever was waiting on one. */
  readonly update: (session: Session) => void;
  /**
   * Drops the session. `then` runs **after** the mesh stops syncing and **before** the
   * credential is cleared, so a purge and a credential-clear cannot interleave with new writes.
   */
  readonly signOut: (options?: { readonly then?: () => Promise<void> | void }) => Promise<void>;
  /** Fires when the session changed — a refresh landed, or it was signed out. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The principal every handle acts as by default; `undefined` before the first session. */
  readonly principal: () => Principal | undefined;
}

export interface AuthDeps {
  readonly provider?: SessionProvider;
  readonly now: () => Temporal.Instant;
  /** Stops sync before the credential is dropped; the mesh's own `stop`, wired by the caller. */
  readonly stopSync: () => Promise<void>;
}

export function createAuth(deps: AuthDeps): Auth {
  let held: Session | undefined;
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of listeners) listener();
  };

  const update = (session: Session): void => {
    held = session;
    changed();
  };

  // the initial ask, if a provider was given: a device with no session simply has no caller
  if (deps.provider !== undefined) {
    void Promise.resolve(deps.provider({ reason: "initial", deadline: null })).then(
      update,
      () => undefined,
    );
  }

  return {
    status: () => ({
      principal: held?.principal ?? null,
      expiresAt: held?.expiresAt ?? null,
    }),
    update,
    signOut: async (options = {}) => {
      // order matters: stop, then the caller's purge, then drop — never the other way round
      await deps.stopSync();
      await options.then?.();
      held = undefined;
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    principal: () => {
      if (held === undefined) return undefined;
      // an expired credential is not a caller: the rules would otherwise read a role nobody holds
      if (
        held.expiresAt !== null &&
        deps.now().epochMilliseconds > held.expiresAt.epochMilliseconds
      )
        return undefined;
      return held.principal;
    },
  };
}

/**
 * The session, wired: the provider if the app named one, and the stop that runs before the
 * credential is dropped.
 *
 * Assembled here rather than in the mesh because the *order* is the contract — a credential
 * dropped while a link is still carrying is a link carrying on someone's behalf after they
 * signed out — and an order stated in one place cannot be re-decided in another.
 */
export const openAuth = (
  provider: AuthDeps["provider"] | undefined,
  now: AuthDeps["now"],
  stopSync: NonNullable<AuthDeps["stopSync"]>,
): Auth => {
  const deps = { now, stopSync };
  if (provider !== undefined) Object.assign(deps, { provider });
  return createAuth(deps);
};
