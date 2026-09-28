import type { StoreFailure } from "@syncmesh/engine";
import type { Result } from "@syncmesh/result";

import { type CSSProperties, useEffect, useState } from "react";

import type {
  DevtoolsSource,
  DevtoolsStranded,
  DevtoolsWrite,
  DevtoolsWrites,
} from "../contract.js";
import type { StatProps } from "../react/primitives/index.js";
import type { DevtoolsTab, DevtoolsTabProps } from "../tabs.js";
import type { Severity } from "../tokens.js";
import type { DevtoolsReceipt } from "./custody.js";
import type { Bar } from "./format.js";

import { Icon } from "../react/icons.js";
import { Panel, Row, Tag } from "../react/primitives/index.js";
import { COLOR, SPACE, TEXT } from "../tokens.js";
import { Custody } from "./custody.js";
import { Bars, note } from "./format.js";
import { FAINT, FONT_MONO, StatBand, shortPeer, since, useNowMs } from "./link-kit.js";
import { Stranded, useStranded } from "./stranded.js";

/**
 * The write ledger: what this device wrote, what nobody has confirmed holding, and what an
 * authority overruled.
 *
 * The ledger is the only durable answer to *did my write get anywhere*. It survives a restart,
 * which the in-memory sync state does not, and a row leaves the unsettled list when some peer's
 * acknowledged cursor covers the event the write became — which is **delivery and never approval**.
 * A receipt says a device holds the bytes, not that anybody agreed with them; the two get confused
 * constantly, so this panel says which one it means everywhere it names a holder.
 *
 * **Age is drawn, not just sorted.** A list ordered oldest-first tells you which write has waited
 * longest and nothing about whether that is two seconds or two hours, and those are opposite
 * findings. Each row's bar is its age against the oldest one on screen and takes its colour from
 * the age itself, so a ledger that has quietly stopped settling looks wrong before it is read.
 *
 * A mesh over a bare event store keeps no ledger at all. That reads here as a sentence — nothing
 * was recorded, because nothing records — rather than an empty table, which would be the same
 * pixels saying the opposite thing: that this device has written nothing.
 *
 * {@link Stranded} sits below the ledger because it is the ledger's question asked one step
 * further on. `unsettled` is *nobody has confirmed holding this yet*, which time may fix; stranded
 * is *nobody ever will*, which nothing fixes. A device with writes in the second list and none in
 * the first looks perfectly healthy from every other panel here, which is why it is on this tab
 * rather than a note in a log — and why its count rides in the band beside the one above it.
 */

export type { DevtoolsReceipt } from "./custody.js";

/** One `_corrections` row as fields: which write, which row, and the reason given for overruling it. */
export interface DevtoolsCorrection {
  readonly event: string;
  readonly table: string;
  readonly key: string;
  readonly reason: string;
}

/**
 * The slice of {@link DevtoolsSource} this panel reads, plus the two facts the contract does not
 * carry yet.
 *
 * `links` is here for one number: custody coverage is *holders out of the peers this device knows*,
 * and a count of holders with no denominator cannot tell "one of one" from "one of nine". Both
 * extras are optional, so a plain `DevtoolsSource` satisfies this type and the panel renders
 * without them — with a sentence in each place, because a custody list that is empty because
 * nobody holds the write and one that is empty because nothing here can ask are different findings.
 */
export interface WritesSource extends Pick<
  DevtoolsSource,
  "writes" | "stranded" | "onChange" | "links"
> {
  readonly receiptsOf?:
    | ((write: DevtoolsWrite) => Promise<Result<readonly DevtoolsReceipt[], StoreFailure>>)
    | undefined;
  /** Corrections against this device's own writes, as `mesh.internal.corrections.mine()` holds them. */
  readonly corrections?: (() => readonly DevtoolsCorrection[]) | undefined;
}

/** More than a screenful, few enough that a `LEFT JOIN` with no `LIMIT` cannot become the panel. */
const LIMIT = 200;

const eventOf = (w: DevtoolsWrite) => `${shortPeer(w.peer)}-${w.seq}`;

/** The status rides with the label: `applied` is the ordinary case and deserves no column of its own. */
const label = (w: DevtoolsWrite) =>
  w.status === "applied" ? w.label : <Tag severity="high">{`${w.label} · ${w.status}`}</Tag>;

/** An hour unsettled is a different event from a minute unsettled, and the colour says so first. */
const waitSeverity = (waitedMs: number): Severity =>
  waitedMs > 3_600_000 ? "critical" : waitedMs > 300_000 ? "high" : "low";

const waitBars = (
  writes: readonly DevtoolsWrite[],
  nowMs: number,
  pick: (write: DevtoolsWrite) => void,
): readonly Bar[] =>
  writes.map((w) => ({
    key: w.id,
    label: label(w),
    meta: <span style={{ fontFamily: FONT_MONO }}>{eventOf(w)}</span>,
    value: Math.max(nowMs - w.at.epochMilliseconds, 0),
    display: since(w.at.epochMilliseconds, nowMs),
    severity: waitSeverity(nowMs - w.at.epochMilliseconds),
    action: (
      <button aria-label={`Custody of ${w.label}`} onClick={() => pick(w)} type="button">
        <Icon name="open" size={13} />
      </button>
    ),
  }));

const NO_LEDGER = note(
  "This mesh has no write ledger",
  "This mesh was opened over a bare event store, so no operation record is written and none can be read: what a write did is known only while the process lives. Open the mesh with a driver to get a ledger that survives a restart.",
  <Icon name="database" size={20} />,
);

const NOTHING_UNSETTLED = note(
  "Nothing is waiting",
  "Every write this device recorded has been receipted by at least one peer. A write appears here the moment it commits and leaves when somebody's acknowledged cursor covers it — so on a device with no peers, an empty list means no write has been made since the ledger was opened.",
);

const ONLY_STRANDED = note(
  "Nothing is waiting that could arrive",
  "Every write still unsettled in this ledger is stranded — held here, signed by a key this device no longer has. They are named below. No peer is behind and nothing is slow: there is nothing left here that a receipt could settle.",
);

const NOTHING_CORRECTED = note(
  "Nothing corrected",
  "No authority has overruled a write of this device's. A correction names the write, the row it landed on and the reason given; the values it replaced are the authority's own write, folded like any other.",
);

/**
 * Whether a ledger row is one of the writes the audit found: matched by author and sequence,
 * because a run is what a rotation strands and a run is what the audit reports.
 *
 * The two sides cannot disagree in practice, and it is worth saying why rather than hoping. A
 * ledger row exists only for a write **this device made**, so a row whose author is a retired
 * identity is one of that identity's own writes — which is exactly the set with no signature and
 * no key left to make one. Another peer's events never get a row here at all.
 */
const strandedBy =
  (runs: readonly DevtoolsStranded[]) =>
  (write: DevtoolsWrite): boolean =>
    runs.some((run) => run.author === write.peer && write.seq >= run.from && write.seq <= run.to);

/** The ledger, re-read when the source says it moved — which it does only after a receipt lands. */
const useUnsettled = (source: WritesSource) => {
  const read = source.writes;
  const [held, setHeld] = useState<Result<DevtoolsWrites, StoreFailure> | undefined>(undefined);
  useEffect(() => {
    if (read === undefined) return;
    let live = true;
    const once = () =>
      void read(LIMIT).then((answer) => {
        if (live) setHeld(answer);
      });
    once();
    const off = source.onChange((moved) => {
      if (moved.has("writes")) once();
    });
    return () => {
      live = false;
      off();
    };
  }, [source, read]);
  return held;
};

/**
 * Corrections from the source where it has them, and off the unsettled rows where it has not.
 *
 * The fallback is deliberately partial: a write that settled and was overruled afterwards is
 * invisible to it, because the only rows in reach are the ones still waiting. The panel says that
 * under the list rather than presenting a short one as complete.
 */
const correctionsOf = (source: WritesSource, unsettled: readonly DevtoolsWrite[]) =>
  source.corrections?.().map((c) => ({
    id: `${c.event}:${c.table}:${c.key}`,
    event: c.event,
    where: `${c.table}.${c.key}`,
    reason: c.reason,
  })) ??
  unsettled
    .filter((w) => w.correctedReason !== undefined)
    .map((w) => ({ id: w.id, event: eventOf(w), where: w.label, reason: w.correctedReason ?? "" }));

const waited = (oldest: DevtoolsWrite | undefined, nowMs: number) =>
  oldest === undefined ? "—" : since(oldest.at.epochMilliseconds, nowMs);

/**
 * The ledger as this panel reads it: what can still settle, kept apart from what cannot.
 *
 * The split is the whole point. `Unsettled` and `Waiting longest` are both claims about time —
 * *this has not arrived yet* — and counting a stranded write in either turns them into claims
 * that are simply false. This panel read `Unsettled 86 · Waiting longest 30h` on a device whose
 * 86 unsettled writes were the same 86 the audit had already found could never be sent.
 */
interface Reading {
  /** Unsettled and still able to arrive; these are what the two time figures are about. */
  readonly waiting: readonly DevtoolsWrite[];
  readonly truncated: boolean;
  readonly corrected: number;
  /** Events, from the log's own audit — not a count of ledger rows, which may have been trimmed. */
  readonly stranded: number;
}

const bandOf = (reading: Reading, nowMs: number): readonly StatProps[] => {
  const oldest = reading.waiting[0];
  const waiting = reading.waiting.length;
  const stale =
    oldest === undefined ? undefined : waitSeverity(nowMs - oldest.at.epochMilliseconds);
  const corrected = reading.corrected;
  const stranded = reading.stranded;
  return [
    {
      label: "Unsettled",
      value: reading.truncated ? `${waiting}+` : waiting,
      icon: <Icon name="activity" size={15} />,
      severity: waiting === 0 ? "ok" : undefined,
    },
    { label: "Waiting longest", value: waited(oldest, nowMs), severity: stale },
    { label: "Corrected", value: corrected, severity: corrected === 0 ? undefined : "high" },
    // never `ok` at zero, unlike Unsettled: an empty ledger is an achievement and an empty audit
    // is just the ordinary state of a device that has not rotated a key
    { label: "Stranded", value: stranded, severity: stranded === 0 ? undefined : "critical" },
  ];
};

const EMPTY_LEDGER = { unsettled: [], truncated: false } satisfies DevtoolsWrites;

/** Zero while the audit is in flight or refused — the panel below says which, and the band is a figure. */
const strandedCount = (held: ReturnType<typeof useStranded>) =>
  held?.isOk() === true ? held.value.reduce((sum, run) => sum + run.count, 0) : 0;

/**
 * The ledger's own bad news, when there is any: no ledger at all, or one that would not read.
 *
 * Returned rather than rendered, because what the panel does about it is *not* to stop. The
 * stranded audit does not come from the ledger — it walks the log — and a mesh over a bare event
 * store is both the case with no ledger and a case that can perfectly well hold a stranded run.
 * An early return here would hide the one finding on this tab that nothing else in the devtool
 * reports.
 */
const ledgerTrouble = (
  source: WritesSource,
  held: Result<DevtoolsWrites, StoreFailure> | undefined,
) => {
  if (source.writes === undefined) return NO_LEDGER;
  if (held === undefined || held.isOk()) return undefined;
  return note(
    "The ledger could not be read",
    `${held.error.message} — the ledger lives in the same database as the log, so a refusal here usually means the connection went away rather than that the write did.`,
    <Icon name="close" size={20} />,
  );
};

const LAYOUT = {
  display: "grid",
  gap: SPACE.md,
  padding: SPACE.lg,
  minWidth: 0,
} satisfies CSSProperties;

const NOTE = { ...TEXT.xs, color: COLOR.textFaint, margin: 0, padding: SPACE.md };

export function Writes({ source }: DevtoolsTabProps<WritesSource>) {
  const nowMs = useNowMs();
  const held = useUnsettled(source);
  const stranded = useStranded(source);
  const [chosen, setChosen] = useState<DevtoolsWrite | undefined>(undefined);
  const runs = stranded?.isOk() === true ? stranded.value : [];

  const trouble = ledgerTrouble(source, held);
  if (trouble !== undefined)
    return (
      <div style={LAYOUT}>
        <Panel padded={false}>{trouble}</Panel>
        <Stranded held={stranded} />
      </div>
    );

  const writes = held === undefined || held.isErr() ? EMPTY_LEDGER : held.value;
  const corrections = correctionsOf(source, writes.unsettled);
  const stuck = strandedBy(runs);
  // corrections are read off the whole ledger, because a stranded write can still be overruled;
  // only the two figures that are claims about *time* are narrowed
  const waiting = writes.unsettled.filter((write) => !stuck(write));
  const unreachable = writes.unsettled.length - waiting.length;
  const reading = {
    waiting,
    truncated: writes.truncated,
    corrected: corrections.length,
    stranded: strandedCount(stranded),
  } satisfies Reading;

  return (
    <div style={LAYOUT}>
      <StatBand stats={bandOf(reading, nowMs)} />
      <Panel
        actions={
          <span style={FAINT}>
            {chosen === undefined ? "select a row for custody" : eventOf(chosen)}
          </span>
        }
        padded={false}
        subtitle="oldest first, each bar its age against the longest wait on screen"
        title="Unsettled writes"
      >
        <Bars
          empty={unreachable > 0 ? ONLY_STRANDED : NOTHING_UNSETTLED}
          rows={waitBars(waiting, nowMs, setChosen)}
        />
        {unreachable > 0 && waiting.length > 0 ? (
          <p style={NOTE}>
            {unreachable} more {unreachable === 1 ? "write is" : "writes are"} unsettled in this
            ledger and not listed here: they are stranded, named below, and no receipt is coming for
            them. Counting them as waiting is what made this panel report hours of delay for writes
            that were never going to arrive.
          </p>
        ) : null}
      </Panel>
      <Custody chosen={chosen} nowMs={nowMs} source={source} />
      <Stranded held={stranded} />
      <Panel padded={false} subtitle="what an authority overruled, and why" title="Corrections">
        {corrections.length === 0 ? NOTHING_CORRECTED : null}
        {corrections.map((row) => (
          <Row
            key={row.id}
            label={row.reason}
            meta={`${row.event} · ${row.where}`}
            severity="high"
          />
        ))}
        {source.corrections === undefined ? (
          <p style={NOTE}>
            Read off the unsettled rows: this source carries no corrections reader, so a correction
            against a write that already settled is not listed here.
          </p>
        ) : null}
      </Panel>
      {writes.truncated ? (
        <p style={NOTE}>
          More writes are waiting than this page asked for, so the count above is a floor rather
          than a total — a ledger that stays unsettled is the finding, and the exact number is not.
        </p>
      ) : null}
    </div>
  );
}

export const writesTab = {
  id: "writes",
  label: "Writes",
  icon: <Icon name="query" size={14} />,
  render: Writes,
} satisfies DevtoolsTab<WritesSource>;
