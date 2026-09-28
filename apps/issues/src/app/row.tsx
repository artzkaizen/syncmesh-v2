import type { IssueRow } from "./view.js";

import { Avatar, Identifier, LabelChip, PriorityMark, StatusMark } from "./atoms.js";
import { useCatalog } from "./context.js";
import { COLOR, ROW_HEIGHT, SPACE, TEXT, ago } from "./ui.js";

/**
 * One issue, as a line.
 *
 * Everything on it is read out of the catalog by id rather than joined in SQL, and that is a
 * deliberate shape rather than laziness: a join would make the board query re-run whenever anyone
 * renamed a label, and the board query is the expensive one. The catalog is four small live
 * subscriptions the whole app shares, so a rename repaints the chips and leaves the hundred-row
 * read alone.
 */

export interface RowProps {
  readonly row: IssueRow;
  readonly labelIds: readonly string[];
  readonly selected: boolean;
  readonly movable: boolean;
  /** The card being dragged would land immediately above this one — drawn as a line, not a gap. */
  readonly landing: boolean;
  readonly onSelect: () => void;
  readonly onLift: () => void;
  readonly onOver: () => void;
  readonly onDrop: () => void;
}

export function Row(props: RowProps) {
  const { row, labelIds, selected, movable, landing } = props;
  const catalog = useCatalog();
  const team = catalog.team.get(row.teamId);
  const project = row.projectId === null ? undefined : catalog.project.get(row.projectId);

  return (
    <div
      draggable={movable}
      onClick={props.onSelect}
      onDragEnd={props.onDrop}
      onDragOver={(event) => {
        if (!movable) return;
        // without this the browser refuses the drop and the card animates back to where it was
        event.preventDefault();
        // and without this the section's own "drop at the end" handler runs a moment later, as
        // the same event bubbles up through it, and overwrites the row the pointer is actually on
        event.stopPropagation();
        props.onOver();
      }}
      onDragStart={props.onLift}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onDrop();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") props.onSelect();
      }}
      role="button"
      style={{
        alignItems: "center",
        background: selected ? COLOR.raised : "transparent",
        borderTop: landing ? `2px solid ${COLOR.crosshair}` : "2px solid transparent",
        cursor: movable ? "grab" : "pointer",
        display: "flex",
        gap: SPACE.sm,
        height: ROW_HEIGHT,
        padding: `0 ${String(SPACE.lg)}px`,
      }}
      tabIndex={0}
    >
      <PriorityMark priority={row.priority} />
      <Identifier number={row.number} teamKey={team?.key ?? "???"} />
      <StatusMark status={row.status} />
      <span
        style={{
          ...TEXT.md,
          color: COLOR.text,
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.title}
      </span>
      <span style={{ display: "flex", gap: SPACE.xs, overflow: "hidden" }}>
        {labelIds.slice(0, 3).map((id) => {
          const label = catalog.label.get(id);
          return label === undefined ? null : <LabelChip key={id} of={label} />;
        })}
      </span>
      {project === undefined ? null : (
        <span style={{ ...TEXT.xs, color: COLOR.textFaint, flex: "none" }}>{project.name}</span>
      )}
      <span
        style={{ ...TEXT.xs, color: COLOR.textFaint, flex: "none", width: 34, textAlign: "right" }}
      >
        {ago(row.updatedAt)}
      </span>
      <Avatar who={row.assigneeId === null ? undefined : catalog.member.get(row.assigneeId)} />
    </div>
  );
}
