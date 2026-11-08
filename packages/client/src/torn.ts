import type { Cursors, Engine, TornRun, Unsubscribe } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Transport } from "@syncmesh/transport";

import { createHub, tornRuns } from "@syncmesh/engine";

/**
 * One run of events this device's log held and lost (D39), and where getting it back stands.
 *
 * - `waiting`: no linked peer has said it holds the run yet; the first that does is asked.
 * - `rejoining`: the run is reopened — recorded as a hole the log admits to, the cursor dropped
 *   below it — and every link asked again; it clears once the reopen has landed and the cursor
 *   passes the run again.
 * - `lost`: a run of this device's local-only events, which never travelled. Nothing holds it.
 */
export interface TornIssue {
  readonly run: TornRun;
  readonly state: "waiting" | "rejoining" | "lost";
}

export interface TornDeps {
  readonly engine: Pick<
    Engine,
    "acks" | "coverage" | "reopen" | "onError" | "onAcknowledge" | "onFoldBatch" | "onAdopt"
  >;
  /** The running media: who a run can be asked of, and what to ask again through. */
  readonly transports: () => readonly Pick<Transport, "reaches" | "delivers" | "resync">[];
}

const runKey = ({ peer, local, from }: TornRun): string => `${peer}:${local}:${from}`;

/**
 * Whether a peer whose cursors this device has heard holds the run: its cursors pass it, or it is
 * the run's author, which holds what it wrote — the cursors it last sent may predate the run.
 */
const holds = (peer: PeerId, cursors: Cursors, run: TornRun): boolean =>
  peer === run.peer || (cursors.get(run.peer) ?? 0) >= run.to;

/**
 * Whether a running medium may carry to this peer now: one that names the peers it reaches names
 * it, or one that cannot say runs at all — a resync through it costs one cursors exchange.
 */
const linked = (transports: ReturnType<TornDeps["transports"]>, peer: PeerId): boolean =>
  transports.some((transport) => {
    const named = transport.reaches?.() ?? transport.delivers?.();
    return named === undefined || named.has(peer);
  });

/**
 * What a refused read of a torn log becomes on a running mesh (D39, decided 2026-11-08): a
 * `$recovery` issue per lost run, and a rejoin the mesh makes itself. The engine says the tear on
 * `onError`; once a linked peer's cursors say it holds a run, the run is reopened
 * (`engine.reopen`) and every medium is asked again from the lowered cursors (`resync`), so the
 * peer sends the run and the log is whole. The issue clears when the cursor passes the run —
 * by the events, or by state where every holder compacted them (D46).
 *
 * A local run cannot come back from anyone: it stays as `lost` until {@link TornWatch.accept}
 * records it as gone, so the log reads again without it.
 */
export function watchTorn(deps: TornDeps) {
  const { engine } = deps;
  const issues = new Map<string, TornIssue>();
  const changed = createHub<void>();
  let queue: Promise<void> = Promise.resolve();
  /**
   * Rejoining runs whose reopen has not landed: until it does, the synced cursor still claims the
   * run, so a fold in between must not read it as back.
   */
  const reopening = new Set<string>();

  const set = (issue: TornIssue): void => void issues.set(runKey(issue.run), issue);

  /** Every waiting run some linked peer holds, reopened together and asked for again. */
  const rejoin = (): void => {
    const acks = [...engine.acks()];
    const running = deps.transports();
    const held = [...issues.values()].filter(
      ({ run, state }) =>
        state === "waiting" &&
        acks.some(([peer, cursors]) => holds(peer, cursors, run) && linked(running, peer)),
    );
    if (held.length === 0) return;
    for (const { run } of held) {
      set({ run, state: "rejoining" });
      reopening.add(runKey(run));
    }
    changed.emit();
    queue = queue.then(async () => {
      const reopened = await engine.reopen(held.map(({ run }) => run));
      for (const { run } of held) reopening.delete(runKey(run));
      if (reopened.isErr()) {
        console.warn("[syncmesh] a torn log could not be reopened:", reopened.error);
        for (const { run } of held) set({ run, state: "waiting" });
        changed.emit();
        return;
      }
      for (const transport of deps.transports()) transport.resync?.();
    });
  };

  /** Clears every reopened run the cursor has passed again. */
  const settle = (): void => {
    const synced = engine.coverage().synced;
    let cleared = false;
    for (const [key, { run, state }] of issues)
      if (state === "rejoining" && !reopening.has(key) && (synced.get(run.peer) ?? 0) >= run.to) {
        issues.delete(key);
        cleared = true;
      }
    if (cleared) changed.emit();
  };

  const offErrors = engine.onError((error) => {
    const runs = tornRuns(error);
    if (runs === undefined) return;
    let raised = false;
    for (const run of runs) {
      if (issues.has(runKey(run))) continue;
      set({ run, state: run.local ? "lost" : "waiting" });
      raised = true;
    }
    if (!raised) return;
    changed.emit();
    rejoin();
  });
  // a peer's cursors arriving is a peer that may hold a run; a fold is a run that may be held
  const offAcks = engine.onAcknowledge(rejoin);
  const offFolds = engine.onFoldBatch(settle);
  const offAdopt = engine.onAdopt(settle);

  return {
    /** Every run lost and not yet back, oldest first. */
    list: (): readonly TornIssue[] => [...issues.values()],
    /** Fires when {@link list} would answer differently. */
    onChange: (listener: () => void): Unsubscribe => changed.subscribe(listener),
    /**
     * Records a run as gone for good and drops the issue: the log reads again without it, and the
     * run no longer blocks the status. For a `lost` run, or a synced one no peer will ever send —
     * that one stays a hole the cursor stands below, so a peer that does hold it still sends it.
     * `false` when no such run is an issue.
     */
    accept: async (run: TornRun): Promise<boolean> => {
      const key = runKey(run);
      const issue = issues.get(key);
      if (issue === undefined) return false;
      const reopened = await engine.reopen([issue.run]);
      if (reopened.isErr()) return false;
      // given up on: the issue goes either way; a synced run's lowered cursor still asks for it
      issues.delete(key);
      changed.emit();
      return true;
    },
    stop: async (): Promise<void> => {
      offErrors();
      offAcks();
      offFolds();
      offAdopt();
      await queue;
    },
  };
}

export type TornWatch = ReturnType<typeof watchTorn>;
