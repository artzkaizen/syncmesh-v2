import type { StoreFailure } from "@syncmesh/engine";
import type { Hlc } from "@syncmesh/kernel";

import { useEffect, useState } from "react";

import type { DevtoolsEvent, DevtoolsSource } from "../contract.js";
import type { Column, StatProps } from "../react/primitives/index.js";
import type { DevtoolsTab, DevtoolsTabProps } from "../tabs.js";

import { PREFIX } from "../css.js";
import { Icon } from "../react/icons.js";
import { Meter, Mix, Panel, Spark, Table, Tag } from "../react/primitives/index.js";
import { COLOR, SPACE, TEXT } from "../tokens.js";
import { Bars, buckets, bytes, note, stamp, tally } from "./format.js";
import { FAINT, FONT_MONO, StatBand, shortPeer } from "./link-kit.js";

/**
 * The log, newest first — drawn as a silhouette first and read as rows second.
 *
 * Every row is a {@link DevtoolsEvent}: who wrote it, in what order, when by their clock, into which
 * instance, how large it is, and whether it ever left the device. There is no core and no payload
 * here, and that is the panel's design rather than a stage it is at. An event's core is the exact
 * bytes its author signed; rendering one would put somebody's rows on a screen as a side effect of
 * counting them, and would cost a decode per row of a list a reader refreshes while a batch lands.
 *
 * **The rate chart is the most valuable thing on the panel**, and the reason is that the three
 * states worth telling apart — a device catching up in a burst, a device that has been quiet for an
 * hour, a device in a write storm — are three different silhouettes and *identical* columns of
 * digits. The bars are bucketed over the page's own span; see {@link buckets} for why not a clock.
 *
 * **Paging is by stamp, not by offset**, because the log has none: events arrive out of order and
 * land between ones already stored, so a page numbered from the end would shuffle under a reader
 * mid-scroll. Each page hands its oldest stamp forward as the next page's `before`. It does not
 * follow the tail on its own either — re-reading on `fold` would put a query behind every write.
 */

/**
 * The slice of {@link DevtoolsSource} this panel reads.
 *
 * One member, because that is all it draws: a panel that cannot reach `sql` or `storage` cannot
 * grow a second way of asking the same question, and a test drives it with a single function.
 */
export type EventsSource = Pick<DevtoolsSource, "events">;

/** Enough to fill the panel twice, which is what makes "is there another page" answerable at all. */
const PAGE = 100;

type Page =
  | { readonly read: "waiting" }
  | { readonly read: "rows"; readonly rows: readonly DevtoolsEvent[] }
  | { readonly read: "failed"; readonly failure: StoreFailure };

const MONO = { fontFamily: FONT_MONO };

/** Everything the charts need, counted once per page rather than once per component that draws it. */
const trafficOf = (rows: readonly DevtoolsEvent[]) => ({
  authors: tally(rows.map((row) => shortPeer(row.peer))),
  places: tally(rows.map((row) => row.partition ?? "global")),
  local: rows.filter((row) => row.local).length,
  weight: rows.reduce((sum, row) => sum + row.bytes, 0),
  window: buckets(rows.map((row) => row.hlc[0].epochMilliseconds)),
  fattest: Math.max(1, ...rows.map((row) => row.bytes)),
});

type Traffic = ReturnType<typeof trafficOf>;

const bandOf = (count: number, traffic: Traffic): readonly StatProps[] => [
  { label: "On this page", value: count, icon: <Icon name="database" size={15} /> },
  { label: "Authors", value: traffic.authors.length },
  { label: "Weight", value: bytes(traffic.weight) },
  { label: "Local only", value: traffic.local, severity: traffic.local === 0 ? undefined : "high" },
];

/**
 * Why a write cell can be blank, said where a reader meets it rather than in a release note.
 *
 * A header read out of SQL carries no table names, because the only way to name them there is to
 * read the core back — the one thing this panel exists not to do. A sealed event answers nothing
 * either, for the plainer reason that this device cannot read it. Blank is that fact; it is never
 * an event that wrote nowhere.
 *
 * On a real device that used to be *every* row, which made the column decoration. It is now the
 * arms this device genuinely cannot answer: somebody else's event, which its ledger says nothing
 * about, and its own write from before there was a ledger to say.
 */
const Undecoded = () => (
  <span
    style={{ color: COLOR.textFaint }}
    title="Naming what an event wrote means decoding the core its author signed. A log read out of SQL never does, and a sealed event could not be read here anyway. This device's own writes are named from its write ledger instead, which needs no decode."
  >
    not decoded
  </span>
);

/**
 * What the event was, in the best terms this device can put it.
 *
 * Three answers, in order of how much they are worth. The **procedure** is what a person did and
 * comes from this device's own write ledger, joined on the event the write became — no decode,
 * because it wrote it. The **tables** are what the event touched, and only a store that already
 * holds decoded events can say. Neither, and the cell says so.
 */
const Wrote = ({ header }: { readonly header: DevtoolsEvent }) => {
  if (header.label !== undefined) return <Tag mono>{header.label}</Tag>;
  return header.tables === undefined ? <Undecoded /> : <>{header.tables.join(", ")}</>;
};

/** `fattest` scales the size bar, so one heavy event in a page of small ones is visible at a glance. */
const columns = (fattest: number) =>
  [
    {
      key: "author",
      header: "Author",
      width: "minmax(0, 1.1fr)",
      render: (h) => <span style={MONO}>{shortPeer(h.peer)}</span>,
    },
    { key: "seq", header: "Seq", width: "52px", align: "right", render: (h) => h.seq },
    { key: "stamp", header: "Stamp", width: "112px", render: (h) => stamp(h.hlc) },
    {
      key: "partition",
      header: "Instance",
      width: "minmax(0, 0.9fr)",
      render: (h) =>
        h.partition === undefined ? (
          <span style={{ color: COLOR.textFaint }}>global</span>
        ) : (
          <Tag mono>{h.partition}</Tag>
        ),
    },
    {
      key: "origin",
      header: "Origin",
      width: "92px",
      render: (h) => (
        <Tag severity={h.local ? "high" : "muted"}>{h.local ? "local" : "synced"}</Tag>
      ),
    },
    {
      key: "bytes",
      header: "Size",
      width: "minmax(110px, 0.8fr)",
      render: (h) => (
        <span style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
          <Meter max={fattest} value={h.bytes} />
          {bytes(h.bytes)}
        </span>
      ),
    },
    {
      key: "wrote",
      header: "Wrote",
      width: "minmax(0, 1fr)",
      render: (h) => <Wrote header={h} />,
    },
  ] satisfies Column<DevtoolsEvent>[];

/** An empty first page and an empty fifth page mean different things, and say so. */
const nothing = (deep: boolean) =>
  note(
    deep ? "Nothing older than this stamp" : "The log is empty",
    deep
      ? "This is as far back as the log goes on this device. Compaction removes events below a floor once every peer that matters holds them — the Storage panel shows where that floor now sits."
      : "Nothing has been written on this device and nothing has arrived from a peer. Write through a mesh.on() handle, or add a transport and wait for a batch to fold; a local-only write shows here too, which is what makes this the panel for a write that never left.",
    <Icon name="database" size={20} />,
  );

/** The page a cursor stack is currently on, read once and held until something asks again. */
const usePage = (source: EventsSource, before: Hlc | undefined, again: number) => {
  const [page, setPage] = useState<Page>({ read: "waiting" });
  useEffect(() => {
    let live = true;
    setPage({ read: "waiting" });
    void source
      .events(before === undefined ? { limit: PAGE } : { limit: PAGE, before })
      .then((read) => {
        if (!live) return;
        setPage(
          read.isErr()
            ? { read: "failed", failure: read.error }
            : { read: "rows", rows: read.value },
        );
      });
    return () => {
      live = false;
    };
  }, [source, before, again]);
  return page;
};

/** The charts, drawn only where there is a page to draw them from: an empty spark teaches nobody. */
function Charts({
  rows,
  traffic,
}: {
  readonly rows: readonly DevtoolsEvent[];
  readonly traffic: Traffic;
}) {
  return (
    <>
      <StatBand stats={bandOf(rows.length, traffic)} />
      <Panel subtitle="bucketed over this page's own span" title="Rate">
        <Spark every={traffic.window.every} severity="low" values={traffic.window.values} />
        <div style={{ marginTop: SPACE.lg }}>
          <Mix
            slices={[
              { label: "synced", value: rows.length - traffic.local, severity: "low" },
              { label: "local only", value: traffic.local, severity: "high" },
            ]}
          />
        </div>
      </Panel>
      <div
        style={{ display: "grid", gap: SPACE.md, gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
      >
        <Panel padded={false} subtitle="who is producing the log" title="By author">
          <Bars rows={traffic.authors} />
        </Panel>
        <Panel padded={false} subtitle="global tables and each instance" title="By instance">
          <Bars rows={traffic.places} />
        </Panel>
      </div>
    </>
  );
}

export function Events({ source }: DevtoolsTabProps<EventsSource>) {
  // the stamps already paged past; the last is the page on screen, and `undefined` is the tail
  const [trail, setTrail] = useState<readonly (Hlc | undefined)[]>([undefined]);
  const [again, setAgain] = useState(0);
  const page = usePage(source, trail.at(-1), again);

  const rows = page.read === "rows" ? page.rows : [];
  const traffic = trafficOf(rows);
  const oldest = rows.at(-1);
  const older = () => {
    if (oldest !== undefined) setTrail((held) => [...held, oldest.hlc]);
  };

  return (
    <div style={{ display: "grid", gap: SPACE.md, padding: SPACE.lg, minWidth: 0 }}>
      {rows.length === 0 ? null : <Charts rows={rows} traffic={traffic} />}
      <Panel
        actions={
          <div style={{ display: "flex", alignItems: "center", gap: SPACE.xs }}>
            <span style={FAINT}>
              {page.read === "waiting" ? "reading…" : `${rows.length} shown`}
            </span>
            <button
              className={`${PREFIX}-btn`}
              disabled={trail.length === 1}
              onClick={() => setTrail((held) => held.slice(0, -1))}
              style={TEXT.xs}
              type="button"
            >
              Newer
            </button>
            <button
              className={`${PREFIX}-btn`}
              disabled={rows.length < PAGE}
              onClick={older}
              style={TEXT.xs}
              type="button"
            >
              Older
            </button>
            <button
              className={`${PREFIX}-btn`}
              onClick={() => setAgain((count) => count + 1)}
              style={TEXT.xs}
              type="button"
            >
              <Icon name="activity" size={13} />
              Refresh
            </button>
          </div>
        }
        padded={false}
        subtitle="newest first, headers only"
        title="Events"
      >
        {page.read === "failed" ? (
          note(
            "The log could not be read",
            `${page.failure.message} — the log is read over the stamp index; a store that cannot answer this cannot answer anti-entropy either, so it is worth following up rather than retrying.`,
            <Icon name="close" size={20} />,
          )
        ) : (
          <Table
            columns={columns(traffic.fattest)}
            empty={page.read === "waiting" ? undefined : nothing(trail.length > 1)}
            rowKey={(header) => header.id}
            rows={rows}
          />
        )}
      </Panel>
      <p style={{ ...TEXT.xs, color: COLOR.textFaint, margin: 0, maxWidth: 620 }}>
        Headers, never cores. This panel shows the shape of the traffic and none of its contents,
        which is also why a sealed partition&apos;s events are listed and counted here but never
        opened — sealed is a fact about the event, not an error and not an absence.
      </p>
    </div>
  );
}

export const eventsTab = {
  id: "events",
  label: "Events",
  icon: <Icon name="database" size={14} />,
  render: Events,
} satisfies DevtoolsTab<EventsSource>;
