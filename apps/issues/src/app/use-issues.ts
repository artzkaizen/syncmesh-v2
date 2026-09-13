import type { QueryResult } from "@syncmesh/react";

import { useQuery } from "@syncmesh/react";

import type { Replica } from "./replica.js";
import type { Filters, IssueRow } from "./view.js";

import { WORKSPACE_ID } from "../domain.js";
import { useReplica } from "./context.js";

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
export const issuesCall = (api: Replica["api"], filters: Filters) => {
  const text = filters.text.trim();
  return text === ""
    ? api.issues.list({
        workspaceId: WORKSPACE_ID,
        teamId: filters.teamId ?? undefined,
        assigneeId: filters.assigneeId ?? undefined,
        openOnly: filters.openOnly,
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
export function useIssues(filters: Filters): QueryResult<IssueRow> {
  const { api } = useReplica();
  return useQuery(issuesCall(api, filters));
}
