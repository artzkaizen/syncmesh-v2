import { useCallback, useMemo, useState } from "react";

import type { Picker } from "./issue-parts";
import type { PersonRow } from "./people";

import { PRIORITY_CHOICES, STATUS_CHOICES, labelChoices, peopleChoices } from "./choices";

/**
 * The one sheet's state: which question, and whether it is being asked.
 *
 * `which` outlives `open` on purpose. A choice closes the sheet, and the sheet then animates out
 * over the frames that follow; content read off a "nothing is open" state would blank — or, worse,
 * swap to another picker's rows — halfway down. Keeping the two facts apart is what lets the sheet
 * go on showing the question it was asked while it leaves.
 */
interface Asked {
  readonly which: Picker;
  readonly open: boolean;
}

/** One pick per question, each a write. */
interface Picks {
  readonly pickAssignee: (who: string) => void;
  readonly pickLabel: (labelId: string) => void;
  readonly pickPriority: (level: string) => void;
  readonly pickStatus: (status: string) => void;
}

/**
 * What the one sheet is currently asking — the whole of the difference from four of them.
 *
 * There was a `PickerSheet` per property, all four mounted, to show one at a time. Each is a
 * full-window overlay with its own gesture detector and animation state, so the screen paid four
 * native mounts on arrival and reconciled four subtrees on every write: measured, ~290ms of
 * nothing drawing when the push animation ended, and ~960ms after an assignment landed. One
 * sheet asking whichever question was pressed is the same interaction and a quarter of the tree.
 *
 * Memoised because `PickerSheet` is `memo`'d: a fresh props object every render would defeat
 * that as surely as the fresh arrays in `src/choices.tsx` did — and this screen re-renders on
 * every keystroke in the description field.
 */
export function useIssuePicker({
  attachedIds,
  labels,
  people,
  picks,
  row,
}: {
  readonly attachedIds: ReadonlySet<string>;
  readonly labels: readonly {
    readonly id: string;
    readonly name: string;
    readonly color: string;
  }[];
  readonly people: readonly PersonRow[];
  readonly picks: Picks;
  readonly row:
    | { readonly assigneeId: string | null; readonly priority: number; readonly status: string }
    | undefined;
}) {
  const [sheet, setSheet] = useState<Asked>({ open: false, which: "status" });
  // memoised because `PickerSheet` is `memo`'d and a fresh array every render defeats that
  // outright — see `src/choices.tsx` for what four reconciled sheets cost a write
  const whoChoices = useMemo(() => peopleChoices(people), [people]);
  const whichLabels = useMemo(() => labelChoices(labels), [labels]);
  const ask = useCallback((which: Picker) => setSheet({ open: true, which }), []);
  const answered = useCallback(
    (open: boolean) => (open ? undefined : setSheet((was) => ({ ...was, open: false }))),
    [],
  );
  const { pickAssignee, pickLabel, pickPriority, pickStatus } = picks;
  const asking = useMemo(() => {
    const pick = {
      assignee: {
        choices: whoChoices,
        onPick: pickAssignee,
        selected: row?.assigneeId ?? "",
        title: "Assignee",
      },
      labels: {
        choices: whichLabels,
        multiple: true,
        onPick: pickLabel,
        selected: attachedIds,
        title: "Labels",
      },
      priority: {
        choices: PRIORITY_CHOICES,
        onPick: pickPriority,
        selected: row === undefined ? undefined : String(row.priority),
        title: "Priority",
      },
      status: {
        choices: STATUS_CHOICES,
        onPick: pickStatus,
        selected: row?.status,
        title: "Status",
      },
    };
    return pick[sheet.which];
  }, [
    attachedIds,
    pickAssignee,
    pickLabel,
    pickPriority,
    pickStatus,
    row,
    sheet.which,
    whichLabels,
    whoChoices,
  ]);

  return { answered, ask, asking, sheet };
}
