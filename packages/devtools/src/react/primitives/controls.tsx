import type { ReactNode } from "react";

import { PREFIX } from "../../css.js";
import { COLOR, RADIUS, SPACE, TEXT } from "../../tokens.js";
import { Icon } from "../icons.js";

/**
 * The two controls every panel ends up needing: which view, and which rows.
 *
 * The tab bar's indicator is a 1px rule sitting *on* the bar's own bottom border rather than above
 * it, so switching tabs moves one line instead of adding one — nothing else in the header shifts.
 * The search field and the filter select are one visual unit for the same reason they are usually
 * used together: you narrow by kind, then you narrow by name.
 */

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode | undefined;
  /** A count, or a severity tag. Sits after the label and is allowed to be the only colour here. */
  readonly badge?: ReactNode | undefined;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly active: string | undefined;
  readonly onSelect: (id: string) => void;
  /** The accessible name for the bar — "panels", "sections". Screen readers read it before the tabs. */
  readonly label?: string | undefined;
  /**
   * Off when the bar sits inside a header that already draws that hairline: the active indicator
   * is positioned to land *on* it, and two lines one pixel apart is a smudge, not a rule.
   */
  readonly bordered?: boolean | undefined;
  /** The id of the element these tabs swap, so a screen reader can follow the switch. */
  readonly controls?: string | undefined;
}

export function Tabs({
  items,
  active,
  onSelect,
  label = "panels",
  bordered = true,
  controls,
}: TabsProps) {
  return (
    <div
      aria-label={label}
      className={`${PREFIX}-scroll`}
      role="tablist"
      style={{
        display: "flex",
        alignItems: "stretch",
        height: 34,
        overflowY: "hidden",
        borderBottom: bordered ? `1px solid ${COLOR.hairline}` : undefined,
      }}
    >
      {items.map((item) => (
        <button
          aria-controls={controls}
          aria-selected={item.id === active}
          className={`${PREFIX}-tab`}
          key={item.id}
          onClick={() => onSelect(item.id)}
          role="tab"
          style={TEXT.sm}
          type="button"
        >
          {item.icon}
          {item.label}
          {item.badge}
        </button>
      ))}
    </div>
  );
}

export interface NavProps {
  readonly items: readonly TabItem[];
  readonly active: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly label?: string | undefined;
}

/**
 * The vertical twin of {@link Tabs}, for a panel whose sections are a list rather than a bar — the
 * tables in a store, the transports on a device.
 *
 * The current row is marked three ways at once, and needs to be: a raised fill, a hairline border,
 * and a chevron. On a surface this dark a fill alone is a difference of four percent grey, which
 * is invisible on a laptop screen at an angle and to anyone who does not already know it is there.
 */
export function Nav({ items, active, onSelect, label = "sections" }: NavProps) {
  return (
    <nav aria-label={label} style={{ display: "grid", gap: 2, padding: SPACE.sm, minWidth: 0 }}>
      {items.map((item) => (
        <button
          aria-current={item.id === active}
          className={`${PREFIX}-side`}
          key={item.id}
          onClick={() => onSelect(item.id)}
          style={TEXT.sm}
          type="button"
        >
          {item.icon}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.label}
          </span>
          {item.badge}
          {item.id === active ? <Icon name="chevron-right" size={13} /> : null}
        </button>
      ))}
    </nav>
  );
}

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface ToolbarProps {
  readonly search?: string | undefined;
  readonly onSearch?: (value: string) => void | undefined;
  readonly placeholder?: string | undefined;
  readonly filter?: string | undefined;
  readonly filterOptions?: readonly FilterOption[] | undefined;
  readonly onFilter?: (value: string) => void | undefined;
  /** Trailing controls — a density toggle, a clear button. Kept right so the search stays leftmost. */
  readonly children?: ReactNode | undefined;
}

export function Toolbar({
  search,
  onSearch,
  placeholder = "Search…",
  filter,
  filterOptions,
  onFilter,
  children,
}: ToolbarProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, minWidth: 0 }}>
      {onSearch === undefined ? null : (
        <div
          className={`${PREFIX}-input`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: SPACE.sm,
            padding: `0 ${SPACE.sm}px`,
            height: 26,
            flex: 1,
            minWidth: 120,
            color: COLOR.textFaint,
          }}
        >
          <Icon name="search" size={13} />
          <input
            aria-label={placeholder}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={placeholder}
            style={{ ...TEXT.xs, flex: 1, minWidth: 0, width: "100%", background: "none" }}
            value={search ?? ""}
          />
        </div>
      )}
      {filterOptions === undefined || onFilter === undefined ? null : (
        <div style={{ position: "relative", flex: "none" }}>
          <select
            className={`${PREFIX}-select`}
            onChange={(event) => onFilter(event.target.value)}
            style={{
              ...TEXT.xs,
              height: 26,
              padding: `0 ${SPACE.xl}px 0 ${SPACE.sm}px`,
              borderRadius: RADIUS.md,
            }}
            value={filter ?? ""}
          >
            {filterOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span
            style={{
              position: "absolute",
              right: 7,
              top: 7,
              pointerEvents: "none",
              color: COLOR.textFaint,
            }}
          >
            <Icon name="chevron-down" size={12} />
          </span>
        </div>
      )}
      {children}
    </div>
  );
}
