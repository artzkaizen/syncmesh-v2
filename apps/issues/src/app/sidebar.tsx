import type { ReactNode } from "react";

import { useLiveQuery } from "@syncmesh/react";

import type { Filters } from "./view.js";

import { WORKSPACE_ID } from "../domain.js";
import { Avatar, Section } from "./atoms.js";
import { useActor, useCatalog, useApi } from "./context.js";
import { COLOR, HAIRLINE, RADIUS, SIDEBAR_WIDTH, SPACE, TEXT } from "./ui.js";

/**
 * The filters, down the left.
 *
 * Every one of them narrows the *same* `issues.list` call rather than switching to a different
 * procedure, which is what lets them compose: "Bo's open performance bugs in Engineering" is four
 * of these at once, and four procedures could not have answered it. Clicking a selected filter
 * clears it, so there is no separate "all" row to keep in step with the real state.
 */

function FilterRow({
  active,
  onClick,
  lead,
  children,
  trailing,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly lead?: ReactNode;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        alignItems: "center",
        appearance: "none",
        background: active ? COLOR.raised : "transparent",
        border: "none",
        borderRadius: RADIUS.sm,
        color: active ? COLOR.text : COLOR.textDim,
        cursor: "pointer",
        display: "flex",
        font: "inherit",
        gap: SPACE.sm,
        padding: `${String(SPACE.xs)}px ${String(SPACE.sm)}px`,
        textAlign: "left",
        width: "100%",
        ...TEXT.sm,
      }}
      type="button"
    >
      {lead}
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {children}
      </span>
      {trailing === undefined ? null : (
        <span style={{ ...TEXT.xs, color: COLOR.textFaint, fontVariantNumeric: "tabular-nums" }}>
          {trailing}
        </span>
      )}
    </button>
  );
}

/** A swatch of the workspace's own colour — a team's, a label's. The only colours not from the palette. */
const Swatch = ({ color, round }: { readonly color: string; readonly round?: boolean }) => (
  <span
    style={{
      background: color,
      borderRadius: round === true ? RADIUS.pill : 2,
      flex: "none",
      height: 8,
      width: 8,
    }}
  />
);

export function Sidebar({
  filters,
  onFilters,
}: {
  readonly filters: Filters;
  readonly onFilters: (next: Filters) => void;
}) {
  const api = useApi();
  const actor = useActor().account;
  const catalog = useCatalog();
  const totals = useLiveQuery(api.issues.labelTotals({ workspaceId: WORKSPACE_ID })).data;
  const countOf = (labelId: string) => totals.find((row) => row.labelId === labelId)?.total;

  /** Clicking the selected thing clears it, so "all teams" is the absence of a choice, not a row. */
  const toggle = <K extends "teamId" | "assigneeId" | "creatorId" | "labelId">(
    key: K,
    id: string,
  ) => onFilters({ ...filters, [key]: filters[key] === id ? null : id });

  return (
    <nav
      style={{
        borderRight: HAIRLINE,
        display: "flex",
        flex: "none",
        flexDirection: "column",
        gap: SPACE.xl,
        overflowY: "auto",
        padding: SPACE.md,
        width: SIDEBAR_WIDTH,
      }}
    >
      <Section title="Views">
        <FilterRow
          active={filters.openOnly}
          onClick={() => onFilters({ ...filters, openOnly: !filters.openOnly })}
        >
          Open only
        </FilterRow>
        <FilterRow
          active={filters.assigneeId === actor}
          lead={<Avatar size={14} who={catalog.member.get(actor)} />}
          onClick={() => toggle("assigneeId", actor)}
        >
          Assigned to me
        </FilterRow>
        {/* the other half of "mine": what I asked for, as distinct from what I was given. They
            compose — both lit is "I filed it and it came back to me" — which is why this is a
            second row rather than a mode the row above switches between */}
        <FilterRow
          active={filters.creatorId === actor}
          lead={<Avatar size={14} who={catalog.member.get(actor)} />}
          onClick={() => toggle("creatorId", actor)}
        >
          Reported by me
        </FilterRow>
      </Section>

      <Section title="Teams">
        {catalog.teams.map((team) => (
          <FilterRow
            active={filters.teamId === team.id}
            key={team.id}
            lead={<Swatch color={team.color} />}
            onClick={() => toggle("teamId", team.id)}
            trailing={team.key}
          >
            {team.name}
          </FilterRow>
        ))}
      </Section>

      <Section title="Labels">
        {catalog.labels.map((label) => (
          <FilterRow
            active={filters.labelId === label.id}
            key={label.id}
            lead={<Swatch color={label.color} round />}
            onClick={() => toggle("labelId", label.id)}
            trailing={countOf(label.id)}
          >
            {label.name}
          </FilterRow>
        ))}
      </Section>

      <Section title="Assigned to">
        {catalog.members.map((who) => (
          <FilterRow
            active={filters.assigneeId === who.id}
            key={who.id}
            lead={<Avatar size={14} who={who} />}
            onClick={() => toggle("assigneeId", who.id)}
          >
            {who.name}
          </FilterRow>
        ))}
      </Section>

      {/* a second list of the same twelve names, and it earns the pixels: an author filter that
          shared the People rows would have to hide behind a mode toggle, and a mode is a piece of
          state the URL does not carry and the person cannot see. Two sections say which is which
          at a glance and both go into the address bar. */}
      <Section title="Reported by">
        {catalog.members.map((who) => (
          <FilterRow
            active={filters.creatorId === who.id}
            key={who.id}
            lead={<Avatar size={14} who={who} />}
            onClick={() => toggle("creatorId", who.id)}
          >
            {who.name}
          </FilterRow>
        ))}
      </Section>
    </nav>
  );
}
