import type { IssueStatus } from "../domain.js";
import type { Group } from "./view.js";

import { Row } from "./row.js";
import { CAPTION, COLOR, HAIRLINE, SPACE, STATUS_STYLE, TEXT } from "./ui.js";

/**
 * One status group: a sticky header, its rows, and the two drop targets they make between them.
 *
 * Its own file because the list had outgrown one, and this is the seam that was worth cutting on
 * — everything about *a group* is here, and `list.tsx` is left with the question of which rows
 * there are at all.
 */

/** Where a dragged card would land: a status section, and the row it would go above. */
export interface Landing {
  readonly status: IssueStatus;
  /** `null` is the end of the section — dropped on the header strip or below the last row. */
  readonly beforeId: string | null;
}

interface SectionProps {
  readonly group: Group;
  readonly chips: ReadonlyMap<string, readonly string[]>;
  readonly movable: boolean;
  readonly landing: Landing | undefined;
  readonly selectedId: string | undefined;
  readonly onLift: (id: string) => void;
  readonly onOver: (where: Landing) => void;
  readonly onDrop: () => void;
  readonly onSelect: (id: string) => void;
}

/**
 * One status section. The **header** is a drop target too, and that is not a detail: an empty
 * column is exactly where somebody wants to drag the first card, and a section that only accepted
 * drops onto existing rows could never receive one.
 */
export function Section(props: SectionProps) {
  const { group, landing, movable } = props;
  const { color, label } = STATUS_STYLE[group.status];
  const here = landing?.status === group.status ? landing : undefined;
  return (
    <div
      onDragOver={(event) => {
        if (!movable) return;
        event.preventDefault();
        props.onOver({ status: group.status, beforeId: null });
      }}
      onDrop={props.onDrop}
    >
      <div
        style={{
          alignItems: "center",
          background: COLOR.sunken,
          borderBottom: HAIRLINE,
          borderTop: HAIRLINE,
          display: "flex",
          gap: SPACE.sm,
          padding: `${String(SPACE.xs)}px ${String(SPACE.lg)}px`,
          position: "sticky",
          top: 0,
          zIndex: 1,
        }}
      >
        <span style={{ background: color, borderRadius: 999, height: 6, width: 6 }} />
        <span style={{ ...CAPTION, color: COLOR.text }}>{label}</span>
        <span style={{ ...TEXT.xs, color: COLOR.textFaint }}>{group.rows.length}</span>
      </div>
      {group.rows.map((row) => (
        <Row
          key={row.id}
          labelIds={props.chips.get(row.id) ?? []}
          landing={here?.beforeId === row.id}
          movable={movable}
          onDrop={props.onDrop}
          onLift={() => props.onLift(row.id)}
          onOver={() => props.onOver({ status: group.status, beforeId: row.id })}
          onSelect={() => props.onSelect(row.id)}
          row={row}
          selected={props.selectedId === row.id}
        />
      ))}
    </div>
  );
}
