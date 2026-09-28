import type { IssueStatus } from "@syncmesh/issues";

import { ISSUE_STATUS } from "@syncmesh/issues";
import { memo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

/**
 * What the list is currently narrowed to.
 *
 * **One object rather than four `useState`s**, because every one of these is part of the same
 * question and they are read together, cleared together, and — on the web — serialised into a URL
 * together. `undefined` is "not narrowed by this", which is distinct from a filter set to an empty
 * value: `status: []` would be a list showing nothing, and no button here can produce it.
 */
export interface Filters {
  readonly teamId?: string | undefined;
  readonly assigneeId?: string | undefined;
  /** Who filed it — "everything I raised", which is not "everything on my plate". */
  readonly creatorId?: string | undefined;
  readonly status?: readonly IssueStatus[] | undefined;
  readonly openOnly?: boolean | undefined;
  readonly text?: string | undefined;
}

/** The filters a fresh list opens on: work in flight, everybody's, every team. */
export const OPEN_ONLY: Filters = { openOnly: true };

/** Whether anything is narrowed, for the "Clear" affordance to know if it has a job. */
export const isNarrowed = (filters: Filters): boolean =>
  filters.teamId !== undefined ||
  filters.assigneeId !== undefined ||
  filters.creatorId !== undefined ||
  filters.status !== undefined ||
  (filters.text ?? "") !== "" ||
  filters.openOnly !== true;

/** A person or a team, as the bar needs them: something with an id and something to print. */
interface Named {
  readonly id: string;
  readonly name: string;
}

/**
 * The row of chips above the list.
 *
 * **One scroller, not two.** The first pass stacked a status row above a team row, which is two
 * bands of identically-shaped chips reading as two unrelated controls and eating 80pt of a phone
 * before a single issue appeared. They are one question — "narrow this list" — so they are one row.
 *
 * A horizontal scroller rather than a sheet: the whole value of a filter on a phone is seeing what
 * is applied without opening anything, and a filter hidden behind a button is one people forget is
 * on. Tapping a set chip clears it, which is the same gesture as setting it.
 */
export const FilterBar = memo(function FilterBar({
  filters,
  me,
  onChange,
  people,
  teams,
}: {
  readonly filters: Filters;
  /** This install's account, so "mine" is a chip rather than a trip through a picker. */
  readonly me: string;
  readonly onChange: (next: Filters) => void;
  readonly people: readonly Named[];
  readonly teams: readonly Named[];
}) {
  /** Set it, or clear it if it was already that — one gesture for both directions. */
  const toggle = <K extends "teamId" | "assigneeId" | "creatorId">(key: K, id: string) =>
    onChange({ ...filters, [key]: filters[key] === id ? undefined : id });

  const toggleStatus = (status: IssueStatus) => {
    const held = filters.status ?? [];
    const next = held.includes(status) ? held.filter((one) => one !== status) : [...held, status];
    // an empty list would draw an empty screen nobody asked for, so "none selected" is "no filter"
    onChange({ ...filters, status: next.length === 0 ? undefined : next, openOnly: undefined });
  };

  const nameOf = (id: string | undefined) =>
    id === undefined ? undefined : people.find((person) => person.id === id)?.name;
  const teamName = teams.find((team) => team.id === filters.teamId)?.name;

  return (
    <View>
      <ScrollView
        contentContainerStyle={{ gap: 8, paddingHorizontal: 2 }}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        <Toggle
          active={filters.openOnly === true}
          onPress={() =>
            onChange({
              ...filters,
              openOnly: filters.openOnly === true ? undefined : true,
              status: undefined,
            })
          }
        >
          Open
        </Toggle>

        {/* the applied narrowing is drawn as a chip that clears itself, so what is on is legible
            without opening anything — see the note on this component */}
        {teamName === undefined ? null : (
          <Toggle active onPress={() => onChange({ ...filters, teamId: undefined })}>
            {teamName} ✕
          </Toggle>
        )}
        {/* the two person filters are different questions and are labelled as such: an unlabelled
            name chip cannot say whether it means "assigned to" or "raised by" */}
        {nameOf(filters.assigneeId) === undefined ? null : (
          <Toggle active onPress={() => onChange({ ...filters, assigneeId: undefined })}>
            {`Assignee: ${nameOf(filters.assigneeId) ?? ""} ✕`}
          </Toggle>
        )}
        {nameOf(filters.creatorId) === undefined ? null : (
          <Toggle active onPress={() => onChange({ ...filters, creatorId: undefined })}>
            {`Author: ${nameOf(filters.creatorId) ?? ""} ✕`}
          </Toggle>
        )}
        <Toggle active={filters.assigneeId === me} onPress={() => toggle("assigneeId", me)}>
          Assigned to me
        </Toggle>
        <Toggle active={filters.creatorId === me} onPress={() => toggle("creatorId", me)}>
          Raised by me
        </Toggle>

        {ISSUE_STATUS.map((status) => (
          <Toggle
            active={(filters.status ?? []).includes(status)}
            key={status}
            onPress={() => toggleStatus(status)}
          >
            {status}
          </Toggle>
        ))}

        {teams.map((team) => (
          <Toggle
            active={filters.teamId === team.id}
            key={team.id}
            onPress={() => toggle("teamId", team.id)}
          >
            {team.name}
          </Toggle>
        ))}

        {isNarrowed(filters) ? (
          <Pressable className="h-8 justify-center px-2" onPress={() => onChange(OPEN_ONLY)}>
            <Text className="text-[13px] font-medium text-danger">Clear</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
});

/**
 * A filter chip, at a size a thumb can actually hit.
 *
 * **A bare `Pressable` rather than HeroUI's `Chip`.** `Chip` is itself a `Pressable`, and this app
 * has already been bitten once by nesting one inside another — the inner one takes the touch
 * responder and the tap appears to do nothing. More to the point, `Chip` is sized for a *label*:
 * its `sm` is 24pt tall, and a filter bar scrolled horizontally by the same thumb that presses it
 * needs 32 to be hittable. Fixing the height here is cheaper than fighting a component built for
 * the other job.
 */
const Toggle = ({
  active,
  children,
  onPress,
}: {
  readonly active: boolean;
  readonly children: React.ReactNode;
  readonly onPress: () => void;
}) => (
  <Pressable
    accessibilityRole="button"
    accessibilityState={{ selected: active }}
    className={
      active
        ? "h-8 justify-center rounded-lg bg-accent px-3"
        : "h-8 justify-center rounded-lg border border-border px-3 active:opacity-60"
    }
    onPress={onPress}
  >
    <Text
      className={
        active ? "text-[13px] font-medium text-accent-foreground" : "text-[13px] text-foreground"
      }
    >
      {children}
    </Text>
  </Pressable>
);
