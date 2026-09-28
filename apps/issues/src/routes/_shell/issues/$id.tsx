import { createFileRoute } from "@tanstack/react-router";

import { Detail } from "../../../app/detail.js";

/**
 * `/issues/<id>` — one issue, open, as an address rather than as a selection.
 *
 * **The path and not a search param, because an issue is a thing and a filter is an opinion.**
 * `?team=…` narrows what you are looking at; `/issues/…` names what you are looking at, and it is
 * the only part of this screen worth pasting into a conversation. Putting it in the path also
 * gets the app history for free: opening an issue is a navigation, closing it goes back, and the
 * browser's own buttons walk the trail of what was read.
 *
 * **The id and not `ENG-4`, which is the part that took a decision.** `ENG-4` is prettier and is
 * two columns rendered together — a team's key and the issue's number — and the number is
 * *allocated by an authority*. Until that allocation lands the issue has no number at all
 * (`issues.summary` counts them; the seed leaves thirty unnumbered on purpose, and the header
 * shows the count), so an issue created on a device with the network gone could not be linked to
 * under a name it does not yet have. A URL that cannot be formed for the issue you just made is
 * not a nicer URL. The id is on the row the moment it exists, resolves in one read, and never
 * changes; `Identifier` goes on rendering `ENG-4` where a person can see it.
 *
 * **The remount per issue is the route param's, and was measured rather than assumed.** The
 * router's match id interpolates the params, so `/issues/a` and `/issues/b` are two different
 * matches and React is handed two different keys — the panel's fiber, its DOM and, decisively,
 * the browser's focus are all dropped on the way from one to the other. That is the property
 * `Detail`'s own comment is about: its `<select>` commits on `change`, and a `<select>` that kept
 * focus across a switch answers a typed letter by assigning the *next* issue. Checked in the
 * browser by focusing the picker on one issue, opening another and reading `document.activeElement`
 * back: `body`. Nothing here re-states it as a `key`, because a second guard over the same fact
 * would be a second thing to keep true.
 */
export const Route = createFileRoute("/_shell/issues/$id")({ component: Panel });

function Panel() {
  const { id } = Route.useParams();
  const navigate = Route.useNavigate();
  return <Detail id={id} onClose={() => void navigate({ to: "/" })} />;
}
