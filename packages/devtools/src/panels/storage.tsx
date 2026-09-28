import type { PeerId } from "@syncmesh/kernel";

import { useEffect, useState } from "react";

import type { DevtoolsSource, DevtoolsStore, QueryFailed } from "../contract.js";
import type { Column, Slice, StatProps } from "../react/primitives/index.js";
import type { DevtoolsTab, DevtoolsTabProps } from "../tabs.js";
import type { Severity } from "../tokens.js";
import type { Bar } from "./format.js";

import { PREFIX } from "../css.js";
import { Icon } from "../react/icons.js";
import { Mix, Panel, Ring, Row, Table, Tag } from "../react/primitives/index.js";
import { COLOR, SPACE, TEXT } from "../tokens.js";
import { Bars, bytes, note, share } from "./format.js";
import { FAINT, FONT_MONO, StatBand, shortPeer } from "./link-kit.js";

/**
 * What is actually on disk, drawn so that "which table is my database" takes one glance.
 *
 * Every figure here reaches the panel through `DevtoolsSource.storage`, which is a `COUNT`, a `MAX`
 * and a `SUM(length(core))` over the mesh's own tables, run on `mesh.query` — `driver.all` with no
 * `run` beside it. The log is weighed by the *length* of each core and never by reading one, which
 * is the difference between weighing a sealed envelope and opening it. The other SQL door on a mesh
 * is `mesh.on().db`, whose proxy classifies statements by regex and turns an `insert`, `update` or
 * `delete` into a **signed event** sent to every peer; nothing on this screen goes near it.
 *
 * **It never refreshes on a fold.** A device catching up folds in batches, and a panel that
 * re-counted per batch would run a `COUNT(*)` over the whole event table for every one of them,
 * turning the instrument into the load it was installed to measure. A person asks, or a slow poll
 * does — and the poll is off until somebody turns it on.
 *
 * Counts are meters and positions are digits, and the split is not cosmetic. Rows per table and
 * events per author are magnitudes: they are read for their ranking, so they are bars. A compaction
 * floor is a *position in a sequence* — a bar drawn from it would say the author with the higher
 * sequence number had more of something, which is not a fact — so floors stay a table.
 *
 * Two numbers here are honest rather than flattering. A sealed partition's events are counted and
 * never opened, so a heavy author with no readable rows is a sealed instance and not a fault.
 */

/** The slice of {@link DevtoolsSource} this panel reads: the store, its scope, and whose device this is. */
export type StorageSource = Pick<DevtoolsSource, "storage" | "sync" | "identity">;

/** Long enough that a poll is a background fact rather than a cost; short enough to watch a compaction. */
const POLL_MS = 5000;

type Held =
  | { readonly read: "waiting" }
  | { readonly read: "store"; readonly store: DevtoolsStore }
  | { readonly read: "failed"; readonly failure: QueryFailed };

const MONO = { fontFamily: FONT_MONO };
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

const FLOORS = [
  {
    key: "peer",
    header: "Author",
    width: "minmax(0, 1.4fr)",
    render: (row) => <span style={MONO}>{shortPeer(row.peer)}</span>,
  },
  {
    key: "origin",
    header: "Origin",
    width: "96px",
    render: (row) => <Tag>{row.local ? "local only" : "synced"}</Tag>,
  },
  { key: "seq", header: "Kept from", width: "96px", align: "right", render: (row) => row.seq },
] satisfies Column<DevtoolsStore["floors"][number]>[];

/** Counts per author as magnitudes; the sequence and the weight ride along as the row's second line. */
const authorBars = (store: DevtoolsStore, self: PeerId): readonly Bar[] =>
  store.log.map((row) => ({
    key: `${row.peer}:${String(row.local)}`,
    label: <span style={MONO}>{shortPeer(row.peer)}</span>,
    meta: `${row.local ? "local only" : "synced"} · max seq ${row.topSeq} · ${bytes(row.bytes)}`,
    value: row.events,
    severity: row.peer === self ? "low" : undefined,
  }));

const tableBars = (store: DevtoolsStore): readonly Bar[] =>
  [...store.tables]
    .sort((left, right) => right.rows - left.rows)
    .map((row) => ({ key: row.table, label: row.table, value: row.rows }));

/**
 * A ledger's outcomes are a ratio question — how much of what this device wrote was overruled.
 *
 * A status this build has not heard of keeps a slice of its own rather than vanishing into a
 * default: a count nobody expected is the news, and dropping it would hide exactly that.
 */
const ledgerSeverity = (status: string): Severity => {
  if (status === "blocked") return "critical";
  if (status === "superseded") return "high";
  return status === "applied" ? "low" : "muted";
};

const ledgerSlices = (store: DevtoolsStore): readonly Slice[] =>
  store.writes.map((row) => ({
    label: row.status,
    value: row.count,
    severity: ledgerSeverity(row.status),
  }));

const bandOf = (store: DevtoolsStore): readonly StatProps[] => [
  {
    label: "Log weight",
    value: bytes(sum(store.log.map((row) => row.bytes))),
    icon: <Icon name="database" size={15} />,
  },
  { label: "Events", value: sum(store.log.map((row) => row.events)) },
  { label: "Tables", value: store.tables.length },
  { label: "State rows", value: sum(store.tables.map((row) => row.rows)) },
  { label: "Migration", value: store.version === undefined ? "unknown" : `v${store.version}` },
];

const NO_STORE = note(
  "This mesh keeps no SQL store",
  "This mesh was opened over a bare event store, so there is no database to count: the log lives in memory, mesh.query is absent with it, and nothing here survives a reload. Open the mesh with a driver to see what is on disk.",
  <Icon name="database" size={20} />,
);

const EMPTY_LOG = note(
  "Nothing in the log",
  "No event has been stored yet — neither a write of this device's nor a batch from a peer. The Events panel shows the same emptiness from the other side.",
);

const EMPTY_TABLES = note(
  "No state rows",
  "State rows appear as events fold. A table that stays at zero while the log grows is usually a sealed instance this device holds no key for: its events are counted above and cannot be applied here.",
);

const EMPTY_FLOORS = note(
  "No compaction floors",
  "Nothing has been compacted, so every event this device ever folded is still in the log. A floor appears once compaction removes events below a sequence every peer that matters already holds.",
);

const EMPTY_LEDGER = note(
  "No write records",
  "This mesh keeps no write ledger, or no write has been recorded in it yet. The Writes panel is where the unsettled ones and their receipts live.",
);

/** One read, on demand or on the poll; `undefined` storage never schedules either. */
const useStore = (source: StorageSource, again: number, poll: boolean) => {
  const [held, setHeld] = useState<Held>({ read: "waiting" });
  const read = source.storage;
  useEffect(() => {
    if (read === undefined) return;
    let live = true;
    const once = () =>
      void read().then((answer) => {
        if (!live) return;
        setHeld(
          answer.isErr()
            ? { read: "failed", failure: answer.error }
            : { read: "store", store: answer.value },
        );
      });
    once();
    const timer = poll ? setInterval(once, POLL_MS) : undefined;
    return () => {
      live = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [read, again, poll]);
  return held;
};

interface StoreProps {
  readonly store: DevtoolsStore;
  readonly self: PeerId;
  readonly scope: string | undefined;
}

function Store({ store, self, scope }: StoreProps) {
  const events = sum(store.log.map((row) => row.events));
  const mine = sum(store.log.filter((row) => row.peer === self).map((row) => row.events));
  return (
    <>
      <StatBand stats={bandOf(store)} />
      <Panel subtitle="how much of this database this device wrote itself" title="The log">
        <div style={{ display: "flex", alignItems: "center", gap: SPACE.xl, minWidth: 0 }}>
          <Ring
            display={`${share(mine, events)}%`}
            label="authored here"
            severity="low"
            value={share(mine, events)}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Bars empty={EMPTY_LOG} rows={authorBars(store, self)} />
          </div>
        </div>
      </Panel>
      <Panel
        padded={false}
        subtitle="heaviest first — which table is the database"
        title="Rows per table"
      >
        <Bars empty={EMPTY_TABLES} rows={tableBars(store)} />
      </Panel>
      <Panel subtitle="what became of the writes this device recorded" title="Write ledger">
        {store.writes.length === 0 ? EMPTY_LEDGER : <Mix slices={ledgerSlices(store)} height={8} />}
      </Panel>
      <Panel
        padded={false}
        subtitle="what has already been dropped from below"
        title="Compaction floors"
      >
        <Table
          columns={FLOORS}
          empty={EMPTY_FLOORS}
          rowKey={(row) => `${row.peer}:${String(row.local)}`}
          rows={store.floors}
        />
      </Panel>
      <Panel padded={false} title="Cursor scope">
        <Row
          label={scope ?? "unscoped"}
          meta={
            scope === undefined
              ? "This device's cursors are true for the whole log, which is the plainer and stronger claim."
              : "These cursors are only true for this interest; a peer syncing a wider one must not read them as coverage."
          }
        />
      </Panel>
    </>
  );
}

export function Storage({ source }: DevtoolsTabProps<StorageSource>) {
  const [again, setAgain] = useState(0);
  const [poll, setPoll] = useState(false);
  const held = useStore(source, again, poll);
  const absent = source.storage === undefined;

  return (
    <div style={{ display: "grid", gap: SPACE.md, padding: SPACE.lg, minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: SPACE.md,
        }}
      >
        <span style={FAINT}>
          Counted on demand. Never on a fold: a catch-up would run a COUNT(*) per batch.
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: SPACE.xs }}>
          <button
            aria-pressed={poll}
            className={`${PREFIX}-btn`}
            disabled={absent}
            onClick={() => setPoll((on) => !on)}
            style={TEXT.xs}
            type="button"
          >
            Poll 5s
          </button>
          <button
            className={`${PREFIX}-btn`}
            disabled={absent}
            onClick={() => setAgain((count) => count + 1)}
            style={TEXT.xs}
            type="button"
          >
            <Icon name="activity" size={13} />
            Refresh
          </button>
        </div>
      </div>
      {absent ? <Panel padded={false}>{NO_STORE}</Panel> : null}
      {held.read === "failed" ? (
        <Panel padded={false}>
          {note(
            "The store could not be counted",
            `${held.failure.sql} — every statement here is a SELECT or a PRAGMA over the mesh's own tables, so a refusal is the database saying no rather than this panel asking for something it should not have.`,
            <Icon name="close" size={20} />,
          )}
        </Panel>
      ) : null}
      {held.read === "store" ? (
        <Store scope={source.sync().scope} self={source.identity().peer} store={held.store} />
      ) : null}
      <p style={{ ...TEXT.xs, color: COLOR.textFaint, margin: 0, maxWidth: 620 }}>
        Row counts and weights, never contents: the log is measured with length(core) and the core
        column itself is never selected. Bytes on disk are a platform fact nobody here can read —
        what grows is the log, and that is the weight above.
      </p>
    </div>
  );
}

export const storageTab = {
  id: "storage",
  label: "Storage",
  icon: <Icon name="database" size={14} />,
  render: Storage,
} satisfies DevtoolsTab<StorageSource>;
