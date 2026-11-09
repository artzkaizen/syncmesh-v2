import type {
  Engine,
  Interest,
  PolicyRule,
  ReceiveReport,
  StoreFailure,
  StrandedWrites,
  TornRun,
  Unsubscribe,
} from "@syncmesh/engine";
import type { EventId, PeerId } from "@syncmesh/kernel";
import type { PolicyStep } from "@syncmesh/policy";
import type { Result as ResultType } from "@syncmesh/result";
import type {
  Accepted,
  BelowFloor,
  Rejoins,
  SnapshotInstalled,
  Transport,
} from "@syncmesh/transport";

import { CAPABILITY_VERDICTS } from "@syncmesh/engine";
import { ruleText } from "@syncmesh/policy";
import { omitUndefined, Result } from "@syncmesh/result";
import { createRejoins } from "@syncmesh/transport";

import type { StoreSweep } from "./sweep.js";
import type { TornIssue, TornWatch } from "./torn.js";

import { HistoryUnavailable, RebuildRefused } from "./errors.js";
import { watchTorn } from "./torn.js";

/**
 * What is stuck and why, as stable causes (book ch. 18): the quarantine's parked events read
 * back as issues an operator can act on. Recovery itself is automatic — a grant that lands
 * re-offers what it unblocks — so `run` is the idempotent nudge, never a discard.
 */
export interface RecoveryIssue {
  /**
   * `missing-capability`: the author's grant was absent, stale, revoked or too narrow — the
   * fix is a grant, and arrival wakes the event. `refused`: the event itself failed the
   * schema's rules; a later build (or policy) may read the same bytes differently.
   */
  readonly kind: "missing-capability" | "refused";
  readonly event: EventId;
  readonly author: PeerId;
  /** The verdict's tag — `NoGrant`, `GrantStale`, `PartitionNotGranted`, … */
  readonly verdict: string;
  readonly message: string;
  /**
   * On a `PolicyDenied`, why (U2): the rule the event was judged under — the allow-block entry and
   * whether the instance's synced `_policy` doc or the bundled manifest held it — and the leaves of
   * it that failed. Absent on every other verdict, and on a denial no rule was read for.
   */
  readonly policy?: { readonly rule: PolicyRule; readonly because: readonly PolicyStep[] };
}

/**
 * One stuck event, in full: what it is, why it stopped, and the one thing that would move it.
 *
 * The `next` line is the point of the whole surface. An operator opens this screen because
 * something has not moved for a while, and a cause with no action beside it is a spinner with
 * more words.
 */
export interface RecoveryPlan {
  readonly issue: RecoveryIssue;
  /** What would unblock it, in a sentence a person can act on. */
  readonly next: string;
  /** Whether `run()` could plausibly change anything yet — a grant that has not arrived cannot. */
  readonly retryWorthwhile: boolean;
}

export interface RecoveryView {
  readonly list: () => readonly RecoveryIssue[];
  /** One issue in full, or `undefined` when nothing by that id is stuck any more. */
  readonly explain: (event: EventId) => RecoveryPlan | undefined;
  /**
   * The stuck event as the bytes it arrived as — the author's own signed envelope, unaltered.
   *
   * The exit when nothing else works: a person can carry it to another device, or hand it to
   * whoever can read it. **It contains application data**, which is why it is a call an operator
   * makes deliberately rather than a file the engine writes somewhere.
   */
  readonly export: (event: EventId) => Uint8Array | undefined;
  /**
   * Writes this device holds that it can never deliver — empty on a device that has not rotated
   * its key over a log it kept, which is almost all of them.
   *
   * Beside the quarantine rather than inside it, because the two are opposites. A parked event is
   * one this build would not fold and no peer is waiting on; a stranded one folded, is on the
   * screen, and is the only copy there will ever be. Nothing here retries it and nothing here
   * repairs it — see `StrandedWrites` for why re-signing would be worse than the loss. What this
   * is for is the screen: a person looking at two devices that disagree, told which author went
   * quiet and how much went with it, instead of counting rows.
   */
  readonly stranded: () => Promise<ResultType<readonly StrandedWrites[], StoreFailure>>;
  /** Re-runs admission over everything parked; a no-op when nothing changed since it parked. */
  readonly run: () => Promise<ResultType<ReceiveReport, StoreFailure>>;
  /**
   * Where this device is below a floor, and why it is still there: the history it lacks is in no
   * log that side keeps, so delta sync cannot reach it. Two kinds, told apart by `reason` — narrow
   * on it before reading `.peer` or `.relay`:
   *
   * - `BelowPeerFloor`: a peer this device is below the compaction floor of (D46).
   * - `BelowRelayFloor` (`reason: "retention"`): a relay that refused the join because its room
   *   trimmed below the cursors it sent (gaps U30). A relay serves no state, so `acceptState`
   *   answers `nothing-to-accept` for it.
   *
   * Empty once every author catches up to the floor, however it got there.
   *
   * With `trust` set the device asks for state on its own and adopts what the issuer vouched for;
   * an issue here means that did not finish. With no `trust` nothing can vouch for a snapshot, so
   * every such peer is an issue until {@link RecoveryView.acceptState} says otherwise.
   */
  readonly belowFloor: () => readonly BelowFloor[];
  /**
   * Fires when {@link RecoveryView.belowFloor} would answer differently: an issue raised, or one
   * cleared because an install answered it or its authors caught up. Hands back nothing; read
   * `belowFloor()` again. `mesh.status` subscribes to it too.
   */
  readonly onBelowFloor: (listener: () => void) => Unsubscribe;
  /**
   * Takes the peer's state although nothing vouched for it, adopting per author at most the floor
   * it claimed (D46). Deliberately a call someone makes: in a mesh with no `trust`, a peer lying
   * about its floor and its rows could otherwise make this device stop fetching an author's real
   * events. `"deferred"` when no session to that peer is open: the next one asks.
   */
  readonly acceptState: (peer: PeerId) => Accepted;
  /**
   * Runs of events this device's log held and a read found gone — a page the disk lost (D39) — and
   * where getting each back stands. The mesh rejoins on its own: once a linked peer's cursors say
   * it holds a run, the run is reopened and asked for again, and the issue clears when it is held.
   * Empty on a log nothing has torn, which is almost all of them.
   */
  readonly torn: () => readonly TornIssue[];
  /** Fires when {@link RecoveryView.torn} would answer differently; read it again. `mesh.status` subscribes too. */
  readonly onTorn: (listener: () => void) => Unsubscribe;
  /**
   * Takes a torn run as gone for good, so the log reads again without it: what a `lost` run (this
   * device's local-only events, which nothing else held) needs before anything else can read the
   * log, and what a synced run no peer will ever send can be given. Deliberately a call someone
   * makes. The issue is dropped either way, so the status stops blocking; a synced run accepted
   * this way is still asked for as a hole. `false` when no such run is an issue, or the log could
   * not record it.
   */
  readonly acceptTorn: (run: TornRun) => Promise<boolean>;
  /**
   * The last resort: take the state from a source that can vouch for it (book ch. 18).
   *
   * For the replica that is beyond repair — a cache that will not open, a fold that will not
   * converge. It asks every open session for **state** instead of history, and adopts what
   * arrives only if something vouched for it.
   *
   * **Three things it never does.** It never resets storage: the rows merge through the same
   * field-level merge every other source goes through, so a tombstone newer than the snapshot's
   * write still wins and nothing is resurrected. It never deletes the outbox: this device's own
   * unsent writes are exactly what nobody else can give back. And it never adopts a snapshot
   * nobody signed for unless the caller says so in as many words.
   */
  readonly rebuild: (
    options?: RebuildOptions,
  ) => Promise<ResultType<RebuildReport, HistoryUnavailable | RebuildRefused>>;
  /**
   * The open stores no live grant covers, and the sweep that sheds them whole (plan §2.3).
   * Absent on a mesh that was not told which stores this device holds.
   */
  readonly stores?: StoreSweep;
}

export interface RebuildOptions {
  /**
   * Refuse when this device holds writes of its own that no peer has acknowledged. Default
   * `true`: a rebuild is a last resort, and a person reaching for one should be told what is
   * still in flight before the screen repaints. Nothing is deleted either way.
   */
  readonly preservePending?: boolean;
  /**
   * Adopt state that arrived with nothing to check it against — no per-event signatures, and no
   * checkpoint certificate this device could verify. Default `false`, because the whole point of
   * the last resort is that it does not make things worse.
   */
  readonly allowProvisional?: boolean;
  /** How long to wait for a source to answer. Default 30s. */
  readonly timeoutMs?: number;
}

export interface RebuildReport {
  readonly rows: number;
  /** Whether what was adopted carried a verified certificate; `false` only when asked for. */
  readonly vouched: boolean;
  /** This device's own writes no peer has acknowledged — untouched, and re-offered from here. */
  readonly pending: number;
}

const REFUSED_BY_RULES =
  "The event failed the schema's own rules. A later build or policy may read it differently; nothing an operator does now will.";

/** A policy refusal's next step: the rule, where it came from, and the leaves that failed. */
const policyNext = ({ rule, because }: NonNullable<RecoveryIssue["policy"]>): string => {
  const held = rule.source === "policy-doc" ? "the instance's policy doc" : "the bundled manifest";
  const failed = because.map((step) => ruleText(step.node)).join(", ");
  return `The ${rule.entry} rule for ${rule.op} in ${held} refused it: ${failed}. A policy or a grant that satisfies it lets the next run fold it.`;
};

/** What would move this one, said plainly. Nothing here guesses: each verdict has one answer. */
const nextStep = (issue: RecoveryIssue): string => {
  switch (issue.verdict) {
    case "NoGrant":
      return `${String(issue.author).slice(0, 8)} holds no grant here: issue one, or relay the one it has.`;
    case "GrantStale":
      return "The author's grant has expired: renew it, and this folds on the next run.";
    case "GrantRevoked":
      return "The author's grant was revoked. This stays parked unless the revocation is lifted.";
    case "GrantDeviceMismatch":
      return "The grant names a different device than the one that signed: re-issue it for this device.";
    case "PartitionNotGranted":
      return "The author's grant does not cover this instance: widen it, or leave the write where it is.";
    case "PolicyDenied":
      return issue.policy === undefined ? REFUSED_BY_RULES : policyNext(issue.policy);
    case "TableDropped":
      return `${issue.author.slice(0, 8)} is on an older build that still writes a table this build dropped: upgrade that device. Nothing here will fold it.`;
    default:
      return REFUSED_BY_RULES;
  }
};

export interface RecoveryDeps {
  /** The sources to ask for state, in the order they are asked; usually every open transport. */
  readonly sources: () => readonly {
    readonly name: string;
    readonly requestSnapshot?: (interest?: Interest) => void;
  }[];
  /** Every join that completes while this device is running; `rebuild` waits on one of these. */
  readonly onSnapshot: (cb: (installed: SnapshotInstalled) => void) => Unsubscribe;
  /** This device's own writes no peer has acknowledged yet. */
  readonly pending: () => number;
  /** The grant-driven store sweep, where the caller holds the set of open stores. */
  readonly stores?: StoreSweep;
  /** The mesh's record of peers this device is below the floor of (D46). */
  readonly rejoins?: Rejoins;
  /** The mesh's watch over a torn log (D39). */
  readonly torn?: TornWatch;
}

/**
 * This device's own writes that no peer has acknowledged: the highest sequence it has authored,
 * minus the highest any peer has said it holds.
 *
 * The number nobody else can give back. A rebuild takes state from somewhere else, and state is
 * the one thing that does not carry these — so an operator about to reach for the last resort is
 * told what is still in flight first.
 */
export const unacknowledged = (engine: Engine, self: PeerId): number => {
  const mine = engine.coverage().synced.get(self) ?? 0;
  let best = 0;
  for (const cursors of engine.acks().values()) best = Math.max(best, cursors.get(self) ?? 0);
  return Math.max(mine - best, 0);
};

/** What `$recovery.rebuild` needs of a running mesh, assembled in one place rather than five. */
export const recoveryDeps = (
  engine: Engine,
  self: PeerId,
  snapshots: { readonly subscribe: RecoveryDeps["onSnapshot"] },
  sources: () => readonly Transport[],
): RecoveryDeps & { readonly rejoins: Rejoins; readonly torn: TornWatch } => ({
  sources,
  onSnapshot: snapshots.subscribe,
  pending: () => unacknowledged(engine, self),
  rejoins: createRejoins(),
  // a log a read finds torn is an issue, and a rejoin from whichever linked peer holds it (D39)
  torn: watchTorn({ engine, transports: sources }),
});

export function openRecovery(engine: Engine, deps?: RecoveryDeps): RecoveryView {
  const parkedIssue = ({
    entry,
    verdict,
  }: ReturnType<Engine["quarantine"]>[number]): RecoveryIssue => {
    const issue = {
      kind: CAPABILITY_VERDICTS.has(verdict._tag) ? "missing-capability" : "refused",
      event: entry.event.id,
      author: entry.event.peerId,
      verdict: verdict._tag,
      message: verdict.message,
    } as const;
    if (verdict._tag !== "PolicyDenied" || verdict.rule === undefined) return issue;
    return { ...issue, policy: { rule: verdict.rule, because: verdict.because ?? [] } };
  };

  return {
    list: () => engine.quarantine().map(parkedIssue),
    explain: (event) => {
      const parked = engine.quarantine().find((held) => held.entry.event.id === event);
      if (parked === undefined) return undefined;
      const issue = parkedIssue(parked);
      return {
        issue,
        next: nextStep(issue),
        // a refusal by the rules will refuse again; a missing capability may have arrived since
        retryWorthwhile: issue.kind === "missing-capability",
      };
    },
    export: (event) => {
      const parked = engine.quarantine().find((held) => held.entry.event.id === event);
      // the author's own envelope, byte for byte: anything re-encoded here would not verify
      return parked?.entry.core;
    },
    stranded: () => engine.stranded(),
    run: () => engine.retryQuarantined(),
    belowFloor: () => deps?.rejoins?.issues() ?? [],
    onBelowFloor: (listener) => deps?.rejoins?.onChange(listener) ?? (() => undefined),
    acceptState: (peer) => deps?.rejoins?.accept(peer) ?? "nothing-to-accept",
    torn: () => deps?.torn?.list() ?? [],
    onTorn: (listener) => deps?.torn?.onChange(listener) ?? (() => undefined),
    acceptTorn: (run) => deps?.torn?.accept(run) ?? Promise.resolve(false),
    rebuild: (options = {}) => rebuildFrom(deps, options),
    ...omitUndefined({ stores: deps?.stores }),
  };
}

const DEFAULT_REBUILD_TIMEOUT_MS = 30_000;

/**
 * Asks every source for state and adopts the first answer that something vouched for.
 *
 * The waiting is the interesting part. A source that cannot answer does not fail — it stays
 * quiet, which is indistinguishable from one that is slow, so the only honest end to the wait is
 * a deadline and a report naming who was asked. That report is durable and actionable, which is
 * what the book means by "an honest report, not an endless spinner".
 */
async function rebuildFrom(
  deps: RecoveryDeps | undefined,
  options: RebuildOptions,
): Promise<ResultType<RebuildReport, HistoryUnavailable | RebuildRefused>> {
  if (deps === undefined)
    return Result.err(
      new RebuildRefused({
        reason: "no-sources",
        message: "this mesh has no transports: there is nobody to take state from",
      }),
    );
  const pending = deps.pending();
  if (options.preservePending !== false && pending > 0)
    return Result.err(
      new RebuildRefused({
        reason: "pending-writes",
        message: `${pending} of this device's writes have not been acknowledged anywhere; they are kept either way — pass preservePending: false to rebuild now`,
      }),
    );

  const sources = deps.sources();
  const asked = sources.filter((source) => source.requestSnapshot !== undefined);
  if (asked.length === 0)
    return Result.err(
      new HistoryUnavailable({
        sourcesTried: sources.map((source) => source.name),
        message: "no source here can hand over state; export is the exit",
      }),
    );

  const taken = await firstVouched(deps, asked, options);
  if (taken === undefined)
    return Result.err(
      new HistoryUnavailable({
        sourcesTried: asked.map((source) => source.name),
        message: `no source answered with state anything vouched for inside ${String(options.timeoutMs ?? DEFAULT_REBUILD_TIMEOUT_MS)}ms; nothing here was changed, and export is the exit`,
      }),
    );
  // the outbox is untouched by all of this: what is pending now is what was pending before
  return Result.ok({ rows: taken.rows, vouched: !taken.provisional, pending: deps.pending() });
}

/** The first install that qualifies, or `undefined` when the deadline passed first. */
const firstVouched = (
  deps: RecoveryDeps,
  asked: readonly { readonly requestSnapshot?: (interest?: Interest) => void }[],
  options: RebuildOptions,
): Promise<SnapshotInstalled | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(undefined);
    }, options.timeoutMs ?? DEFAULT_REBUILD_TIMEOUT_MS);
    const off = deps.onSnapshot((installed) => {
      // a provisional install already happened — the rows are in, merged like any other source.
      // What is refused here is *calling it a rebuild*, because nothing vouched for it
      if (installed.provisional && options.allowProvisional !== true) return;
      clearTimeout(timer);
      off();
      resolve(installed);
    });
    for (const source of asked) source.requestSnapshot?.();
  });
