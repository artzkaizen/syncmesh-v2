import type { ForcedMedium } from "@syncmesh/client";
import type { PeerId } from "@syncmesh/kernel";
import type { LinkEventKind, TransportCondition } from "@syncmesh/transport";
import type { ReactNode } from "react";

import { useEffect, useState } from "react";

import type {
  DevtoolsChannel,
  DevtoolsEndingTally,
  DevtoolsLinkEvent,
  DevtoolsMedium,
  DevtoolsSource,
} from "../contract.js";
import type { Column, StatProps } from "../react/primitives/index.js";
import type { Severity } from "../tokens.js";

import { Stat, StatusDot, Table, Tag } from "../react/primitives/index.js";
import { COLOR, RADIUS, SEVERITY_COLOR, SPACE, TEXT } from "../tokens.js";

/**
 * What the Peers and Transports panels share, which is everything except the question they ask.
 *
 * The two are one fact read from two ends — *who is this device talking to, over what* and *what
 * is this medium carrying* — so they must agree on the inversion, on the words for an absence, and
 * on the clock. Two copies of any of those is how a devtool ends up telling a developer two
 * different things about one radio, which is worse than telling them nothing.
 *
 * **A quantity that can be drawn is drawn.** A column of bare numerals is a table a reader has to
 * parse a row at a time; a column of bars is a shape they take in at once, and finding the one bad
 * peer among twelve is the entire job. So the meters, the ring and the ending sparkline live here
 * rather than in one panel, and every panel scales them the same way.
 *
 * The rule the whole file exists to hold: **a medium that cannot enumerate its links is not a
 * medium with none.** `DevtoolsLinks.silent` names the mediums whose `reaches` is absent — a relay
 * multiplexing a room is the ordinary case — and drawing that as `0 peers` invents a claim the
 * mesh never made. It gets {@link CANNOT_SAY}, a sentence, and never a bar.
 */

/**
 * The slice of {@link DevtoolsSource} these panels read.
 *
 * A `Pick` rather than the whole source, so a test can drive a panel from four members instead of
 * sixteen and neither panel can quietly grow a dependency on a surface it does not draw.
 */
export type LinksSource = Pick<DevtoolsSource, "links" | "onChange" | "overview" | "sync">;

/** One medium with the relation turned around: what it says about itself, and who it holds. */
export interface MediumView extends DevtoolsMedium {
  /** Peers named as carried by this medium. Never the whole truth when `enumerates` is false. */
  readonly carrying: readonly PeerId[];
  /** False for a medium in `links.silent`: it cannot name its links, which is not holding none. */
  readonly enumerates: boolean;
}

/**
 * The sentence a medium gets instead of a zero. One constant because both panels say it about the
 * same absence, and two wordings for one fact would read as two different facts.
 */
export const CANNOT_SAY = "this medium cannot say";

export const CONDITION_SEVERITY = {
  ok: "ok",
  "connecting-failed": "critical",
  "listen-failed": "critical",
  "discovery-failed": "high",
  "radio-off": "high",
  "no-permission-central": "critical",
  "no-permission-peripheral": "critical",
  "no-hardware": "muted",
  backgrounded: "medium",
  "temporarily-unavailable": "high",
  unknown: "muted",
} satisfies Record<TransportCondition, Severity>;

/**
 * A refusal is the one ending worth colouring: it is the door, and it is the question the feed
 * exists to answer. A close stays grey because it is ordinary — a peer walked out of range — and a
 * feed where every row shouts is a feed nobody reads twice.
 */
export const LINK_SEVERITY = {
  proven: "ok",
  refused: "critical",
  closed: "muted",
  dropped: "high",
  error: "critical",
} satisfies Record<LinkEventKind, Severity>;

/** Drawn in this order everywhere, so the same stack of colours always means the same thing. */
export const ENDINGS = [
  "proven",
  "refused",
  "dropped",
  "error",
  "closed",
] satisfies LinkEventKind[];

/** The bar colour for an ending, so the stack and the legend can never disagree. */
export const tint = (kind: LinkEventKind) => SEVERITY_COLOR[LINK_SEVERITY[kind]];

/** Ids are scanned down a column, so they line up or they are unreadable. */
export const FONT_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Ids here are compared by eye, never typed; a service name such as `authority` is left whole. */
export const shortPeer = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/** Coarse on purpose: a reader wants "2m" and "3h", not a duration to the millisecond. */
export const since = (atMs: number, nowMs: number) => {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/**
 * How much a stale figure is worth believing, as a colour.
 *
 * This is the *behind versus gone* distinction made visible. A lag bar is the same length whether
 * the peer said so four seconds ago or last Tuesday, and only one of those is a device catching
 * up — so the length carries the gap and the colour carries the age, and a reader gets both in one
 * glance instead of reading two columns and doing the subtraction.
 */
export const ageSeverity = (atMs: number | undefined, nowMs: number) => {
  if (atMs === undefined) return "muted";
  const age = nowMs - atMs;
  if (age < 60_000) return "ok";
  return age < 3_600_000 ? "high" : "critical";
};

/** The ring's fill, and `0` for an empty mesh rather than the `NaN` a bare division gives. */
export const share = (part: number, whole: number) => (whole === 0 ? 0 : (part / whole) * 100);

/** Endings still in the ring, summed by kind — for one medium, or for the device. */
export const endingCounts = (
  tally: readonly DevtoolsEndingTally[],
  transport?: string,
): ReadonlyMap<LinkEventKind, number> => {
  const counts = new Map<LinkEventKind, number>();
  for (const row of tally)
    if (transport === undefined || row.transport === transport)
      counts.set(row.kind, (counts.get(row.kind) ?? 0) + row.count);
  return counts;
};

/** Half-lit, for the cell that is saying *nothing is known* rather than reporting a value. */
export const FAINT = { ...TEXT.xs, color: COLOR.textFaint };

/** One array, so a panel that holds nothing never re-subscribes for want of a stable reference. */
const NONE: readonly ForcedMedium[] = [];

const MESH_CHANNELS = ["link", "route"] satisfies DevtoolsChannel[];
const SYNC_CHANNELS = ["ack", "fold"] satisfies DevtoolsChannel[];

/**
 * One snapshot, re-read when a channel the caller draws has moved.
 *
 * `useState` rather than `useSyncExternalStore` because every reader on the source builds a fresh
 * object per call, and a `getSnapshot` that never returns the same reference twice makes React
 * re-render until it gives up. Only `source` is a dependency: the channel list and the reader are
 * module constants at every call site, so one open panel takes one subscription — which is the
 * budget the contract was designed around.
 */
const useSnapshot = <T,>(
  source: LinksSource,
  channels: readonly DevtoolsChannel[],
  read: (source: LinksSource) => T,
  forced: readonly ForcedMedium[] = NONE,
) => {
  const [held, setHeld] = useState(() => read(source));
  useEffect(() => {
    setHeld(read(source));
    return source.onChange((moved) => {
      if (channels.some((channel) => moved.has(channel))) setHeld(read(source));
    });
  }, [source, forced]);
  return held;
};

/**
 * The inversion, done once for whoever asks.
 *
 * The source reports the relation the way the mesh holds it — per peer, as `DevtoolsPeer.over` —
 * because that is the direction a session knows it in. A Transports panel needs it the other way
 * round, and a panel that built its own copy would be a second answer to one question.
 */
const readMesh = (source: LinksSource) => {
  const links = source.links();
  const held = new Map<string, PeerId[]>();
  for (const peer of links.peers)
    for (const name of peer.over) held.set(name, [...(held.get(name) ?? []), peer.peer]);
  const silent = new Set(links.silent);
  const mediums = source.overview().mediums.map((medium) => ({
    ...medium,
    carrying: held.get(medium.name) ?? [],
    enumerates: !silent.has(medium.name),
  }));
  return { links, mediums };
};

/**
 * `forced` is for the reading a *click* invalidates rather than a channel.
 *
 * Holding a medium swaps one transport for another inside the running set, and the source learns
 * about it the next time something asks — there is no engine hook for "a person changed their
 * mind", and inventing a {@link DevtoolsChannel} that only an operator action could move would put
 * the controls back inside the read-only contract by the back door. So the list itself is the
 * dependency: a new array arrives after every force and every release, and the snapshot is taken
 * again. A panel with no controls passes nothing and the array is the shared empty one, so the
 * effect's dependencies are as stable as they were before this existed.
 */
export const useMesh = (source: LinksSource, forced?: readonly ForcedMedium[]) =>
  useSnapshot(source, MESH_CHANNELS, readMesh, forced);

export const useSync = (source: LinksSource) =>
  useSnapshot(source, SYNC_CHANNELS, (held) => held.sync());

/**
 * A clock that ticks, because every "how long ago" on these panels is stale the moment it renders
 * — and a quiet mesh, where nothing fires `onChange` at all, is exactly the case where an hour of
 * silence is the finding.
 */
export const useNowMs = () => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
};

/** A 1px gap over a hairline background is how these grids draw their own gridlines. */
const RULED = {
  display: "grid",
  gap: 1,
  background: COLOR.hairline,
  border: `1px solid ${COLOR.hairline}`,
};

/** The band of figures both panels open with, sized to however many it is given. */
export function StatBand({ stats }: { readonly stats: readonly StatProps[] }) {
  return (
    <div style={{ ...RULED, gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
      {stats.map((stat) => (
        <div key={stat.label} style={{ background: COLOR.surface }}>
          <Stat {...stat} />
        </div>
      ))}
    </div>
  );
}

/** The key to every stack of colour on these panels, with the counts it is keyed to. */
export function EndingLegend({ counts }: { readonly counts: ReadonlyMap<LinkEventKind, number> }) {
  const shown = ENDINGS.filter((kind) => (counts.get(kind) ?? 0) > 0);
  if (shown.length === 0) return <span style={FAINT}>no endings in the ring</span>;
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: SPACE.xs }}>
      {shown.map((kind) => (
        <Tag key={kind} severity={LINK_SEVERITY[kind]} variant="solid">
          {kind} {counts.get(kind)}
        </Tag>
      ))}
    </span>
  );
}

const BUCKETS = 44;

/** Every bucket keeps its track when it is empty, so a quiet minute reads as loudly as a burst. */
const SLOT = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end",
  background: COLOR.track,
  borderRadius: RADIUS.sm,
  overflow: "hidden",
  minWidth: 1,
} as const;

const binsOf = (events: readonly DevtoolsLinkEvent[], nowMs: number, spanMs: number) => {
  const bins = Array.from({ length: BUCKETS }, () => new Map<LinkEventKind, number>());
  for (const event of events) {
    const age = nowMs - event.at.epochMilliseconds;
    const bin =
      age < 0 || age >= spanMs
        ? undefined
        : bins[BUCKETS - 1 - Math.floor(age / (spanMs / BUCKETS))];
    bin?.set(event.kind, (bin.get(event.kind) ?? 0) + 1);
  }
  return bins.map((bin) => ({ bin, total: [...bin.values()].reduce((a, b) => a + b, 0) }));
};

export interface SparklineProps {
  readonly events: readonly DevtoolsLinkEvent[];
  readonly nowMs: number;
  /** How far back the bars reach. Two minutes is where a link that flaps flaps visibly. */
  readonly spanMs?: number;
}

/**
 * Endings over time, stacked by kind — the panel's answer to *is this link flapping*.
 *
 * A flap is a rhythm, and a rhythm is the one thing a list of rows cannot show: eight refusals
 * spread over an hour and eight in ten seconds print identically and mean completely different
 * things. Every bucket keeps its track when it is empty, so the gaps are as legible as the bars —
 * a quiet minute between two bursts is the shape a reader is looking for.
 */
export function Sparkline({ events, nowMs, spanMs = 120_000 }: SparklineProps) {
  const bins = binsOf(events, nowMs, spanMs);
  const tallest = Math.max(1, ...bins.map((slot) => slot.total));
  return (
    <div
      aria-label={`link endings over the last ${since(nowMs - spanMs, nowMs)}`}
      role="img"
      style={{ display: "flex", alignItems: "stretch", gap: 1, height: 36, minWidth: 0 }}
    >
      {bins.map((slot, index) => (
        <div key={index} style={SLOT}>
          <div style={{ height: `${share(slot.total, tallest)}%`, display: "grid" }}>
            {ENDINGS.filter((kind) => slot.bin.has(kind)).map((kind) => (
              <div key={kind} style={{ flexGrow: slot.bin.get(kind), background: tint(kind) }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const eventColumns = (nowMs: number) =>
  [
    {
      key: "kind",
      header: "Ending",
      width: "84px",
      render: (event) => (
        <span style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
          <StatusDot severity={LINK_SEVERITY[event.kind]} />
          {event.kind}
        </span>
      ),
    },
    { key: "transport", header: "Medium", width: "minmax(0, 1fr)", render: (e) => e.transport },
    {
      key: "peer",
      header: "Peer",
      width: "minmax(0, 1fr)",
      render: (event) =>
        event.peer === undefined ? (
          <span style={FAINT}>below the handshake</span>
        ) : (
          <span style={{ fontFamily: FONT_MONO }}>{shortPeer(event.peer)}</span>
        ),
    },
    { key: "why", header: "Why", width: "minmax(0, 2fr)", render: (e) => e.why ?? "—" },
    {
      key: "at",
      header: "Ago",
      width: "52px",
      align: "right",
      render: (event) => since(event.at.epochMilliseconds, nowMs),
    },
  ] satisfies Column<DevtoolsLinkEvent>[];

export interface LinkEventsProps {
  readonly events: readonly DevtoolsLinkEvent[];
  readonly nowMs: number;
  /** Why there are none — the reason differs between a whole-device feed and one peer's history. */
  readonly empty: ReactNode;
}

/**
 * The endings as rows, under the shape of them: the sparkline says *something is wrong here*, and
 * this says what. Keyed by the source's own `id` rather than ring position, because the slot a
 * refusal sits in holds a different ending five minutes later.
 */
export function LinkEvents({ events, nowMs, empty }: LinkEventsProps) {
  return (
    <Table
      columns={eventColumns(nowMs)}
      empty={empty}
      rowKey={(event) => String(event.id)}
      rows={events}
    />
  );
}
