import * as z from "zod";

import type { Filters } from "./view.js";

import { NO_FILTERS, SORTS } from "./view.js";

/**
 * What the screen is showing, as the URL holds it — with no React and no router in the file.
 *
 * Every narrowing a person can perform on the list is here rather than in component state, and
 * the difference is a reload: filters kept in `useState` are gone the moment a tab is refreshed,
 * a crash is recovered from, or a link is sent to somebody else. Keeping them in the query string
 * makes the browser's own history the store — back undoes a filter, forward redoes it, and the
 * address bar is a fair description of the screen.
 *
 * Parsing lives apart from the routes for the same reason `view.ts` lives apart from the
 * components: `__tests__/search.test.ts` can interrogate it without a DOM, a router or a replica,
 * and the one thing most likely to be quietly wrong — what a hand-edited or stale URL turns into
 * — is the thing a test can actually reach.
 */

/**
 * Text as it survives the router, which has already tried to read every value as JSON.
 *
 * This is the trap in the whole file. TanStack Router parses each search value with `JSON.parse`
 * before a validator sees it, so a search for `42` arrives here as the **number** 42 and a label
 * whose id happens to be digits arrives as a number too. A plain `z.string()` would reject both,
 * and with `.catch` behind it that rejection is silent: the filter simply vanishes on reload, for
 * the values that look like numbers and no others. Accepting the three scalars JSON can produce
 * and converting once puts the value back the way it was typed.
 */
const Scalar = z.union([z.string(), z.number(), z.boolean()]).transform(String);

/** An id, or nothing. An empty `?team=` is nothing rather than a team whose id is the empty string. */
const Chosen = z
  .union([z.string().min(1), z.number(), z.boolean()])
  .transform(String)
  .optional()
  .catch(undefined);

/**
 * The values a URL means when it says nothing, taken from {@link NO_FILTERS} so that "no opinion"
 * is declared once for the whole app rather than twice with a chance of disagreeing.
 *
 * They are also what the layout route's `stripSearchParams` middleware removes on the way out,
 * which is why `/` stays `/` rather than growing `?open=true&q=&sort=manual` at the first click.
 */
export const IMPLIED = {
  open: NO_FILTERS.openOnly,
  q: NO_FILTERS.text,
  // `manual` is the workspace's own order and the only sort a drag can write; see `view.ts`
  sort: SORTS[0],
};

/**
 * The search schema the routes validate with — and **nothing in it can fail**.
 *
 * The names are the query string's, and they are deliberately not the names of the fields they
 * set: `team`, `label` and `assignee` are what a person would guess from looking at the sidebar,
 * where `teamId` in an address bar reads like an implementation detail leaking, and `q` is what
 * every search box on the web is called. `author` is the widest of these gaps — the column is
 * `creatorId` and the procedure's filter is too — and it is still the right name, because nobody
 * shares a link that says `creator`. {@link filtersOf} is the only place the two vocabularies meet.
 *
 * Every field ends in `.catch`, which is a decision rather than laziness. A URL is typed by
 * people, truncated by chat clients and kept in bookmarks across deploys, so a value that no
 * longer parses is the normal case and not an exceptional one. A validator that threw would meet
 * it with an error screen over a working replica; falling back to the default shows the
 * unfiltered list, which is both honest and what the person wanted.
 */
export const View = z.object({
  team: Chosen,
  label: Chosen,
  assignee: Chosen,
  /** Who filed it. `author` rather than `creator`, because that is the word a URL is read in. */
  author: Chosen,
  /** Work in flight only — the `Open only` view in the sidebar. */
  open: z.boolean().default(IMPLIED.open).catch(IMPLIED.open),
  /** The header's search box. Empty means the filtered list rather than a search. */
  q: Scalar.default(IMPLIED.q).catch(IMPLIED.q),
  sort: z.enum(SORTS).default(IMPLIED.sort).catch(IMPLIED.sort),
});

export type View = z.infer<typeof View>;

/** The URL's vocabulary, read as the one the list and the sidebar have always spoken. */
export const filtersOf = (view: View): Filters => ({
  teamId: view.team ?? null,
  assigneeId: view.assignee ?? null,
  creatorId: view.author ?? null,
  labelId: view.label ?? null,
  openOnly: view.open,
  text: view.q,
});

/**
 * The same crossing the other way, as the patch a navigation spreads over the current search.
 *
 * Cleared filters come back as `undefined` rather than being absent, because absent would leave
 * the old value in place: the router merges this into what the URL already held, so the field
 * that was just unset has to be named to be forgotten. `sort` is not here at all — it is not a
 * filter, and a component that changes one must not silently reset the other.
 */
export const viewOf = (filters: Filters): Omit<View, "sort"> => ({
  team: filters.teamId ?? undefined,
  assignee: filters.assigneeId ?? undefined,
  author: filters.creatorId ?? undefined,
  label: filters.labelId ?? undefined,
  open: filters.openOnly,
  q: filters.text,
});
