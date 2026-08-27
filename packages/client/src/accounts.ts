import type { Author, Dispute, Engine, MutateError, StateLookup } from "@syncmesh/engine";
import type { InvalidPartitionKey, PartitionKey, PeerId, SyncEvent } from "@syncmesh/kernel";
import type { Temporal } from "@syncmesh/temporal";
import type { GrantRegistry, Identity } from "@syncmesh/wire";

import {
  disputes as disputesOf,
  linkDevice,
  linkedAuthor,
  links,
  unlinkDevice,
} from "@syncmesh/engine";
import { getRecord, parsePartitionKey, readRow } from "@syncmesh/kernel";
import { Result, panic } from "@syncmesh/result";

/**
 * The client's half of the account layer (D21): the one place a device is turned into somebody.
 *
 * Two callers, one answer. `can` needs the principal the validator would build, or a button
 * disagrees with the write behind it; `history` and presence need the account to attribute a
 * write to, which is a weaker question and outlives the grant that answered it. Both go through
 * here so neither can grow its own idea of who a peer is — the divergence this codebase has
 * already paid for once with synced policy docs.
 */

/** What writing a link can fail with: an instance that is not one, or the ladder refusing the row. */
export type AccountWriteError = InvalidPartitionKey | MutateError;

/** `mesh.accounts`: vouching for a device, and the disagreements that are only ever reported. */
export interface MeshAccounts {
  /**
   * Binds **this** device to the configured account in one instance, as a row every peer folds.
   *
   * Only the device being claimed may write it — the account's signature is in the row, the
   * device's is the event — so there is nobody to register with and nothing to await. Panics
   * unless `createMesh` was given `accountKey`.
   */
  readonly link: (instance: string) => Promise<Result<SyncEvent, AccountWriteError>>;
  /**
   * Ends a link. `device` defaults to this one; naming another is how an account drops a device
   * it cannot reach, which is the case a stolen phone leaves you with.
   */
  readonly unlink: (
    instance: string,
    device?: PeerId,
  ) => Promise<Result<SyncEvent, AccountWriteError>>;
  /** Links a held grant contradicts — surfaced, never resolved, because a row cannot be un-folded. */
  readonly disputes: () => readonly Dispute[];
}

/**
 * The shipped half, read off `MeshOptions` unchanged. `issuer` decides the arm, not a separate
 * flag: it is the same test `validatorFor` makes when it passes `grantFor: null`, and two tests
 * for one question is how `can` and `validate` drift apart.
 */
export interface AccountsConfig {
  readonly identity: Identity;
  readonly issuer?: PeerId;
  readonly accounts?: boolean;
  readonly accountKey?: Identity;
}

/** The booted parts one mesh lends its account layer. */
export interface AccountsDeps {
  readonly engine: Engine;
  /** `all` as well as `grantFor`: attribution outlives the authority a grant once carried. */
  readonly grants: Pick<GrantRegistry, "all" | "grantFor">;
  readonly now: () => Temporal.Instant;
}

/** The state the validator reads, read the same way — nothing here sees a state it does not. */
const lookupOf = (engine: Engine): StateLookup => ({
  row: (table, key) => readRow(engine.state(), table, key),
  partition: (table, key) => getRecord(engine.state(), table, key)?.partition,
  records: (table) => engine.state().get(table),
});

/**
 * The account layer over one booted engine: the surface `mesh.accounts` is, plus the two
 * resolvers the mesh wires into `can`, `history` and presence.
 */
export function openAccounts(config: AccountsConfig, deps: AccountsDeps) {
  const { engine, grants, now } = deps;
  const { identity, accountKey } = config;
  const granted = config.issuer !== undefined;
  const accounts = config.accounts === true;
  const lookup = lookupOf(engine);

  /**
   * The account this device's own links agree on, verified row by row.
   *
   * A link is scoped to an instance, so a device asked about with no instance in hand can only
   * be answered where every instance says the same thing: two instances naming two accounts is
   * a device that is one person here and another there, and picking one of them would be a
   * coin toss rendered as a fact.
   */
  const linkedAccount = (peer: PeerId): string | undefined => {
    let found: string | undefined;
    for (const held of links(engine)) {
      if (!held.linked || held.device !== String(peer)) continue;
      const partition = parsePartitionKey(held.partition).unwrapOr(undefined);
      // the bytes, not the columns: a `_links` row can arrive in a snapshot no validator judged
      const author =
        partition === undefined
          ? undefined
          : linkedAuthor({ peerId: peer, partition, changes: [] }, lookup);
      if (author === undefined) continue;
      if (found !== undefined && found !== author.account) return undefined;
      found = author.account;
    }
    return found;
  };

  /**
   * The account a device belongs to, for attributing what it wrote (D21). No flag: this half is
   * right in every mesh, and reading it wrong is a wrong name on a screen rather than a verdict.
   *
   * **Grants first, and `all` rather than `grantFor`** — a lapsed grant still names the account
   * it was minted for, and old history is exactly what a lapsed grant is needed to attribute.
   * A device nothing has ever said anything about stays `undefined`: rendering its own hex would
   * put a device id in the same 64-hex namespace accounts live in, indistinguishable from a real
   * account to the first `allow` rule written against it.
   */
  const accountOf = (peer: PeerId): string | undefined => {
    const held = grants.all().find((grant) => grant.device === peer);
    return held === undefined ? linkedAccount(peer) : held.account;
  };

  /**
   * Who this device writes as, resolved exactly as `checkAuthor` resolves it: the grant where an
   * issuer is configured, the instance's link where none is and accounts are on, nobody
   * otherwise. Deriving it any other way is how `can` answers false for a write the validator
   * would admit — the whole property `can` exists to have.
   */
  const author = (partition?: PartitionKey): Author | undefined => {
    if (granted) return grants.grantFor(identity.peerId);
    if (!accounts) return undefined;
    if (partition !== undefined)
      return linkedAuthor({ peerId: identity.peerId, partition, changes: [] }, lookup);
    // no instance named, so no single link to read: only an answer every instance shares
    const account = linkedAccount(identity.peerId);
    return account === undefined ? undefined : { account, claims: {} };
  };

  const write = (instance: string, device: PeerId, op: "link" | "unlink") => {
    // outside the generator: a mesh with no account key was configured wrong, not asked wrongly
    const account =
      accountKey ??
      panic("createMesh was not given accountKey; only the account itself can vouch for a device");
    return Result.gen(async function* () {
      const partition = yield* parsePartitionKey(instance);
      const link = { account, device, partition, at: now() };
      const written = yield* Result.await(
        op === "link" ? linkDevice(engine, link) : unlinkDevice(engine, link),
      );
      return Result.ok(written);
    });
  };

  const meshAccounts: MeshAccounts = {
    link: (instance) => write(instance, identity.peerId, "link"),
    unlink: (instance, device = identity.peerId) => write(instance, device, "unlink"),
    disputes: () => disputesOf(engine, grants.grantFor),
  };

  return { accounts: meshAccounts, accountOf, author };
}
