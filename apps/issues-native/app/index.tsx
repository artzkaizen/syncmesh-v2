import type { IssueStatus } from "@syncmesh/issues";

import { LegendList } from "@legendapp/list/react-native";
import { ISSUE_STATUS, WORKSPACE_ID } from "@syncmesh/issues";
import { useLiveQuery } from "@syncmesh/react";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { SearchField, Spinner } from "heroui-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { Filters } from "../src/filter-bar";
import type { PersonRow } from "../src/people";
import type { RowIssue } from "../src/row";

import { useActor, useApi, useDevice } from "../src/device";
import { FilterBar, OPEN_ONLY, isNarrowed } from "../src/filter-bar";
import { StatusGlyph } from "../src/glyphs";
import { sawAnswered, sawFirstRows, sawScale, sawSettled, summary } from "../src/measure";
import { sawTap, useNativeTransition } from "../src/nav-timing";
import { IssueRow, ROW_HEIGHT } from "../src/row";

/**
 * The list, read out of this phone's own database.
 *
 * `useLiveQuery` is the same hook the browser app uses over the same procedure, because the
 * procedure belongs to the app and neither platform owns it.
 */

/** The order a board reads in, which is not the order the enum is declared in. */
const BOARD_ORDER = ["started", "triage", "todo", "backlog", "done", "canceled"] as const;

const STATUS_LABEL = {
  triage: "Triage",
  backlog: "Backlog",
  todo: "Todo",
  started: "In Progress",
  done: "Done",
  canceled: "Canceled",
} as const satisfies Record<IssueStatus, string>;

/** What the list actually holds: an issue with the two ids the row resolves against. */
type ListIssue = RowIssue & { readonly teamId: string; readonly assigneeId: string | null };

/** A flattened section list: headers and rows in one array, because that is what a list scrolls. */
type Line =
  | {
      readonly kind: "header";
      readonly key: string;
      readonly status: string;
      readonly count: number;
    }
  | { readonly kind: "issue"; readonly key: string; readonly issue: ListIssue };

const HEADER_HEIGHT = 34;

export default function IssuesScreen() {
  /**
   * A fresh install goes to the picker before it goes anywhere.
   *
   * `chosen` is false only when nobody has ever answered on this device — not when the answer
   * happens to be the default — so this fires once per install and never again. Defaulting quietly
   * to Ada is what the app used to do, and it made the whole notion of "who am I" invisible.
   *
   * Its own component because the redirect is a return *before* the list's hooks, which the rules
   * of hooks forbid inside one function. It hands nothing down: the list asks for what it wants.
   */
  if (!useDevice().chosen) return <Redirect href="/identity" />;
  return <Issues />;
}

function Issues() {
  const device = useDevice();
  const router = useRouter();
  /**
   * The push animation, timed from the screen it covers.
   *
   * This list is the only screen that is still mounted for the whole of a push away from it, so it
   * is the only one that can say when UIKit started the transition and when it finished. It watches
   * and reports; it never drives one.
   */
  useNativeTransition();
  const open = useCallback(
    (id: string) => {
      sawTap("issue");
      router.push(`/issues/${id}`);
    },
    [router],
  );

  /**
   * The roster hands work off to this screen as `?assignee=…`, so "show me Bo's issues" is one tap
   * from the people list rather than a filter a person has to rebuild here.
   */
  const { assignee } = useLocalSearchParams<{ assignee?: string }>();
  const [filters, setFilters] = useState<Filters>(OPEN_ONLY);
  useEffect(() => {
    if (assignee !== undefined) setFilters((held) => ({ ...held, assigneeId: assignee }));
  }, [assignee]);

  const teams = useLiveQuery(device.api.teams.list({ workspaceId: WORKSPACE_ID }));
  const people = useLiveQuery(device.api.members.list({ workspaceId: WORKSPACE_ID }));

  /**
   * Searching and filtering are two procedures, and which one runs is decided here.
   *
   * `issues.search` does a `LIKE` over title and description and takes no filters; `issues.list`
   * takes every filter and no text. Rather than widen one to cover the other, the screen asks the
   * question that matches what the person typed — and the filter chips stay visible either way so
   * it is obvious which of the two is in force.
   *
   * `enabled` rather than a sentinel needle: the one that is not asked is released rather than
   * merely ignored, where passing `search` a needle that matches nothing would be a full `LIKE`
   * scan of every issue on the device to deliberately return zero rows.
   */
  const searching = (filters.text ?? "").trim();
  const found = useLiveQuery(
    device.api.issues.search({ workspaceId: WORKSPACE_ID, text: searching, limit: 100 }),
    { enabled: searching !== "" },
  );
  const listed = useLiveQuery(
    device.api.issues.list({
      workspaceId: WORKSPACE_ID,
      assigneeId: filters.assigneeId,
      creatorId: filters.creatorId,
      openOnly: filters.openOnly,
      status: filters.status === undefined ? undefined : [...filters.status],
      teamId: filters.teamId,
    }),
    { enabled: searching === "" },
  );
  const issues = searching === "" ? listed : found;

  const keyOf = useMemo(() => new Map(teams.data.map((team) => [team.id, team.key])), [teams.data]);
  const personOf = useMemo(
    () => new Map(people.data.map((person) => [person.id, person satisfies PersonRow])),
    [people.data],
  );

  /**
   * Rows this device cannot address are left out, and that is a symptom rather than a tidy-up.
   *
   * The phone's own database holds at least one row with **no `id` and no `title`** but a real
   * `status`, `priority` and `views` — a row folded from cells whose identity-bearing write never
   * arrived, which SQLite permits because a `TEXT PRIMARY KEY` may be NULL. It is not renderable
   * (nothing to key on, nothing to open) and not dismissable (it is what this device actually
   * holds), so the list declines to draw it and the fact is written down here instead of being
   * quietly lost. Where it comes from is an engine question — an update folded ahead of its
   * insert is exactly the `missing-dependency` case recovery exists for — and it wants answering
   * there, not with a filter.
   */
  const addressable = useMemo(
    () => issues.data.filter((row): row is typeof row & { id: string } => row.id !== null),
    [issues.data],
  );

  /**
   * Grouped by status, because a flat list of forty issues answers no question a person has.
   *
   * "What is in flight" and "what is parked" are the two things anybody opens a tracker to see,
   * and a header every few rows is what makes them readable without sorting anything. The headers
   * and the rows are flattened into one array rather than nested, because a virtualized list
   * scrolls one array — and `getFixedItemSize` still answers exactly for both kinds, so nothing
   * has to be measured.
   */
  const lines = useMemo(() => {
    const byStatus = new Map<string, ListIssue[]>();
    for (const row of addressable) {
      const held = byStatus.get(row.status);
      if (held === undefined) byStatus.set(row.status, [row]);
      else held.push(row);
    }
    const out: Line[] = [];
    const push = (status: string, rows: readonly ListIssue[]) => {
      out.push({ kind: "header", key: `h:${status}`, status, count: rows.length });
      for (const row of rows) out.push({ kind: "issue", key: row.id, issue: row });
    };
    // a status nobody is using draws no header at all, rather than an empty section
    for (const status of BOARD_ORDER) {
      const rows = byStatus.get(status);
      if (rows !== undefined && rows.length > 0) push(status, rows);
    }
    // a status this build has never heard of still gets drawn, under its own name — the database
    // is the authority on what is in it, and a UI that silently dropped rows would be lying
    for (const [status, rows] of byStatus) {
      if (!(ISSUE_STATUS as readonly string[]).includes(status)) push(status, rows);
    }
    return out;
  }, [addressable]);

  /**
   * The cold-join timeline, recorded as it happens rather than reconstructed after.
   *
   * `hasAnswered` and `isSettled` are the two instants worth knowing apart (see below), and the
   * scale is read once the second one lands so a duration can be quoted against the work it
   * covered rather than on its own. The numbers live in Settings now; this only records them.
   */
  useEffect(() => {
    if (listed.hasAnswered) sawAnswered();
    // rows, not an answer: the two diverge by the whole of a cold join
    if (addressable.length > 0) sawFirstRows();
    if (!listed.isSettled) return;
    sawSettled();
    void device.scale().then((scale) => {
      sawScale(scale);
      // eslint-disable-next-line no-console -- the number is the point, and a log outlives a screen
      console.log("[join]", summary());
    });
  }, [addressable.length, listed.hasAnswered, listed.isSettled, device]);

  const renderItem = useCallback(
    ({ item }: { readonly item: Line }) =>
      item.kind === "header" ? (
        <View className="flex-row items-center gap-2" style={{ height: HEADER_HEIGHT }}>
          <StatusGlyph size={14} status={item.status} />
          <Text className="text-[13px] font-medium text-foreground">
            {STATUS_LABEL[item.status as IssueStatus] ?? item.status}
          </Text>
          <Text className="text-[13px] text-muted-foreground">{String(item.count)}</Text>
        </View>
      ) : (
        <IssueRow
          assignee={
            item.issue.assigneeId === null ? undefined : personOf.get(item.issue.assigneeId)
          }
          issue={item.issue}
          onPress={open}
          teamKey={keyOf.get(item.issue.teamId) ?? "???"}
        />
      ),
    [keyOf, open, personOf],
  );

  /**
   * **Two different questions, and neither answers the other.**
   *
   * `hasAnswered` is about this device's storage: a local read completed. `isSettled` is about the
   * *sources* behind it: every peer that could still fill this scope has replied. A query over an
   * empty store answers instantly while the relay has said nothing, so an app that drew "Nothing
   * open" on `hasAnswered` alone would be stating something false about a workspace it has simply
   * not heard about yet.
   */
  if (!issues.hasAnswered) return <Notice>Reading the local replica…</Notice>;
  if (issues.error !== undefined)
    return (
      <Notice spinner={false}>This device could not read the list: {issues.error.message}</Notice>
    );

  return (
    <View className="flex-1">
      <LegendList
        /**
         * The large title needs the list to make room for it, and only iOS can say how much.
         *
         * A large-title header is drawn *over* the scroll view and collapses as it scrolls, so its
         * height is not a constant this file could pad by — it is a running inset the platform
         * owns. `automatic` is how a scroll view asks for it; without it the list lays out from the
         * top of the screen and the first rows sit under the title.
         */
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 96, paddingHorizontal: 16 }}
        data={lines}
        // the faces and team keys are not in `data`; a recycled row needs telling they moved
        extraData={`${String(personOf.size)}:${String(keyOf.size)}`}
        /**
         * The size is known for both kinds of line, so it is told rather than discovered.
         *
         * `estimatedItemSize` is a *hint* the list replaces with measured averages once items have
         * rendered; this is a promise it can build the entire scroll range from without rendering
         * anything. It holds only because both {@link ROW_HEIGHT} and the header height are
         * enforced in the components themselves.
         */
        getFixedItemSize={(line) => (line.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT)}
        keyExtractor={(line) => line.key}
        ListEmptyComponent={
          <Empty
            narrowed={isNarrowed(filters)}
            onClear={() => setFilters(OPEN_ONLY)}
            settled={issues.isSettled}
          />
        }
        ListHeaderComponent={
          <View className="gap-3 py-1">
            {/**
             * `Group` is not optional, and leaving it out is why the icon sat in the wrong place.
             *
             * `SearchField` root is a *column* with gap spacing; `Group` is the flex-row container
             * the parts actually live in, and `SearchIcon` positions itself **absolutely** on the
             * leading edge of it. Composed as siblings of the root, as they were, the icon had no
             * row to anchor to and the input reserved leading space for an icon that was being
             * laid out above it.
             */}
            <SearchField
              onChange={(text) => setFilters((held) => ({ ...held, text }))}
              value={filters.text ?? ""}
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Search issues or ENG-42" />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            <FilterBar
              filters={filters}
              me={device.actor.account}
              onChange={setFilters}
              people={people.data}
              teams={teams.data}
            />
          </View>
        }
        // a fold can land while a finger is on the screen: keep the row under it where it was
        maintainVisibleContentPosition={{ data: true }}
        // rows hold no state of their own, so recycling is free — and it is opt-in here, which is
        // the difference from FlashList worth knowing
        recycleItems
        renderItem={renderItem}
        style={{ flex: 1 }}
      />
      {/* filing an issue is the one thing a tracker must never make anybody hunt for, so it is the
          one control that floats over the list rather than living behind a menu */}
      <Pressable
        accessibilityLabel="New issue"
        accessibilityRole="button"
        className="absolute bottom-8 right-5 h-14 w-14 items-center justify-center rounded-full bg-accent active:opacity-80"
        onPress={() => router.push("/issues/new")}
        style={{
          elevation: 6,
          shadowColor: "#000",
          shadowOffset: { height: 4, width: 0 },
          shadowOpacity: 0.25,
          shadowRadius: 12,
        }}
      >
        <Text className="text-[30px] font-light leading-[34px] text-accent-foreground">+</Text>
      </Pressable>
    </View>
  );
}

/**
 * Nothing to show, and the three reasons that can be true — which are not the same sentence.
 *
 * "Still catching up" is a workspace this device has not heard yet; "no matches" is a filter that
 * excluded everything and is one tap from being undone; "nothing open" is the real answer. An app
 * that drew one message for all three would be lying in two of the cases.
 */
const Empty = ({
  narrowed,
  onClear,
  settled,
}: {
  readonly narrowed: boolean;
  readonly onClear: () => void;
  readonly settled: boolean;
}) => (
  <View className="items-center gap-3 py-24">
    {settled ? null : <Spinner size="sm" />}
    <Text className="text-center text-[15px] text-muted-foreground">
      {!settled
        ? "Catching up with the workspace…"
        : narrowed
          ? "No issues match these filters."
          : "Nothing open."}
    </Text>
    {settled && narrowed ? (
      <Pressable onPress={onClear}>
        <Text className="text-[15px] font-medium text-accent">Clear filters</Text>
      </Pressable>
    ) : null}
  </View>
);

const Notice = ({
  children,
  spinner = true,
}: {
  readonly children: React.ReactNode;
  readonly spinner?: boolean;
}) => (
  <View className="flex-1 items-center justify-center gap-3 p-8">
    {spinner ? <Spinner size="sm" /> : null}
    <Text className="text-center text-[15px] text-muted-foreground">{children}</Text>
  </View>
);
