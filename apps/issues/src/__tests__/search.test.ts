import { describe, expect, test } from "bun:test";

import type { Filters } from "../app/view.js";

import { IMPLIED, View, filtersOf, viewOf } from "../app/search.js";
import { NO_FILTERS, SORTS } from "../app/view.js";

/**
 * What a URL turns into, and what the screen turns back into a URL.
 *
 * Worth a test rather than a click-through because every failure here is silent. A filter that
 * fails to parse does not raise anything a person would see — it comes back as "no opinion", and
 * the list quietly widens; a field that is dropped on the way out is a filter that survives one
 * navigation and not the next. The router is not in this file, which is the point: these are the
 * two pure functions either side of it, and they can be interrogated without a DOM, a replica or
 * an address bar.
 *
 * `View.parse` is given plain objects because that is genuinely what the router hands a
 * validator: it has already split the query string and run each value through `JSON.parse`, so
 * `?open=false` arrives as a boolean and `?q=42` as a number.
 */

describe("the view a URL carries", () => {
  test("an empty URL is the unfiltered list, manually ordered", () => {
    const view = View.parse({});
    expect(view).toEqual({
      team: undefined,
      label: undefined,
      assignee: undefined,
      author: undefined,
      open: true,
      q: "",
      sort: "manual",
    });
    expect(filtersOf(view)).toEqual(NO_FILTERS);
  });

  test("reads every filter, the sort and the search text", () => {
    const view = View.parse({
      team: "team-eng",
      label: "label-bug",
      assignee: "acct_ada",
      author: "acct_bo",
      open: false,
      q: "latency",
      sort: "priority",
    });
    expect(view.sort).toBe("priority");
    expect(filtersOf(view)).toEqual({
      teamId: "team-eng",
      assigneeId: "acct_ada",
      creatorId: "acct_bo",
      labelId: "label-bug",
      openOnly: false,
      text: "latency",
    });
  });

  /**
   * The one a hand-edited URL actually hits. Every field falls back rather than throwing, because
   * a validator that threw would meet a stale bookmark with an error screen over a working
   * replica.
   */
  test("a value that makes no sense falls back instead of failing", () => {
    const view = View.parse({ sort: "by-vibes", open: "maybe", q: { nested: true }, team: "" });
    expect(view.sort).toBe("manual");
    expect(view.open).toBe(true);
    expect(view.q).toBe("");
    // an empty `?team=` is no team, not a team whose id is the empty string
    expect(view.team).toBeUndefined();
    expect(filtersOf(view)).toEqual(NO_FILTERS);
  });

  /**
   * The router parses each value as JSON before a validator sees it, so a search for a number is
   * a number by the time it arrives. Rejecting it would lose exactly the searches that look like
   * numbers, on reload, and nowhere else.
   */
  test("text and ids that look like numbers survive the router's JSON parse", () => {
    const view = View.parse({ q: 42, label: 7, open: false });
    expect(view.q).toBe("42");
    expect(view.label).toBe("7");
  });

  /**
   * The two questions about a person are different questions and the URL has to keep them apart:
   * `?assignee=` is what is on somebody's plate, `?author=` is what they asked for. They compose —
   * both naming one account is "I filed it and it came back to me" — so a schema that folded
   * either into the other would quietly answer a query nobody made.
   */
  test("who filed it and who is doing it are two filters, not one", () => {
    const both = filtersOf(View.parse({ assignee: "acct_ada", author: "acct_ada" }));
    expect(both.assigneeId).toBe("acct_ada");
    expect(both.creatorId).toBe("acct_ada");
    const filed = filtersOf(View.parse({ author: "acct_bo" }));
    expect(filed.creatorId).toBe("acct_bo");
    expect(filed.assigneeId).toBeNull();
  });

  test("every sort the list offers round trips", () => {
    for (const sort of SORTS) expect(View.parse({ sort }).sort).toBe(sort);
  });

  test("what the URL leaves out is what it already means", () => {
    const view = View.parse({});
    expect(view.open).toBe(IMPLIED.open);
    expect(view.q).toBe(IMPLIED.q);
    expect(view.sort).toBe(IMPLIED.sort);
  });
});

describe("the round trip through the address bar", () => {
  const filtered = {
    teamId: "team-eng",
    assigneeId: "acct_bo",
    creatorId: "acct_ada",
    labelId: "label-perf",
    openOnly: false,
    text: "timeout",
  } satisfies Filters;

  test("a filtered screen survives being written to a URL and read back", () => {
    expect(filtersOf(View.parse({ ...viewOf(filtered), sort: "updated" }))).toEqual(filtered);
  });

  test("the unfiltered screen does too, which is the case that would hide a dropped field", () => {
    expect(filtersOf(View.parse(viewOf(NO_FILTERS)))).toEqual(NO_FILTERS);
  });

  /**
   * Clearing a filter has to be written down. The patch is spread over the search the URL already
   * held, so a cleared field that was merely absent would leave the old value standing.
   */
  test("a cleared filter names itself, so the navigation forgets it", () => {
    const patch = viewOf({ ...filtered, teamId: null });
    expect(Object.hasOwn(patch, "team")).toBe(true);
    expect(patch.team).toBeUndefined();
    expect(filtersOf(View.parse({ ...viewOf(filtered), ...patch })).teamId).toBeNull();
  });

  /** The newest filter, through the same gate every other one goes through. */
  test("the author survives the address bar and can be taken off again", () => {
    expect(filtersOf(View.parse(viewOf(filtered))).creatorId).toBe("acct_ada");
    const patch = viewOf({ ...filtered, creatorId: null });
    expect(Object.hasOwn(patch, "author")).toBe(true);
    expect(patch.author).toBeUndefined();
    expect(filtersOf(View.parse({ ...viewOf(filtered), ...patch })).creatorId).toBeNull();
  });

  /** The sort is not a filter, and a filter change must not quietly reset it. */
  test("changing a filter leaves the sort alone", () => {
    const before = View.parse({ sort: "title", team: "team-eng" });
    const after = View.parse({
      ...before,
      ...viewOf({ ...filtersOf(before), teamId: "team-ops" }),
    });
    expect(after.sort).toBe("title");
    expect(after.team).toBe("team-ops");
  });
});
