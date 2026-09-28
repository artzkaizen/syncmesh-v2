import { ISSUE_STATUS, PRIORITY_NAME } from "@syncmesh/issues";

import type { PersonRow } from "./people";
import type { Choice } from "./picker-sheet";

import { Dot, PriorityGlyph, StatusGlyph } from "./glyphs";
import { Avatar } from "./people";

/**
 * What the pickers offer, built once where the answer never changes and memoised where it does.
 *
 * These were array literals inside the screen's own JSX, which is what made `memo` on
 * {@link PickerSheet} do nothing: a fresh `choices` array every render is a changed prop every
 * render, so all four sheets reconciled on every keystroke in the comment box and on every write.
 * The glyphs are React elements held in those arrays, so the cost is not the array — it is four
 * sheets' worth of views handed to UIKit again for a status that moved one pill.
 */

/** The statuses, which are the procedure's own enum and cannot change while the app is open. */
export const STATUS_CHOICES: readonly Choice[] = ISSUE_STATUS.map((status) => ({
  key: status,
  label: status,
  lead: <StatusGlyph size={16} status={status} />,
}));

/** The priority levels, likewise fixed — the index *is* the level. */
export const PRIORITY_CHOICES: readonly Choice[] = PRIORITY_NAME.map((name, level) => ({
  key: String(level),
  label: name,
  lead: <PriorityGlyph priority={level} size={16} />,
}));

/** The roster, with "nobody" first: the empty key is what the procedure takes as an explicit null. */
export const peopleChoices = (people: readonly PersonRow[]): readonly Choice[] => [
  { key: "", label: "Unassigned" },
  ...people.map((person) => ({
    key: person.id,
    label: person.name,
    hint: `@${person.handle}`,
    lead: <Avatar person={person} size={20} />,
  })),
];

/** The workspace's label catalog. */
export const labelChoices = (
  labels: readonly { readonly id: string; readonly name: string; readonly color: string }[],
): readonly Choice[] =>
  labels.map((label) => ({ key: label.id, label: label.name, lead: <Dot color={label.color} /> }));
