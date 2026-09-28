import { memo } from "react";
import { Pressable, Text, View } from "react-native";

/**
 * A property of an issue, as the pill you press to change it.
 *
 * **Every property is the same control**, which is the thing Linear gets right and the first pass
 * here got wrong: status was a row of radio-ish chips, priority was a dead chip that did nothing,
 * and assignee and labels had no control at all. A reader had to learn which of them were live by
 * pressing them. Here they are one shape — glyph, value, tappable — so "this can be changed" is
 * legible without trying.
 *
 * A pill with nothing set says what it *is* rather than going blank: an unassigned issue reads
 * "Assignee", not an empty box, because an empty box is indistinguishable from one that failed.
 */
export const PropertyPill = memo(function PropertyPill({
  isSet = true,
  lead,
  onPress,
  value,
}: {
  /** Whether this carries a value. An unset pill is drawn dashed and quiet. */
  readonly isSet?: boolean;
  readonly lead?: React.ReactNode;
  readonly onPress?: () => void;
  readonly value: string;
}) {
  return (
    <Pressable
      accessibilityLabel={value}
      accessibilityRole="button"
      className={
        isSet
          ? "h-8 flex-row items-center gap-1.5 rounded-lg border border-border bg-surface-secondary px-2.5 active:opacity-60"
          : "h-8 flex-row items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 active:opacity-60"
      }
      disabled={onPress === undefined}
      onPress={onPress}
    >
      {lead}
      <Text
        className={isSet ? "text-[13px] text-foreground" : "text-[13px] text-muted-foreground"}
        numberOfLines={1}
      >
        {value}
      </Text>
    </Pressable>
  );
});

/** The row those pills sit in — wrapping, because six properties do not fit on one line. */
export const PropertyRow = ({ children }: { readonly children: React.ReactNode }) => (
  <View className="flex-row flex-wrap items-center gap-2">{children}</View>
);
