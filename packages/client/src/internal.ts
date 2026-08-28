import type { CorrectionRow, Engine, LinkRow, RevocationRow } from "@syncmesh/engine";
import type { EventId, PeerId, Row, RowKey, TableName } from "@syncmesh/kernel";

import {
  RESERVED_TABLE_NAMES,
  corrections as correctionsOf,
  links as linksOf,
  revocations as revocationsOf,
} from "@syncmesh/engine";
import { readRows } from "@syncmesh/kernel";
import { panic } from "@syncmesh/result";

/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the reserved policy table's own name, checked against RESERVED_TABLE_NAMES below */
const POLICY = "_policy" as TableName;
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */

/** What an authority overruled and why (RFC-0014), in the three cuts a UI asks for. */
export interface Corrections {
  readonly all: () => readonly CorrectionRow[];
  /** Only corrections to writes this device authored — what to surface to the person at it. */
  readonly mine: () => readonly CorrectionRow[];
  readonly forEvent: (event: EventId) => readonly CorrectionRow[];
}

/**
 * `mesh.internal`: the machinery tables, read where they cannot be mistaken for yours.
 *
 * `_policy`, `_corrections`, `_revocations`, `_links` and `_cdc` are ordinary synced rows this
 * device folds by the ordinary rules, and every one of them is something an app sometimes has to
 * show — why a value changed, which devices an account vouches for, what rules this instance is
 * actually running. They are kept behind their own door because the alternative was tried three
 * times in the exploration and failed three times: reserved tables in the app's own namespace,
 * where an `Object.keys` over your tables silently grows machinery, and a table named `_policy`
 * in your schema collides with the one the authority publishes.
 *
 * Readers only. A `_policy` row is written by `setPolicy` on the authority, a `_corrections` row
 * by `correct`, a `_links` row by `mesh.accounts.link` — each with its own signature rule — and
 * there is deliberately no door here that writes one.
 */
export interface MeshInternal {
  /** The reserved names, from the engine: what may never appear in your namespace. */
  readonly tables: ReadonlySet<string>;
  /**
   * One reserved table's live rows, exactly as they folded — the escape hatch for a table with no
   * typed reader yet (`_cdc`), and the raw form behind the ones that have. A name that is not
   * reserved panics: your own tables are read through `mesh.on()`.
   */
  readonly rows: (table: string) => ReadonlyMap<RowKey, Row>;
  /**
   * The rules this instance is actually running, as the row carries them, or `undefined` where no
   * authority has published one and the bundled manifest still stands. What to render next to a
   * permission the app cannot explain — `mesh.can` answers from the same row.
   */
  readonly policy: (instance: string) => Row | undefined;
  readonly corrections: Corrections;
  /** Every revocation this device holds for the instances it syncs, oldest first. */
  readonly revocations: () => readonly RevocationRow[];
  /** Every account-to-device link this device holds, oldest first (D21). */
  readonly links: () => readonly LinkRow[];
}

export interface InternalDeps {
  readonly engine: Engine;
  /** This device, for the one cut of corrections that is about its own writes. */
  readonly self: PeerId;
}

/**
 * Gathers the engine's reserved-table readers behind one door. Every one of them is the free
 * function the engine already exports, called — not reimplemented: a second copy of the
 * `_corrections` fold is a second answer to what a correction says, and the two would drift the
 * first time a column moved.
 */
export function openInternal(deps: InternalDeps): MeshInternal {
  const { engine, self } = deps;
  const rows = (table: string): ReadonlyMap<RowKey, Row> => {
    if (!RESERVED_TABLE_NAMES.has(table))
      panic(`"${table}" is not a reserved table: read your own tables through mesh.on()`);
    // SAFETY: a name RESERVED_TABLE_NAMES holds is a table name the engine itself declared
    return readRows(engine.state(), table as TableName);
  };

  return {
    tables: RESERVED_TABLE_NAMES,
    rows,
    // SAFETY: the `_policy` row for an instance is keyed by that instance's own key
    policy: (instance) => rows(POLICY).get(instance as RowKey),
    corrections: {
      all: () => correctionsOf(engine),
      // an event id begins with its author's peer id, so "mine" needs no extra bookkeeping
      mine: () => correctionsOf(engine).filter((c) => c.event.startsWith(`${String(self)}-`)),
      forEvent: (event) => correctionsOf(engine).filter((c) => c.event === String(event)),
    },
    revocations: () => revocationsOf(engine),
    links: () => linksOf(engine),
  };
}
