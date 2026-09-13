import {
  Outlet,
  createFileRoute,
  retainSearchParams,
  stripSearchParams,
  useParams,
} from "@tanstack/react-router";

import type { Filters, IssueRow, Sort } from "../../app/view.js";

import { Chrome } from "../../app/chrome.js";
import { ShownRows, useReplica } from "../../app/context.js";
import { Devtools } from "../../app/devtools.js";
import { inspectorControls } from "../../app/inspector.js";
import { List } from "../../app/list.js";
// `View` is the schema and the type it infers, the way `domain.ts` names its enums
import { IMPLIED, View, filtersOf, viewOf } from "../../app/search.js";
import { Sidebar } from "../../app/sidebar.js";
import { COLOR, FONT, TEXT } from "../../app/ui.js";
import { useIssues } from "../../app/use-issues.js";

/**
 * Everything that is on screen whichever issue is open: the header, the filters, the list, and
 * the inspector docked over the lot.
 *
 * A **pathless layout route** — the leading underscore — because none of this is a URL segment.
 * `/` and `/issues/ENG-4`'s id are two things to draw in one place, and the alternative, a header
 * and a sidebar declared once per route, would mean the list unmounting and re-subscribing every
 * time somebody clicked a row. Here the outlet is the detail panel's slot and nothing else moves.
 *
 * The route also owns **all** of this app's view state, as `?team=…&sort=…`, and that is the
 * whole point of the exercise. It used to be four `useState` calls one component up; a reload
 * threw them away, a link carried none of them, and the browser's back button undid a navigation
 * nobody had made. The parsing is in `app/search.ts`, where a test can reach it.
 */
export const Route = createFileRoute("/_shell")({
  validateSearch: View,

  /**
   * Navigation keeps the view, and drops what the view already implies.
   *
   * Without {@link retainSearchParams} opening an issue would clear every filter: search params
   * are the destination route's, not the browser's, so a `navigate` that does not name them
   * re-derives them from the schema's defaults. Retaining all of them is right here because there
   * is one view and both child routes are under it — a card opened from a filtered list is the
   * same filtered list with a panel beside it.
   *
   * {@link stripSearchParams} is the other half: without it the first click would write
   * `?open=true&q=&sort=manual`, three facts the empty URL already stated, and every link anyone
   * copied afterwards would carry them.
   */
  search: { middlewares: [retainSearchParams(true), stripSearchParams(IMPLIED)] },

  component: Shell,
});

/** A stable empty array, so a pending read does not re-render the panel on every pass. */
const EMPTY: readonly IssueRow[] = [];

function Shell() {
  const { mesh } = useReplica();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  /**
   * Which issue the child route is showing, asked of the router rather than held beside it.
   *
   * `strict: false` because this layout is drawn under both of its children and only one of them
   * has params; the row highlight is `undefined` on `/`, which is exactly the state it wants.
   * Reading it here rather than lifting a `selectedId` into state is what stops the list and the
   * address bar from ever disagreeing.
   */
  const { id } = useParams({ strict: false });

  const filters = filtersOf(search);
  /**
   * One read, two views of it. The list groups and sorts it; the panel in the outlet is judged
   * against it, so "that issue is not on this device" cannot be said about a row this screen is
   * drawing one pane to the left — `app/view.ts`'s `panelFor` has the measurement.
   */
  const answer = useIssues(filters);
  /** A filter change is a navigation. The sort travels with it, because it is not in the patch. */
  const show = (next: Filters) =>
    void navigate({ search: (previous: View) => ({ ...previous, ...viewOf(next) }) });
  const sortBy = (sort: Sort) =>
    void navigate({ search: (previous: View) => ({ ...previous, sort }) });
  const openIssue = (id: string) => void navigate({ to: "/issues/$id", params: { id } });

  /** One object for the header badge and the panel, by `mesh`; see `inspectorControls`. */
  const controls = inspectorControls(mesh);

  return (
    <>
      <div
        style={{
          background: COLOR.surface,
          color: COLOR.text,
          display: "flex",
          flexDirection: "column",
          fontFamily: FONT.sans,
          height: "100vh",
          ...TEXT.md,
        }}
      >
        <Chrome
          controls={controls}
          onText={(text) => show({ ...filters, text })}
          text={filters.text}
        />
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <Sidebar filters={filters} onFilters={show} />
          <List
            answer={answer}
            filters={filters}
            onSelect={openIssue}
            onSort={sortBy}
            selectedId={id}
            sort={search.sort}
          />
          <ShownRows value={answer.data ?? EMPTY}>
            <Outlet />
          </ShownRows>
        </div>
      </div>
      <Devtools controls={controls} mesh={mesh} />
    </>
  );
}
