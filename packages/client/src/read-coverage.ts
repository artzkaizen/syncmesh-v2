import type { Cursors } from "@syncmesh/engine";
import type { Temporal } from "@syncmesh/temporal";
import type { Transport } from "@syncmesh/transport";

/**
 * Where a source had got to when it finished its first pass: the moment, and the per-author
 * cursors this device held then. What "caught up to *that* source" is measured against.
 */
export interface Checkpoint {
  readonly at: Temporal.Instant;
  readonly cursors: Cursors;
}

/**
 * How much of the world has answered a read (book ch. 9).
 *
 * Empty local rows are not proof the remote scope is empty, so every answer says how far it can
 * be trusted. `caught-up` means coverage to an **identified** source's checkpoint — never
 * permanent global completeness — and `partial` is the middle a two-radio device spends most of
 * its life in: the near source has spoken, the far one has not.
 *
 * `Answered` (`@syncmesh/react`) is the three-step progression a screen already draws by. This
 * is the fact beside it, not a replacement: an offline-only device stays `local-only` forever,
 * because `caught-up` cannot name a source that does not exist — which is exactly why an
 * empty-state decision for such a device must read `answered`, not this.
 */
export type ReadCoverage =
  | { readonly kind: "local-only" }
  | { readonly kind: "partial"; readonly source: string; readonly checkpoint: Checkpoint }
  | { readonly kind: "caught-up"; readonly source: string; readonly checkpoint: Checkpoint };

/**
 * The reading before any source has spoken, or where no source can — one object, shared, because
 * `useSyncExternalStore` compares snapshots by reference and a fresh `{ kind: "local-only" }` per
 * call is an infinite render loop wearing an honest answer.
 */
export const LOCAL_ONLY: ReadCoverage = { kind: "local-only" };

export interface ReadCoverageView {
  readonly get: () => ReadCoverage;
  /** Fires when a source finishes its first pass; the reading is cheap, so it hands back no snapshot. */
  readonly subscribe: (listener: () => void) => () => void;
}

export interface ReadCoverageDeps {
  /** The live set — `add`/`remove` reshape it, and a reading is taken against what is current. */
  readonly transports: () => readonly Transport[];
  /** This device's synced cursors, read at the moment a source completes. */
  readonly cursors: () => Cursors;
  readonly now: () => Temporal.Instant;
}

/** Nearest first, the way `settled()` awaits them: a lower priority is a nearer source. */
const distance = (transport: Transport): number => transport.priority ?? 1;

/**
 * Turns the per-source completions `settled()` already awaits — and then throws away into one
 * `void` promise — into a reading with a source and a checkpoint on it.
 *
 * Each medium is armed once: when its `caughtUp()` resolves, the moment and the cursors are kept
 * under its name. The reading is then derived, never stored: `local-only` while nothing has
 * completed, `caught-up` once every medium in the *current* set has, `partial` in between — with
 * the **furthest** completed source named, because that is the one whose checkpoint the rows
 * are good to. A medium added later is armed the next time anyone looks, and until it completes
 * the reading honestly drops back to `partial`.
 */
export function createReadCoverage(deps: ReadCoverageDeps): ReadCoverageView {
  const completed = new Map<Transport, Checkpoint>();
  const armed = new Set<Transport>();
  const listeners = new Set<() => void>();

  const arm = (transport: Transport): void => {
    if (armed.has(transport)) return;
    armed.add(transport);
    void transport
      .whenReady()
      .then(() => transport.caughtUp?.())
      .then(
        () => {
          completed.set(transport, { at: deps.now(), cursors: deps.cursors() });
          for (const listener of listeners) listener();
        },
        // a medium that failed to come up is simply one that has not answered; `$status` says why
        () => undefined,
      );
  };

  /**
   * The last reading handed out, so an unchanged answer keeps its identity. `useSyncExternalStore`
   * compares snapshots by reference and re-renders — or loops — on a fresh object that says the
   * same thing; the fact only moves when a source completes or the set changes, so neither does
   * this.
   */
  let last: ReadCoverage = LOCAL_ONLY;
  const same = (a: ReadCoverage, b: ReadCoverage): boolean =>
    a.kind === b.kind &&
    (a.kind === "local-only" ||
      (b.kind !== "local-only" && a.source === b.source && a.checkpoint === b.checkpoint));

  const reading = (): ReadCoverage => {
    const next = compute();
    if (!same(last, next)) last = next;
    return last;
  };

  const compute = (): ReadCoverage => {
    const current = deps.transports();
    for (const transport of current) arm(transport);
    // each answered medium beside its checkpoint, so choosing one chooses the other
    const done = current.flatMap((t) => {
      const checkpoint = completed.get(t);
      return checkpoint === undefined ? [] : [{ transport: t, checkpoint }];
    });
    const [first, ...rest] = done;
    if (first === undefined) return LOCAL_ONLY;
    // the furthest source that has answered: its checkpoint is the one the rows are good to
    const furthest = rest.reduce(
      (far, d) => (distance(d.transport) > distance(far.transport) ? d : far),
      first,
    );
    const kind = done.length === current.length ? "caught-up" : "partial";
    return { kind, source: furthest.transport.name, checkpoint: furthest.checkpoint };
  };

  for (const transport of deps.transports()) arm(transport);

  return {
    get: reading,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
