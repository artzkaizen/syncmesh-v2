import type { ReactNode } from "react";

import { PREFIX } from "../../css.js";
import { COLOR, SPACE, TEXT } from "../../tokens.js";

/**
 * Columns as data, because a devtools table is read by scanning one column at a time.
 *
 * Widths are declared rather than computed: a table whose columns resize as rows stream in is
 * unreadable precisely when it matters most, which is while something is happening. The header is
 * the same uppercase micro type as a stat's caption, so the two kinds of label look like one
 * vocabulary rather than two.
 */

export interface Column<Row> {
  readonly key: string;
  readonly header: string;
  /** A CSS track — `80px`, `1fr`, `minmax(0, 2fr)`. Every column must declare one. */
  readonly width: string;
  readonly align?: "left" | "right" | undefined;
  readonly render: (row: Row) => ReactNode;
}

export interface TableProps<Row> {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  /** Rendered instead of the body when there are no rows — an `<Empty>`, usually. */
  readonly empty?: ReactNode | undefined;
  /** The trailing cell, revealed on hover. Given the row, so one handler serves the whole table. */
  readonly action?: (row: Row) => ReactNode | undefined;
}

export function Table<Row>({ columns, rows, rowKey, empty, action }: TableProps<Row>) {
  const template = `${columns.map((column) => column.width).join(" ")}${action === undefined ? "" : " 28px"}`;
  const cell = (align: Column<Row>["align"]) => ({
    textAlign: align ?? "left",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    minWidth: 0,
  });
  return (
    <div role="table" style={{ minWidth: 0 }}>
      <div
        role="row"
        style={{
          ...TEXT.micro,
          display: "grid",
          gridTemplateColumns: template,
          gap: SPACE.md,
          padding: `${SPACE.sm}px ${SPACE.md}px`,
          color: COLOR.textFaint,
          borderBottom: `1px solid ${COLOR.hairline}`,
        }}
      >
        {columns.map((column) => (
          <div key={column.key} role="columnheader" style={cell(column.align)}>
            {column.header}
          </div>
        ))}
        {action === undefined ? null : <div role="columnheader" />}
      </div>
      {rows.length === 0
        ? empty
        : rows.map((row) => (
            <div
              className={`${PREFIX}-row`}
              key={rowKey(row)}
              role="row"
              style={{
                ...TEXT.sm,
                display: "grid",
                gridTemplateColumns: template,
                gap: SPACE.md,
                alignItems: "center",
                padding: `${SPACE.sm}px ${SPACE.md}px`,
                color: COLOR.textDim,
                borderBottom: `1px solid ${COLOR.hairline}`,
              }}
            >
              {columns.map((column) => (
                <div key={column.key} role="cell" style={cell(column.align)}>
                  {column.render(row)}
                </div>
              ))}
              {action === undefined ? null : (
                <div className={`${PREFIX}-action`} role="cell">
                  {action(row)}
                </div>
              )}
            </div>
          ))}
    </div>
  );
}
