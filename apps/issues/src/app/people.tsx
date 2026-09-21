import { useLiveQuery } from "@syncmesh/react";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import type { MemberRow } from "./view.js";

import { WORKSPACE_ID } from "../domain.js";
import { Avatar } from "./atoms.js";
import { useActing, useApi } from "./context.js";
import { enterAs } from "./install.js";
import { BUTTON, COLOR, HAIRLINE, RADIUS, SPACE, TEXT } from "./ui.js";

/**
 * Who is in this workspace, and how much open work each of them is carrying.
 *
 * **A roster, not a filter.** The sidebar has had a People section for a while, but that is a list
 * of names that narrows a query — it cannot answer "who is drowning", "who has nothing on", or
 * "who am I". This screen is the noun; each row carries the two verbs.
 *
 * **The counts are one grouped read.** `members.workload` is a single `GROUP BY` over the open
 * statuses, and the alternative — a `count` per person — is the shape that looks harmless at
 * twelve people and is a subscription per row at two hundred, every one of them re-running on
 * every fold. The map is built once here and read by every row.
 *
 * A zero is drawn rather than left blank, because "nothing assigned" is a fact about a person and
 * an empty cell is the same pixels as a count that failed to arrive.
 */

/** A row of the roster: the person, their load, and the two things a click can mean. */
function Person({
  who,
  open,
  mine,
  onEnter,
}: {
  readonly who: MemberRow;
  readonly open: number;
  readonly mine: boolean;
  readonly onEnter: () => void;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        borderBottom: HAIRLINE,
        display: "flex",
        gap: SPACE.sm,
        padding: `${String(SPACE.sm)}px 0`,
      }}
    >
      <Avatar size={26} who={who} />
      <span style={{ display: "grid", flex: 1, gap: 1, minWidth: 0 }}>
        <span style={{ alignItems: "center", display: "flex", gap: SPACE.xs }}>
          <span style={{ ...TEXT.sm, overflow: "hidden", textOverflow: "ellipsis" }}>
            {who.name}
          </span>
          {mine ? (
            <span
              style={{
                ...TEXT.xs,
                background: COLOR.raised,
                borderRadius: RADIUS.pill,
                color: COLOR.textDim,
                padding: `0 ${String(SPACE.sm)}px`,
              }}
            >
              you
            </span>
          ) : null}
        </span>
        <span style={{ ...TEXT.xs, color: COLOR.textFaint }}>@{who.handle}</span>
      </span>
      <span
        style={{ ...TEXT.sm, color: COLOR.textDim, fontVariantNumeric: "tabular-nums" }}
        title={`${String(open)} open issues assigned`}
      >
        {open}
      </span>
      {/* both affordances are on screen rather than behind a menu, because a phone had to ask
          which one a tap meant and a window does not have to: the row is wide enough to say */}
      <Link search={{ assignee: who.id }} style={{ ...BUTTON, textDecoration: "none" }} to="/">
        Their issues
      </Link>
      <button
        disabled={mine}
        onClick={onEnter}
        style={{ ...BUTTON, color: mine ? COLOR.textFaint : COLOR.textDim }}
        type="button"
      >
        {mine ? "This is you" : "Go in as"}
      </button>
    </div>
  );
}

export function People() {
  const api = useApi();
  const acting = useActing();
  const people = useLiveQuery(api.members.list({ workspaceId: WORKSPACE_ID })).data;
  const workload = useLiveQuery(api.members.workload({ workspaceId: WORKSPACE_ID })).data;

  /** One pass over the grouped read, so a row is a lookup rather than a scan. */
  const openBy = useMemo(
    () =>
      new Map(
        workload.flatMap((row) =>
          row.assigneeId === null ? [] : [[row.assigneeId, row.open] as const],
        ),
      ),
    [workload],
  );

  if (people.length === 0)
    return (
      <p style={{ ...TEXT.sm, color: COLOR.textFaint }}>
        Nobody is in this workspace yet, or this device has not heard about them — the roster fills
        in as the mesh catches up.
      </p>
    );

  return (
    <>
      <p style={{ ...TEXT.sm, color: COLOR.textDim, marginTop: 0 }}>
        {people.length} people. The number beside each is how many open issues they are assigned —
        one grouped read over the whole workspace, not one question per person.
      </p>
      {people.map((who) => (
        <Person
          key={who.id}
          mine={who.id === acting.actor.account}
          onEnter={() =>
            // the role is carried over rather than reset: somebody switching from the roster is
            // changing who, not what they may do — the picker is where that is chosen
            enterAs({ account: who.id, role: acting.actor.role })
          }
          open={openBy.get(who.id) ?? 0}
          who={who}
        />
      ))}
    </>
  );
}
