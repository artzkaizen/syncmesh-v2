import type { Result as ResultType } from "@syncmesh/result";
import type { SqlDriver } from "@syncmesh/storage";
import type { Identity } from "@syncmesh/wire";

import { Result, TaggedError } from "@syncmesh/result";
import { Temporal } from "@syncmesh/temporal";
import { issueGrant } from "@syncmesh/wire";

import { WORKSPACE } from "./domain.js";

/**
 * Who this install is acting as, and with what authority.
 *
 * **Not the device key, and the difference is the whole of this file.** The device key
 * (`deviceIdentity`) is what *signs*; it is minted once per install and never chosen. The actor is
 * whose name the signature is made under and which rules the manifest applies to it — a thing a
 * person picks, changes, and in a real deployment is told by an authority. Conflating the two is
 * why the tracker shipped with `acct_ada` hard-coded in two files: there was nowhere for the
 * second fact to live.
 *
 * **Both platforms read this module**, because an account chosen on a phone and an account chosen
 * in a tab are the same concept over the same manifest. What stays per-platform is only the
 * screen that does the choosing.
 */

/**
 * The workspace ladder, senior first, as {@link issuesSchema} declares it.
 *
 * Order is load-bearing rather than cosmetic: `role("member")` admits owners and admins too, so
 * this array read left to right is also "can do everything to its right". A picker renders it in
 * this order for the same reason.
 */
export const ROLES = ["owner", "admin", "member", "guest"] as const;

export type Role = (typeof ROLES)[number];

/**
 * What each rung actually changes, in the words of the rules that enforce it.
 *
 * Taken from the manifest rather than invented for a screen: `team` and `member` are
 * `$default: role("admin")` with `read: role("guest")`, `member.update` is
 * `any(owner("id"), role("admin"))`, and a project delete is an admin's. A picker that described
 * roles in general terms would be a second, drifting copy of the schema — this is the schema read
 * out loud, and it lives here rather than on either platform because both pickers ask the same
 * question about the same manifest.
 */
export const ROLE_EXPLAINS = {
  owner:
    "Everything an admin can do. The rung above it exists for the things a workspace has one of.",
  admin:
    "Shapes the workspace: adds people, makes and archives teams, deletes projects and labels.",
  member:
    "Files and edits issues, comments, reacts, makes projects. Can edit their own profile only.",
  guest:
    "Reads everything and changes nothing — a contractor on one project. Writes will be refused.",
} as const satisfies Record<Role, string>;

/** What one line of "go in as" resolves to: a person, and the authority they carry. */
export interface Actor {
  readonly account: string;
  readonly role: Role;
}

/**
 * Who a fresh install is until somebody says otherwise.
 *
 * Ada as an admin, because the seed attributes its comments to her and only an admin may seed —
 * so this is the one pair for which a brand-new database is not immediately a lie.
 */
export const DEFAULT_ACTOR: Actor = { account: "acct_ada", role: "admin" };

/** The role a stored value is not. Kept narrow so a damaged row reads as absent, not as an owner. */
const roleOf = (value: string): Role | undefined =>
  ROLES.find((role): role is Role => role === value);

/**
 * This install's grant, minted locally from the bundled issuer key.
 *
 * **The issuer's private half is in the bundle and that is not production-safe** — the same
 * shortcut `app/identity.ts` documents at length, repeated here because this is now the function
 * that performs it. In a real deployment the body of this call is a round trip: the device asks,
 * an authority holding this key alone decides, and what comes back is bytes the device could not
 * have produced. Nothing above this line would change.
 *
 * What makes the shortcut *useful* rather than merely convenient is that the role is a parameter.
 * A build that can mint itself a guest grant is a build that can show what a guest sees, and the
 * manifest's rules — `member.update` as `any(owner("id"), role("admin"))`, a project delete as
 * admin-only — become things a person can watch bite rather than paragraphs in a schema.
 */
export function actorGrant(
  issuer: Identity,
  { actor, device }: { readonly actor: Actor; readonly device: Identity["peerId"] },
): Uint8Array {
  return issueGrant(issuer, {
    account: actor.account,
    device,
    role: actor.role,
    // SAFETY: the workspace this build runs under, in the documented kind:id form
    partitions: [WORKSPACE] as never,
    validFor: Temporal.Duration.from({ days: 30 }),
    // the real clock: a grant minted at a fixed instant is born expired
    now: Temporal.Now.instant(),
  });
}

/** The chosen actor could not be read or written, so this install cannot say who it is. */
export class ActorUnavailable extends TaggedError("ActorUnavailable")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * **In the database, beside the device key, for the reason `_device` is there.**
 *
 * An actor in `localStorage` or `AsyncStorage` outlives the database it describes: wipe the
 * replica and the app still believes it is Bo, mints a grant for an account whose every write is
 * gone, and reads as a person who has done nothing. A row in the file is absent when the file is,
 * which is the only version of this that stays true across {@link Replica.reset}.
 *
 * It is `_actor` rather than a synced table on purpose. Who *this device* is pretending to be is
 * local by definition — replicating it would broadcast one person's demo choice to every peer in
 * the room and make "switch user" a write other devices fold.
 */
const CREATE = `CREATE TABLE IF NOT EXISTS "_actor" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`;
const READ = `SELECT "value" FROM "_actor" WHERE "key" = 'actor'`;
const WRITE = `INSERT OR REPLACE INTO "_actor" ("key", "value") VALUES ('actor', ?)`;

const unavailable = (message: string) => (cause: unknown) =>
  new ActorUnavailable({ message, cause });

/**
 * Who this install last chose, or `undefined` on a database that has never been asked.
 *
 * The `undefined` is not a failure and the caller must not turn it into {@link DEFAULT_ACTOR}
 * silently — it is precisely the signal that the picker has never run, which is what a first
 * launch needs in order to show it. A *damaged* value reads as `undefined` too, so an install
 * whose row was corrupted asks again rather than booting as whoever the bytes happened to spell.
 */
export function storedActor(
  driver: SqlDriver,
): Promise<ResultType<Actor | undefined, ActorUnavailable>> {
  return Result.tryPromise({
    try: async () => {
      await driver.run(CREATE);
      const held = await driver.all(READ);
      const value = held[0]?.[0];
      if (value === undefined || value === null) return undefined;
      // `account\trole`, because two short opaque strings do not need JSON and a parse that can
      // throw is a boot that can fail on a field nothing validates
      const [account, role] = String(value).split("\t");
      if (account === undefined || account === "" || role === undefined) return undefined;
      const known = roleOf(role);
      return known === undefined ? undefined : { account, role: known };
    },
    catch: unavailable("this install could not read who it is from its own database"),
  });
}

/** Writes the choice down, so the next launch does not ask again. */
export function rememberActor(
  driver: SqlDriver,
  actor: Actor,
): Promise<ResultType<void, ActorUnavailable>> {
  return Result.tryPromise({
    try: async () => {
      await driver.run(CREATE);
      await driver.run(WRITE, [`${actor.account}\t${actor.role}`]);
    },
    catch: unavailable("this install could not write down who it is"),
  });
}

/** Throws the choice away, so the next launch asks. Signing out, with no other consequence. */
export function forgetActor(driver: SqlDriver): Promise<ResultType<void, ActorUnavailable>> {
  return Result.tryPromise({
    try: async () => {
      await driver.run(CREATE);
      await driver.run(`DELETE FROM "_actor" WHERE "key" = 'actor'`);
    },
    catch: unavailable("this install could not forget who it is"),
  });
}
