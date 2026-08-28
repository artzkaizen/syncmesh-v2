import type {
  CellValue,
  Change,
  PartitionKey,
  PeerId,
  Procedure,
  RowKey,
  SyncEvent,
} from "@syncmesh/kernel";
import type { TableState } from "@syncmesh/kernel";
import type { AccountCore, Grant, Identity, LinkError } from "@syncmesh/wire";

import { sha256 } from "@noble/hashes/sha2.js";
import { parseAccountId, parsePartitionKey, parsePeerId } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";
import { RESERVED } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import {
  bytesEqual,
  bytesToHex,
  encodeAccountCore,
  signLink,
  splitEnvelope,
  verifyLink,
} from "@syncmesh/wire";

import type { Engine, MutateOptions } from "./engine.js";
import type { LinkRung, MutateError, ValidationError } from "./errors.js";
import type { Tx } from "./tx.js";
import type { Author, ProbeEvent, StateLookup } from "./validate.js";

import { column, moment, text } from "./authority.js";
import { LinkRefused } from "./errors.js";

/**
 * An account vouching for its own devices, as ordinary synced rows (D21). The account signs the
 * link core; the device signs the event that carries it, so one envelope holds both halves of a
 * mutual claim and neither side can make it alone.
 *
 * A link is read at exactly one place — `checkAuthor`, and only where no grant is held. In a
 * mesh with an issuer `owner()` is already cross-device, because the issuer mints every one of
 * Alice's grants with the same `account`; what is missing there is nothing, and what a link
 * must never do is out-rank a configured trust anchor with a key nobody vetted.
 */

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the reserved link table's own name and procedures */
const LINK = "_links.link" as Procedure;
const UNLINK = "_links.unlink" as Procedure;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** The verb as the `kind` column holds it, mirroring the small int the signed core carries. */
const KIND = { link: 0, unlink: 1 } as const;

/**
 * The key a link is filed under: the instance, the device, and the digest of the signed core.
 *
 * The digest is what makes `_links` **append-only**. One row per distinct signed core, written
 * once and never updated, so no two facts ever compete for a key and there is no merge to lose.
 * Filed by `instance:device` alone, two facts would land on one key and settle by HLC stamp —
 * while admission was ordered by the signed `at`. Those two orderings are independent, so a
 * backdated unlink and a later link would leave one peer linked and another unlinked, for good.
 * Replaying an old core writes the row it already wrote, which is the whole of the replay defence.
 */
export const linkKey = (partition: PartitionKey, device: PeerId, core: Uint8Array): RowKey =>
  // SAFETY: keys are opaque text in the kernel; the shape is this module's own and checked below
  `${String(partition)}:${String(device)}:${bytesToHex(sha256(core))}` as RowKey;

/** The three parts back. Device and digest are fixed-width hex, so the instance is whatever precedes them. */
const splitLinkKey = (key: RowKey) => {
  const filed = String(key);
  return {
    partition: filed.slice(0, -130),
    device: filed.slice(-129, -65),
    digest: filed.slice(-64),
  };
};

/** What one link records: which account claims which device, in which instance, from when. */
export interface AccountLink {
  /** The account's own keypair; its public key is the id every peer checks the row against. */
  readonly account: Identity;
  readonly device: PeerId;
  readonly partition: PartitionKey;
  /** From when; defaults to now. A link only ever moves forward — an older `at` is refused. */
  readonly at?: Temporal.Instant;
}

/**
 * Binds a device to an account in one instance, as a signed row every peer folds.
 *
 * Write it **from the device being claimed**: the account's signature is in `wire`, and the
 * device's is the event itself, so a link authored by any other peer is refused everywhere.
 * There is no registry to register with — the row is the binding.
 *
 * ```ts
 * await linkDevice(phone.engine, { account: alice, device: phone.peerId, partition: ACME })
 * ```
 */
export function linkDevice(
  engine: Engine,
  link: AccountLink,
): Promise<Result<SyncEvent, MutateError>> {
  return writeLink(engine, link, "link");
}

/**
 * Ends a link, as the same kind of row. **Any peer may carry it**, because a stolen device will
 * not unlink itself and the account may not be able to reach it — only the account's signature
 * on the core decides, which is why this needs no second verb and no authority.
 *
 * It is not a delete: a delete carries no signature, so nothing would say who ended the link.
 */
export function unlinkDevice(
  engine: Engine,
  link: AccountLink,
): Promise<Result<SyncEvent, MutateError>> {
  return writeLink(engine, link, "unlink");
}

function writeLink(
  engine: Engine,
  link: AccountLink,
  op: AccountCore["op"],
): Promise<Result<SyncEvent, MutateError>> {
  const { account, device, partition } = link;
  const at = link.at ?? Temporal.Now.instant();
  // an identity's peerId is 64 hex by construction, which is exactly the AccountId shape
  const id = parseAccountId(String(account.peerId)).unwrap();
  const wire = signLink(account, { v: 1, op, account: id, device, partition, at });
  const key = linkKey(partition, device, splitEnvelope(wire).unwrap().core);
  const cells = new Map<never, CellValue>([
    [column("id"), String(key)],
    [column("account"), String(id)],
    [column("kind"), KIND[op]],
    [column("at"), at.epochMilliseconds],
    [column("wire"), wire],
  ]);
  return engine.mutate(
    op === "link" ? LINK : UNLINK,
    (tx: Tx) => tx.insert(RESERVED.links, key, cells),
    {
      partition,
    } satisfies MutateOptions,
  );
}

/**
 * The fact that stands for each `(instance, device)`: the latest `at`, with an unlink beating a
 * link that ties, and the account id breaking a tie beyond that so every peer picks the same one.
 *
 * Withdrawal wins a tie because it is the safe answer — the cost of being wrongly unlinked is a
 * device that must be linked again, and the cost of being wrongly linked is somebody else's rows.
 */
const beats = (a: AccountCore, b: AccountCore): boolean => {
  const by = Temporal.Instant.compare(a.at, b.at);
  if (by !== 0) return by > 0;
  if (a.op !== b.op) return a.op === "unlink";
  return String(a.account) < String(b.account);
};

/**
 * One fold of the link facts per version of the table, held against the very map it folded — a
 * table that has not changed has its answer already, and one that has has no entry to find. The
 * shape `syncedRules` uses to parse one policy doc once, for the same reason.
 */
const resolved = new WeakMap<TableState, ReadonlyMap<string, AccountCore>>();

function standing(rows: TableState): ReadonlyMap<string, AccountCore> {
  const held = resolved.get(rows);
  if (held !== undefined) return held;
  const winners = new Map<string, AccountCore>();
  for (const [key, record] of rows) {
    if (record.deleteStamp !== undefined) continue;
    const core = linkOf(key, (name) => record.cells.get(column(name))?.value).unwrapOr(undefined);
    if (core === undefined) continue;
    const pair = `${String(core.partition)}:${String(core.device)}`;
    const before = winners.get(pair);
    if (before === undefined || beats(core, before)) winners.set(pair, core);
  }
  resolved.set(rows, winners);
  return winners;
}

/** A link as a reader sees it; `linked` is false once an unlink has superseded it. */
export interface LinkRow {
  readonly account: string;
  readonly device: string;
  readonly partition: string;
  readonly at: Temporal.Instant;
  readonly linked: boolean;
}

/** Every link this device holds for the instances it syncs, oldest first. */
export function links(engine: Engine): readonly LinkRow[] {
  const rows = engine.state().get(RESERVED.links);
  if (rows === undefined) return [];
  return [...standing(rows).values()]
    .map((core) => ({
      account: String(core.account),
      device: String(core.device),
      partition: String(core.partition),
      at: core.at,
      linked: core.op === "link",
    }))
    .sort((a, b) => Temporal.Instant.compare(a.at, b.at));
}

/** A link and a grant that name different accounts for one device. */
export interface Dispute {
  readonly device: string;
  readonly partition: string;
  /** What the `_links` row claims. */
  readonly linked: string;
  /** What the grant says — and what decides, because a held grant is never second-guessed. */
  readonly granted: string;
}

/**
 * Links contradicted by a grant, reported rather than resolved (D21).
 *
 * A row cannot be un-folded because a grant arrived after it, and a grant is never re-decided by
 * a key nobody vetted, so a disagreement is a fact to surface and not a verdict to change. A
 * grant whose `account` is not itself an account id is not disagreeing at all — an `acct_42`
 * string is not in the 64-hex namespace a link claims — which is why no mesh running today can
 * produce one of these.
 */
export function disputes(
  engine: Engine,
  grantFor: (peer: PeerId) => Grant | undefined,
): readonly Dispute[] {
  const found: Dispute[] = [];
  for (const row of links(engine)) {
    if (!row.linked) continue;
    const device = parsePeerId(row.device).unwrapOr(undefined);
    const grant = device === undefined ? undefined : grantFor(device);
    if (grant === undefined || grant.account === row.account) continue;
    if (parseAccountId(grant.account).isErr()) continue;
    found.push({
      device: row.device,
      partition: row.partition,
      linked: row.account,
      granted: grant.account,
    });
  }
  return found;
}

/**
 * Whether a `_links` change is one every peer should fold, in six rungs with the Ed25519 verify
 * last, so a flood of junk is refused on shape rather than on crypto.
 *
 * **A link event must carry nothing else.** A peer that has not upgraded has no `_links` in its
 * reserved tables, so it quarantines the event as `UnknownTable` — refusal without loss, since
 * its cursors re-request once it upgrades. That only holds while the link travels alone: bundled
 * with an ordinary write, one link event would poison that write on every old peer. It is the
 * deliberate contrast with `correct()`, which bundles for the opposite reason — there the
 * overwrite and its reason must not be separable.
 */
export function checkLink(change: Change, event: ProbeEvent): Result<void, ValidationError> {
  const key = change.key;
  if (change.kind === "delete")
    return refuse(key, "columns", "a link ends with an unlink, never with a delete");
  // the ladder rung above this one already parked it; refusing here as well is what makes the
  // narrowing the type asks for the same fact the validator states (D22-A)
  if (change.kind === "unknown")
    return refuse(key, "columns", "a link this build cannot read is not a link it can admit");
  const filed = splitLinkKey(key);
  const device = parsePeerId(filed.device).unwrapOr(undefined);
  if (device === undefined || filed.partition !== String(event.partition ?? ""))
    return refuse(
      key,
      "key",
      "a link is filed as `instance:device:digest`, in the instance it holds in",
    );
  if (event.changes.length > 1)
    return refuse(key, "isolation", "a link travels alone, or it takes the write beside it down");
  const cells = change.kind === "insert" ? change.row : change.patch;
  // a device may claim only itself; anyone may carry an unlink, because a stolen device will not
  // unlink itself and the account holding the key may have no way to reach it
  if (moment(cells.get(column("kind"))) === KIND.link && event.peerId !== device)
    return refuse(key, "author", "a device may claim only itself");
  // no monotonicity rung: the key is the core's own digest, so a row is written once and never
  // competes with another. Admitting every fact and resolving them afterwards is what makes two
  // peers agree whatever order they folded in, and it costs nothing — a replayed core writes the
  // row it already wrote
  const link = linkOf(key, (name) => cells.get(column(name)));
  return link.isErr() ? Result.err(link.error) : Result.ok(undefined);
}

/**
 * The account this device answers to in this instance, when a link says so and the row's own
 * bytes still agree.
 *
 * The wire is re-verified here rather than trusted, because a `_links` row can enter state
 * through a snapshot install that no validator ever judged, and an unverified read would let a
 * snapshot launder a binding in. That is what "the state is the registry" costs; {@link linkOf}'s
 * memo is what keeps it off the hot path.
 *
 * A device with no link — or one an unlink has ended — resolves to `undefined` and is judged
 * exactly as it is with accounts off. Nothing here invents an account for a device that has
 * never said who it belongs to.
 */
export function linkedAuthor(event: ProbeEvent, state: StateLookup): Author | undefined {
  if (event.partition === undefined) return undefined;
  const rows = state.records?.(RESERVED.links);
  if (rows === undefined) return undefined;
  const link = standing(rows).get(`${String(event.partition)}:${String(event.peerId)}`);
  if (link === undefined || link.op !== "link") return undefined;
  // no partitions: a link signs no partition list, and `checkPartition` skips the rung rather
  // than refuse every `org:` write the moment accounts are switched on
  return { account: link.account, claims: {} };
}

/**
 * What a row's own bytes say, once its columns have been proved to say the same thing.
 *
 * The columns are checked by *rebuilding* the core from them and comparing bytes — an encode
 * rather than a decode, and it leaves nothing for a column to disagree with the core about, so
 * the hot path may read `account`, `kind` and `at` without ever opening the blob.
 *
 * **The comparison runs on every call, and only the verify is remembered.** The verdict is a
 * fact about this key and these columns; only the signature is a fact about the blob alone. Held
 * the other way round, a second row carrying the same bytes object would inherit the first row's
 * answer and name a principal no signature ever gave it.
 */
function linkOf(key: RowKey, cell: CellReader): Result<AccountCore, LinkRefused> {
  const wire = cell("wire");
  if (!(wire instanceof Uint8Array)) return refuse(key, "columns", "the row carries no link bytes");
  const stated = coreOf(key, cell);
  if (stated === undefined) return refuse(key, "columns", "the columns are not a link core");
  const split = splitEnvelope(wire);
  if (split.isErr()) return refuse(key, "columns", split.error.message);
  if (!bytesEqual(split.value.core, encodeAccountCore(stated)))
    return refuse(key, "columns", "the columns do not say what the signed core says");
  // the key names the core's own digest, so one key can only ever hold one signed fact
  if (String(key) !== String(linkKey(stated.partition, stated.device, split.value.core)))
    return refuse(key, "key", "this row is not filed under its own core");
  const link = signatureOf(wire);
  return link.isErr() ? refuse(key, "signature", link.error.message) : Result.ok(stated);
}

/**
 * One Ed25519 verify per set of link bytes, held against the very bytes it was verified from —
 * a re-read costs a lookup, and bytes that changed have no entry to find. The shape
 * `syncedRules` uses to parse one policy doc once, for the same reason.
 */
const verified = new WeakMap<Uint8Array, Result<AccountCore, LinkError>>();

function signatureOf(wire: Uint8Array): Result<AccountCore, LinkError> {
  const held = verified.get(wire);
  if (held !== undefined) return held;
  const checked = verifyLink(wire);
  verified.set(wire, checked);
  return checked;
}

/** One cell of a row, however the caller happens to hold it — a `Row` or a folded `RowRecord`. */
type CellReader = (name: string) => CellValue | undefined;

/** The core a row states, read from its key and its columns alone — never from the blob. */
function coreOf(key: RowKey, cell: CellReader): AccountCore | undefined {
  const filed = splitLinkKey(key);
  const account = parseAccountId(text(cell("account"))).unwrapOr(undefined);
  const device = parsePeerId(filed.device).unwrapOr(undefined);
  const partition = parsePartitionKey(filed.partition).unwrapOr(undefined);
  const kind = moment(cell("kind"));
  if (account === undefined || device === undefined || partition === undefined) return undefined;
  if (kind !== KIND.link && kind !== KIND.unlink) return undefined;
  return {
    v: 1,
    op: kind === KIND.link ? "link" : "unlink",
    account,
    device,
    partition,
    at: Temporal.Instant.fromEpochMilliseconds(moment(cell("at"))),
  };
}

const refuse = (key: RowKey, rung: LinkRung, message: string) =>
  Result.err(new LinkRefused({ key: String(key), rung, message }));
