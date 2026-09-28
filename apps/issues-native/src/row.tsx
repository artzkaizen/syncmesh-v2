import { memo } from "react";
import { Pressable, Text, View } from "react-native";

import type { PersonRow } from "./people";

import { PriorityGlyph, StatusGlyph } from "./glyphs";
import { Avatar } from "./people";

/**
 * What a row draws — the columns of the issue it needs and the two things it cannot know.
 *
 * Narrower than the query's row on purpose: a row typed as the whole record re-renders whenever
 * any column of it moves, and a list is the one place that is felt. `teamKey` and `assignee` are
 * resolved by the screen from catalogs it already holds, because `issues.list` returns ids and a
 * row has no business running two more queries to turn them into three letters and a face.
 */
export interface RowIssue {
  readonly id: string;
  readonly number: number | null;
  readonly title: string;
  readonly priority: number;
  /**
   * The column as the database has it, which is `text`.
   *
   * `IssueStatus` is a *check* the schema runs at every fold, not something a read can promise:
   * the row came out of SQLite, and SQLite has no unions. Typing it as the union here would be
   * this file claiming a guarantee the query cannot make, so the glyph carries a fallback instead
   * — and a status this build has never heard of draws as a plain ring rather than crashing.
   */
  readonly status: string;
}

/**
 * The height every row draws at, so the list never has to measure one.
 *
 * A virtualized list that does not know an item's size has to render it, read its layout back, and
 * correct the scroll range it had guessed — per item, while the finger is down. Fixing the height
 * here and handing the same number to `getFixedItemSize` deletes that whole loop: the list can
 * place every container from arithmetic alone. It costs the title one truncation rule it already
 * had, which is the only reason a row could have varied in the first place.
 *
 * 44 is Apple's minimum touch target and the number Linear's own list sits at. The previous 72 was
 * a card's height, not a row's, and it is most of why nine issues filled a screen that should hold
 * fourteen.
 */
export const ROW_HEIGHT = 44;

/**
 * One issue, as a row.
 *
 * **Flat, not a card.** Every row used to be a `Surface` with a radius and a fill, which is the
 * shape of a *thing you act on* — a button, a tile — and a list of forty of them is forty boxes
 * competing for the same attention. Linear draws issues as plain rows on the page and reserves
 * containers for things that genuinely group. The gain is not subtle: the same screen goes from
 * nine issues to fourteen, and the eye follows the left edge instead of bouncing over corners.
 *
 * **The identifier is allowed to be missing.** An issue filed on this phone has no number until an
 * authority hands one out (book ch. 1), and the honest rendering of that is the team key with the
 * number withheld — not a spinner, and not a zero. It is the same fact the web app draws as
 * `ENG-•`, and it is what says the write is real before anything acknowledged it.
 *
 * `memo` because Legend List recycles: a row that re-renders on every scroll frame is most of the
 * cost of a list, and the props above are the only things that can change it.
 */
export const IssueRow = memo(function IssueRow({
  assignee,
  issue,
  onPress,
  teamKey,
}: {
  readonly assignee: PersonRow | undefined;
  readonly issue: RowIssue;
  readonly onPress: (id: string) => void;
  readonly teamKey: string;
}) {
  return (
    <Pressable
      accessibilityLabel={`${teamKey}-${issue.number === null ? "unnumbered" : String(issue.number)}: ${issue.title}`}
      accessibilityRole="button"
      className="flex-row items-center gap-2.5 active:opacity-50"
      onPress={() => onPress(issue.id)}
      style={{ height: ROW_HEIGHT }}
    >
      <PriorityGlyph priority={issue.priority} />
      <StatusGlyph status={issue.status} />
      <Text className="w-[54px] text-[13px] text-muted-foreground" numberOfLines={1}>
        {issue.number === null ? `${teamKey}-•` : `${teamKey}-${String(issue.number)}`}
      </Text>
      {/* one line, because a title that can wrap is a row that can vary, and a row that can vary
          is a list that has to measure — see {@link ROW_HEIGHT} */}
      <Text className="flex-1 text-[15px] text-foreground" numberOfLines={1}>
        {issue.title}
      </Text>
      {/* the slot is kept even when nobody is assigned, so the right edge of the list stays a line
          rather than a ragged one that moves as rows scroll past */}
      <View className="w-6 items-center">
        {assignee === undefined ? (
          <View className="h-6 w-6 rounded-full border border-dashed border-border" />
        ) : (
          <Avatar person={assignee} size={24} />
        )}
      </View>
    </Pressable>
  );
});
