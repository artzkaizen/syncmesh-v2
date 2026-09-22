import type { QueryResult } from "@syncmesh/react";

import { useOperation } from "@syncmesh/react";
import { useMemo, useRef, useState } from "react";

import type { Landing } from "./section.js";
import type { Counted, Filters, IssueRow, Sort } from "./view.js";

import { WORKSPACE_ID } from "../domain.js";
import { useActor, useCatalog, useApi, useFollower } from "./context.js";
import { Section } from "./section.js";
import { BUTTON, CAPTION, COLOR, HAIRLINE, SPACE, TEXT } from "./ui.js";
import { useIssueCounts } from "./use-issues.js";
import {
  SORTS,
  SORT_LABEL,
  countText,
  countsFor,
  moreIn,
  dropBetween,
  groupByStatus,
  isDraggable,
  labelsByIssue,
  shownStatuses,
  sortIssues,
  taggedWith,
  totalOf,
} from "./view.js";

/**
 * The list: one filtered read, grouped into status sections, dragged into order.
 *
 * Search and filter are two different procedures (`issues.search`, `issues.list`) and exactly one
 * of them is live at a time — not because the other is disabled, but because `use-issues.ts`
 * chooses between the two descriptors and passes the one it picked. A descriptor is inert until a
 * hook runs it, so the branch happens on the value rather than around the hook call, which is
 * what keeps this one subscription however the screen is asked.
 *
 * The label filter is applied here rather than in the procedure, because a label is a membership
 * table and filtering by one in SQL would mean a join that re-runs the whole list whenever anyone
 * labelled anything. The attachments are already in the catalog as one small live read; testing a
 * set against them is cheaper than the join and repaints only this component.
 */

function SortBar({
  sort,
  onSort,
  shown,
}: {
  readonly sort: Sort;
  readonly onSort: (next: Sort) => void;
  /** The count read's answer, not the length of the page under it — see `view.ts`'s `Counted`. */
  readonly shown: Counted;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        borderBottom: HAIRLINE,
        display: "flex",
        flex: "none",
        gap: SPACE.xs,
        padding: `${String(SPACE.sm)}px ${String(SPACE.lg)}px`,
      }}
    >
      <span style={{ ...CAPTION, marginRight: "auto" }}>
        {countText(shown)} {shown.kind !== "unknown" && shown.value === 1 ? "issue" : "issues"}
      </span>
      <span style={{ ...CAPTION, color: COLOR.textFaint }}>Sort</span>
      {SORTS.map((option) => (
        <button
          key={option}
          onClick={() => onSort(option)}
          style={{
            ...BUTTON,
            background: sort === option ? COLOR.raised : "transparent",
            borderColor: sort === option ? COLOR.hairlineStrong : COLOR.hairline,
            color: sort === option ? COLOR.text : COLOR.textDim,
          }}
          title={
            option === "manual"
              ? "The workspace's own order — the only sort you can drag"
              : undefined
          }
          type="button"
        >
          {SORT_LABEL[option]}
        </button>
      ))}
    </div>
  );
}

/*
 * The durable record of the last drag used to be read back here, from `mesh.operations`, and is
 * not any more: the ledger is the *engine's*, and the engine is in the elected tab's worker. What
 * crosses the port is the data and the live queries over it, so a window can see that the move
 * landed — the rows move — but not the operation record behind it. Reinstating it means serving
 * the ledger to a tab, which is `@syncmesh/browser`'s protocol to widen.
 */

/**
 * The durable record of the last drag, read back from the ledger rather than from the call.
 *
 * The id is handed over the moment the write is made, before the commit resolves, so this follows
 * the operation through its whole life rather than picking it up once it has settled — which is
 * what a durable operation record is for. A record that does not exist yet renders nothing;
 * `onChange` announces it when the write's fold makes it real, and that announcement reaches this
 * window across the port whichever tab holds the engine.
 */
function LastMove({ id }: { readonly id: string | undefined }) {
  const mesh = useFollower();
  const record = useOperation(mesh.operations, id);
  if (record === undefined) return null;
  return (
    <div
      style={{
        ...TEXT.xs,
        borderTop: HAIRLINE,
        color: COLOR.textFaint,
        flex: "none",
        padding: `${String(SPACE.sm)}px ${String(SPACE.lg)}px`,
      }}
    >
      last move — {record.label}: {record.status}
      {record.correction === undefined ? "" : ` (overruled: ${record.correction.reason})`}
    </div>
  );
}

export interface ListProps {
  readonly filters: Filters;
  readonly sort: Sort;
  readonly onSort: (next: Sort) => void;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
  /** From `useIssues`, held one level up because the panel is judged against it too. */
  readonly answer: QueryResult<IssueRow>;
  /** Widens every status's window by a step. Held beside the read, in `routes/_shell/route.tsx`. */
  readonly onMore: () => void;
}

export function List(props: ListProps) {
  const { answer, filters, sort, selectedId } = props;
  const api = useApi();
  const actor = useActor().account;
  const catalog = useCatalog();
  /**
   * The drag lives in refs and is only mirrored into state for the insertion line.
   *
   * A drop has to read what the drag picked up, and `dragstart` and `drop` are two events with a
   * render between them at best — and *no* render between them when the gesture is fast or
   * synthetic. A `useState` value read from `commit`'s closure is the value as of the render that
   * installed the handler, so a drag that outran React would compute its neighbours from
   * `undefined` and silently do nothing. Refs are what the DOM's own event sequence deserves; the
   * state beside them exists only so the line under the cursor moves.
   */
  const lifted = useRef<string>(undefined);
  const landed = useRef<Landing>(undefined);
  const [landing, setLanding] = useState<Landing>();
  const [lastMove, setLastMove] = useState<string>();

  const lift = (id: string) => {
    lifted.current = id;
  };
  const over = (where: Landing) => {
    landed.current = where;
    setLanding((held) =>
      held?.status === where.status && held.beforeId === where.beforeId ? held : where,
    );
  };

  const tags = catalog.tags;
  const rows = useMemo(() => {
    const base = answer.data ?? [];
    const wanted = filters.labelId === null ? undefined : taggedWith(tags, filters.labelId);
    return sortIssues(wanted === undefined ? base : base.filter((row) => wanted.has(row.id)), sort);
  }, [answer.data, filters.labelId, tags, sort]);
  /**
   * The statuses on screen, the rows under each, and the badge beside each — three separate
   * facts, because they have three different completenesses. `statuses` is what the filters can
   * reach, `groups` is the page this device is drawing, and `counts` is a `GROUP BY` with no
   * `LIMIT`. Only the last one may be rendered as a number.
   */
  const statuses = useMemo(() => shownStatuses(filters), [filters]);
  const groups = useMemo(() => groupByStatus(rows, statuses), [rows, statuses]);
  const tally = useIssueCounts(filters);
  const counts = useMemo(
    // no page-length inference left: the badge is a GROUP BY with no LIMIT and the rows are a
    // window over the same filters, so `atLeast` survives only where there is no count read
    () => countsFor(statuses, groups, tally.data, false),
    [statuses, groups, tally.data],
  );
  const chips = useMemo(() => labelsByIssue(tags), [tags]);
  const movable = isDraggable(sort);

  /**
   * One write for the whole gesture. `issues.move` takes the neighbours rather than a rank,
   * reads their ranks on the device, and sets status in the same transaction — so a card dragged
   * across two columns never exists in neither for the length of a fold.
   */
  const commit = () => {
    const held = lifted.current;
    const where = landed.current;
    const moved = held === undefined ? undefined : rows.find((row) => row.id === held);
    if (moved !== undefined && where !== undefined) {
      const section = groups.find((group) => group.status === where.status);
      const order = (section?.rows ?? []).map((row) => row.id);
      const input = {
        workspaceId: WORKSPACE_ID,
        id: moved.id,
        actorId: actor,
        ...dropBetween(order, moved.id, where.beforeId),
      };
      if (moved.status !== where.status) Object.assign(input, { status: where.status });
      // the id is the write's, handed back synchronously, so the record can be followed from
      // before it exists rather than only once a receipt has landed
      setLastMove(api.issues.move(input).id);
    }
    lifted.current = undefined;
    landed.current = undefined;
    setLanding(undefined);
  };

  return (
    <section
      style={{ display: "flex", flex: 1, flexDirection: "column", minWidth: 0, overflow: "hidden" }}
    >
      <SortBar onSort={props.onSort} shown={totalOf(counts)} sort={sort} />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {answer.answered === "none" ? (
          // <Notice>
          //   {answer.error === undefined
          //     ? "Reading the local replica…"
          //     : `This device could not read the list: ${answer.error.message}`}
          // </Notice>
          <></>
        ) : rows.length === 0 ? (
          <Notice>
            {answer.answered === "settled"
              ? "Nothing matches these filters."
              : "Nothing here yet — still hearing from the rest of the mesh."}
          </Notice>
        ) : (
          groups.map((group) => (
            <Section
              chips={chips}
              count={counts.get(group.status) ?? { kind: "unknown" }}
              group={group}
              more={moreIn(counts.get(group.status) ?? { kind: "unknown" }, group.rows.length)}
              onMore={props.onMore}
              key={group.status}
              landing={landing}
              movable={movable}
              onDrop={commit}
              onLift={lift}
              onOver={over}
              onSelect={props.onSelect}
              selectedId={selectedId}
            />
          ))
        )}
      </div>
      <LastMove id={lastMove} />
    </section>
  );
}

const Notice = ({ children }: { readonly children: string }) => (
  <p style={{ ...TEXT.sm, color: COLOR.textFaint, padding: SPACE.xl, textAlign: "center" }}>
    {children}
  </p>
);
