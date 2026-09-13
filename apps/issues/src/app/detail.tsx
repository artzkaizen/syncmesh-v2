import { useCan, useQuery } from "@syncmesh/react";
import { useEffect } from "react";

import type { IssueRow, Panel } from "./view.js";

import { ISSUE_STATUS, PRIORITY_NAME, WORKSPACE_ID } from "../domain.js";
import { Avatar, Identifier, LabelChip, Section, StatusMark } from "./atoms.js";
import { useCatalog, useReplica, useShownRows } from "./context.js";
import { SyncBadge } from "./sync-badge.js";
import { Thread } from "./thread.js";
import {
  BUTTON,
  CAPTION,
  COLOR,
  DETAIL_WIDTH,
  HAIRLINE,
  RADIUS,
  SPACE,
  TEXT,
  ago,
  statusStyle,
} from "./ui.js";
import { panelFor } from "./view.js";

/**
 * One issue, opened.
 *
 * Every control here is a procedure call and nothing else — `issues.setStatus`, `issues.assign`,
 * `issueLabels.attach`. None of them awaits anything: a write is a statement, the live query
 * underneath this panel re-runs when the fold lands, and the row redraws. That is why there is no
 * loading state on any button and no optimistic copy of the issue in React state; the optimism is
 * the replica's, and it is real rather than simulated.
 */

function StatusPicker({ row }: { readonly row: IssueRow }) {
  const { api, actor } = useReplica();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: SPACE.xs }}>
      {ISSUE_STATUS.map((status) => (
        <button
          key={status}
          onClick={() =>
            api.issues.setStatus({ workspaceId: WORKSPACE_ID, id: row.id, actorId: actor, status })
          }
          style={{
            ...BUTTON,
            alignItems: "center",
            background: row.status === status ? COLOR.raised : "transparent",
            color: row.status === status ? COLOR.text : COLOR.textDim,
            display: "inline-flex",
            gap: SPACE.xs,
          }}
          type="button"
        >
          <StatusMark status={status} />
          {statusStyle(status).label}
        </button>
      ))}
    </div>
  );
}

/**
 * Assignment, and the one control on this panel that is not a button.
 *
 * It hands the keyboard back the moment it commits, which reads like a flourish and is not. A
 * `<select>` that still holds focus with its list shut is a live control: the browser answers a
 * plain letter key with typeahead, moves the selection and fires `change`, with no list on screen
 * to say so. Everywhere else on the web that is harmless, because the form has a submit button
 * between the stray keystroke and the record. Here `change` *is* the write — it is logged,
 * attributed and synced before the finger is off the key — so a picker left focused after a
 * mouse pick turns the next letter typed anywhere on the page into an assignment nobody made.
 * Three of them were traced to exactly this. Blurring costs a keyboard user their place in the
 * panel, which is the lesser harm of the two by some distance.
 */
function AssigneePicker({ row }: { readonly row: IssueRow }) {
  const { api, actor } = useReplica();
  const catalog = useCatalog();
  return (
    <div style={{ alignItems: "center", display: "flex", gap: SPACE.sm }}>
      <Avatar who={row.assigneeId === null ? undefined : catalog.member.get(row.assigneeId)} />
      <select
        onChange={(event) => {
          api.issues.assign({
            workspaceId: WORKSPACE_ID,
            id: row.id,
            actorId: actor,
            assigneeId: event.target.value === "" ? null : event.target.value,
          });
          event.target.blur();
        }}
        style={{ ...BUTTON, color: COLOR.text }}
        value={row.assigneeId ?? ""}
      >
        <option value="">Unassigned</option>
        {catalog.members.map((who) => (
          <option key={who.id} value={who.id}>
            {who.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function PriorityPicker({ row }: { readonly row: IssueRow }) {
  const { api, actor } = useReplica();
  return (
    <div style={{ display: "flex", gap: SPACE.xs }}>
      {PRIORITY_NAME.map((name, level) => (
        <button
          key={name}
          onClick={() =>
            api.issues.edit({
              workspaceId: WORKSPACE_ID,
              id: row.id,
              actorId: actor,
              priority: level,
            })
          }
          style={{
            ...BUTTON,
            background: row.priority === level ? COLOR.raised : "transparent",
            color: row.priority === level ? COLOR.text : COLOR.textDim,
          }}
          type="button"
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/** Attach and detach, as a row of every label with the attached ones lit. Both are one row written. */
function LabelPicker({ row }: { readonly row: IssueRow }) {
  const { api, actor } = useReplica();
  const catalog = useCatalog();
  const attached = new Set(
    catalog.tags.filter((tag) => tag.issueId === row.id).map((tag) => tag.labelId),
  );
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: SPACE.xs }}>
      {catalog.labels.map((label) => (
        <button
          key={label.id}
          onClick={() => {
            const input = {
              workspaceId: WORKSPACE_ID,
              issueId: row.id,
              labelId: label.id,
              actorId: actor,
            };
            if (attached.has(label.id)) api.issueLabels.detach(input);
            else api.issueLabels.attach(input);
          }}
          style={{
            ...BUTTON,
            border: "none",
            opacity: attached.has(label.id) ? 1 : 0.35,
            padding: 0,
          }}
          type="button"
        >
          <LabelChip of={label} />
        </button>
      ))}
    </div>
  );
}

/**
 * The panel before it has an issue to draw, which is four different sentences and not one.
 *
 * Only `missing` is a claim about this device's storage, and it is the only one that needs every
 * source to have answered first. The other three are a read still running, a read that fell over,
 * and a mesh this device has not finished hearing from — each of them a reason not to know, and
 * none of them a reason to say no.
 */
const SAID = {
  "catching-up": "Not on this device yet — still hearing from the rest of the mesh.",
  missing: "That issue is not on this device.",
  waiting: "Opening\u2026",
} satisfies Record<Exclude<Panel, { kind: "open" | "unreadable" }>["kind"], string>;

function Blank({ panel }: { readonly panel: Exclude<Panel, { kind: "open" }> }) {
  return (
    <aside style={{ borderLeft: HAIRLINE, flex: "none", padding: SPACE.lg, width: DETAIL_WIDTH }}>
      <p style={{ ...TEXT.sm, color: COLOR.textFaint }}>
        {panel.kind === "unreadable"
          ? `This device could not read that issue: ${panel.reason}`
          : SAID[panel.kind]}
      </p>
    </aside>
  );
}

/**
 * The issues this tab has already counted a view for.
 *
 * **Opening an issue writes to the log, and that is a bigger thing than it looks.** The write is
 * signed, attributed to this device, replicated to every peer in the workspace and kept for as
 * long as the log is — for the act of *reading*. It was authored on every mount, and {@link Detail}
 * mounts per route match, so walking a list of twelve issues and back authored twenty-four events
 * nobody asked for. Left alone it reached 105 on one issue of a demo nobody had used for real,
 * and the number it was reporting had stopped being a fact about people and become a fact about
 * navigation.
 *
 * A view stays automatic, because asking someone to press a button to be counted measures button
 * presses. What it stops being is *per mount*: a view is now the first time this tab opens an
 * issue, which is the same definition every page-view counter on the web has settled on, and it
 * makes re-reading something free. The set is the tab's and dies with it, so a browser reopened
 * tomorrow counts tomorrow's reading — deliberately, since a set that outlived the tab would be
 * state to store, invalidate and get wrong for a column that is an approximation anyway.
 *
 * The column stays a PN-counter. Two people opening the same issue on two planes have both opened
 * it, and that is still the merge this app is demonstrating; see `procedures/writes.ts`.
 */
const counted = new Set<string>();

/**
 * Mounted **once per issue**, so switching issues replaces this panel rather than updating it.
 *
 * Gating the controls on the row having arrived — which `view.ts`'s `panelFor` also does — shortens the
 * window in which the wrong thing is on screen; remounting closes it. Were the panel merely
 * updated, the fiber, its DOM nodes and, decisively, the browser's focus would all survive the
 * move from one issue to the next, so the `<select>` the last issue was assigned with would still
 * be the focused element when the next issue's panel drew over it. That control commits on
 * `change`, and the browser will change it for a typed letter — see {@link AssigneePicker}. A
 * remount drops the node, and the focus with it, which is what makes "a control left over from
 * the issue before" unrepresentable instead of merely brief.
 *
 * The id used to be a prop with a `key` beside it. It is a **route param** now, and the router's
 * match id interpolates it, so two issues are two matches under two React keys and the remount is
 * the routing's rather than something a caller has to remember — `routes/_shell/issues/$issueId.tsx`
 * records the measurement that confirmed it.
 *
 * **It opens on the row the list already handed the screen, and only the badge waits.** The mesh
 * is in a dedicated worker, so `issues.get` is a `MessagePort` round trip; the hop itself is
 * 0.014 ms but the reply arrives as a task, so React is guaranteed to paint at least one frame
 * before the row does. Measured on a click, mesh warm: 12 ms of "Opening…" between the two
 * renders. That frame was being spent re-fetching an issue this tab already had in memory — the
 * identical row, out of the identical query, sitting one pane to the left — so the panel is built
 * from it and the read it asks for supplies the one column the list does not select. See
 * `view.ts`'s `panelFor`.
 */
export function Detail({ id, onClose }: { readonly id: string; readonly onClose: () => void }) {
  const { api } = useReplica();
  const catalog = useCatalog();
  const panel = panelFor(
    id,
    useQuery(api.issues.get({ workspaceId: WORKSPACE_ID, id })),
    useShownRows(),
  );

  // opening an issue counts as a view, **once per issue per tab** — see `counted` above
  useEffect(() => {
    if (counted.has(id)) return;
    counted.add(id);
    api.issues.view({ workspaceId: WORKSPACE_ID, id });
  }, [api, id]);

  /**
   * The destructive gate rehearses; the editing one asks the rule by name.
   *
   * Rehearsing is the stronger check: the handler runs against the replica, the staged change is
   * judged by the rules every receiver runs, and the transaction rolls back — so this panel cannot
   * keep a second, drifting copy of a rule. Asking the rule by name is a prediction of that.
   *
   * It is worth knowing what this line cost before it was safe. Wired up, it used to **delete the
   * issue it was asked about** — 120 issues down to 119 for every detail panel opened, with no
   * `issue.delete` in the ledger to show for it. The handle kept one transaction slot and could
   * not tell two borrowers apart, so the rehearsal and this panel's `views` bump each overwrote
   * the other, and the rehearsed `DELETE` was committed by the view write's `COMMIT`. The handle
   * now takes turns and a rehearsal holds one from `BEGIN` to settle, so the two serialise.
   *
   * Turns only ever ordered *transactions* against each other, though, and the read on the line
   * above is not one. It joined the rehearsal instead of waiting for it and came back with zero
   * rows for an issue that is on this device — this panel saying "That issue is not on this
   * device" about a row the list was drawing, on essentially every open. A statement is placed by
   * the sink it came through now, so the rehearsal's staged `DELETE` is invisible to this read.
   */
  const mayDelete = useCan(api.issues.remove.can({ workspaceId: WORKSPACE_ID, id }));
  const mayEdit = useCan(api.$can, "issue.update");

  if (panel.kind !== "open") return <Blank panel={panel} />;

  const { row } = panel;
  const team = catalog.team.get(row.teamId);
  return (
    <aside
      style={{
        borderLeft: HAIRLINE,
        display: "flex",
        flex: "none",
        flexDirection: "column",
        overflowY: "auto",
        width: DETAIL_WIDTH,
      }}
    >
      <div style={{ display: "grid", gap: SPACE.lg, padding: SPACE.lg }}>
        <div style={{ alignItems: "center", display: "flex", gap: SPACE.sm }}>
          <Identifier number={row.number} teamKey={team?.key ?? "???"} />
          <SyncBadge id={row.id} operation={panel.operation} />
          <span style={{ ...TEXT.xs, color: COLOR.textFaint, marginLeft: "auto" }}>
            {row.views} views · updated {ago(row.updatedAt)}
          </span>
          <button onClick={onClose} style={BUTTON} type="button">
            Close
          </button>
        </div>

        <h1 style={{ ...TEXT.md, color: COLOR.text, fontSize: 17, fontWeight: 500, margin: 0 }}>
          {row.title}
        </h1>
        <p style={{ ...TEXT.sm, color: COLOR.textDim, margin: 0, whiteSpace: "pre-wrap" }}>
          {row.description}
        </p>

        {mayEdit ? (
          <>
            <Section title="Status">
              <StatusPicker row={row} />
            </Section>
            <Section title="Assignee">
              <AssigneePicker row={row} />
            </Section>
            <Section title="Priority">
              <PriorityPicker row={row} />
            </Section>
            <Section title="Labels">
              <LabelPicker row={row} />
            </Section>
          </>
        ) : (
          <span style={CAPTION}>Read-only: this device holds no grant that may edit issues.</span>
        )}

        <button
          disabled={!mayDelete}
          onClick={() => {
            api.issues.remove({ workspaceId: WORKSPACE_ID, id: row.id });
            onClose();
          }}
          style={{
            ...BUTTON,
            borderRadius: RADIUS.sm,
            color: mayDelete ? COLOR.text : COLOR.textFaint,
            cursor: mayDelete ? "pointer" : "not-allowed",
            justifySelf: "start",
          }}
          title={
            mayDelete
              ? "Deleting an issue is an admin's"
              : "The manifest refuses this to the grant this device holds"
          }
          type="button"
        >
          Delete
        </button>
      </div>
      <Thread issueId={row.id} />
    </aside>
  );
}
