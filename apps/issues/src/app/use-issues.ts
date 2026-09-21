import type { QueryResult } from "@syncmesh/react";

import { useQuery } from "@syncmesh/react";

import type { Replica } from "./replica.js";
import type { Filters, IssueRow, StatusCount } from "./view.js";

import { WORKSPACE_ID } from "../domain.js";
import { useApi } from "./context.js";

/**
 * How many rows each question is worth asking for. A filtered list is the screen's whole content
 * and is scrolled; a search is a lookup somebody is about to click one result of.
 */
const LISTED = 500;
const SEARCHED = 100;

/**
 * **The one descriptor this screen reads, chosen rather than filtered.**
 *
 * Search and filter are two procedures — `issues.search` and `issues.list` — and the header's box
 * being empty or not decides which of them the screen is asking. Both are always constructible
 * (an empty box means no search, not a missing argument) and both `SELECT` the same row out of
 * the same table, so the honest shape is one call picked here and handed to one hook.
 *
 * **Do not "simplify" this into two hooks with `enabled` on each.** That is what it used to be,
 * with `undefined` in place of the flag, and it read as if it cost nothing: `text === ""` was
 * evaluated three times, two `useQuery` calls ran so that one answer could be thrown away, and
 * the disabled one still had to be kept in step with the live one. `enabled` would have tidied
 * the ternaries and left every bit of that in place — the flag is for a query that should not run
 * *yet*, not for choosing between two that both could. One call means one subscription, one
 * result, and the condition stated once, where a reader can see that the two branches really are
 * the same question narrowed two ways.
 *
 * Exported apart from the hook so `__tests__/use-issues.test.ts` can put the same question to a
 * real device without a DOM — including the one that matters, that clearing the search box gets
 * back the exact list, and the exact subscription key, that was there before anyone typed.
 */
export const issuesCall = (api: Replica["api"], filters: Filters, perStatus: number) => {
  const text = filters.text.trim();
  return text === ""
    ? api.issues.list({
        workspaceId: WORKSPACE_ID,
        teamId: filters.teamId ?? undefined,
        assigneeId: filters.assigneeId ?? undefined,
        creatorId: filters.creatorId ?? undefined,
        openOnly: filters.openOnly,
        // the board pages per column: a flat limit fills whichever statuses rank first and
        // starves the rest, however far somebody scrolls (`procedures/reads.ts` has the why)
        perStatus,
        limit: LISTED,
      })
    : api.issues.search({ workspaceId: WORKSPACE_ID, text, limit: SEARCHED });
};

/**
 * The screen's one read of the issues, held above {@link List} so the detail panel is judged
 * against the same rows rather than against a second opinion of them.
 *
 * That single result is the point of the file: `route.tsx` hands it to the list *and* to the
 * `ShownRows` provider the panel reads, so the two cannot disagree about which rows exist. A
 * panel whose own read comes back empty about a row the list is drawing has not learned that the
 * row is absent — `view.ts`'s `panelFor` has the measurement — and it can only make that
 * comparison because both views are looking at one array from one subscription.
 *
 * Beside `list.tsx` rather than inside it for the reason `context.ts` gives at length: a hook
 * exported from a `.tsx` file costs Fast Refresh for every module that imports it.
 */
export function useIssues(filters: Filters, perStatus: number): QueryResult<IssueRow> {
  const api = useApi();
  return useQuery(issuesCall(api, filters, perStatus));
}

/** The first window every board opens on, and the step each "Show more" adds to it. */
export const PER_STATUS = 50;

/**
 * The badges, as their own read — **never the length of {@link useIssues}'s rows**.
 *
 * A page and a count are two questions, and the whole reason this hook exists beside that one is
 * that they have different completeness: the page is capped at {@link LISTED} and the count is a
 * `GROUP BY` with no `LIMIT`. Counting the page instead is the bug that makes a tracker show 50,
 * then 1,240 after a scroll — and the same bug, in its quieter form, is a status that sits at 0
 * while rows are being written into it because none of them were on the first page.
 *
 * **Disabled for the two views SQL cannot count.** A text search is `issues.search`, a different
 * procedure with a `LIKE` this `GROUP BY` does not carry; a label filter is tested against the
 * catalog on this device rather than joined (`list.tsx` says why). In both cases the hook returns
 * no rows, `countsFor` falls back to counting what is on screen, and the badge renders `+`
 * whenever that was a page. Saying "at least" is the honest answer there; a confident wrong
 * number is not.
 */
export function useIssueCounts(filters: Filters): QueryResult<StatusCount> {
  const api = useApi();
  const countable = filters.text.trim() === "" && filters.labelId === null;
  return useQuery(
    api.issues.counts({
      workspaceId: WORKSPACE_ID,
      teamId: filters.teamId ?? undefined,
      assigneeId: filters.assigneeId ?? undefined,
      creatorId: filters.creatorId ?? undefined,
      openOnly: filters.openOnly,
    }),
    { enabled: countable },
  );
}
