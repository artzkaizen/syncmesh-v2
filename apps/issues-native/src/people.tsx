import { memo } from "react";
import { Text, View } from "react-native";

/**
 * A person, drawn the one way this app draws people.
 *
 * Extracted because the roster, the identity picker and the assignee filter are three screens
 * showing the same six facts, and three copies of an avatar is how they drift — one gets initials
 * from `name`, another from `handle`, and the same person is two different colours on two screens.
 */

/** What every screen that shows a person needs, and no more. */
export interface PersonRow {
  readonly id: string;
  readonly name: string;
  readonly handle: string;
  readonly email: string;
  readonly avatarColor: string;
}

/**
 * Two letters from a name, which is not the same as the first two characters of one.
 *
 * "Ada Okonkwo" is AO and "Bo Lindqvist" is BL, so the initials distinguish people the way a
 * reader expects. A single-word name falls back to its first letter rather than borrowing one from
 * nowhere, and an empty name draws a dash rather than an empty circle that looks like a bug.
 */
export const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "—";
  const [first, ...rest] = words;
  const last = rest.at(-1);
  const head = first?.[0] ?? "";
  return (last === undefined ? head : `${head}${last[0] ?? ""}`).toUpperCase();
};

/**
 * The coloured disc beside a person's name.
 *
 * **Not HeroUI's `Avatar`, and the reason is the colour.** That component takes `color` from a
 * five-token theme enum (`accent | default | success | warning | danger`); a member row carries
 * `avatarColor` as an arbitrary hex, it is workspace data that syncs, and the same person is
 * therefore the same colour on every device — which is the entire point of a colour as an
 * identifier. Folding twelve people onto five theme tokens would put four of them in the same
 * shade and throw that away.
 */
export const Avatar = memo(function Avatar({
  person,
  size = 36,
}: {
  readonly person: PersonRow;
  readonly size?: number;
}) {
  return (
    <View
      className="items-center justify-center rounded-full"
      style={{ backgroundColor: person.avatarColor, height: size, width: size }}
    >
      <Text
        className="font-semibold text-white"
        style={{ fontSize: size * 0.36 }}
        // the initials are decoration over a name the row already states out loud
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {initialsOf(person.name)}
      </Text>
    </View>
  );
});

/** How tall one person's row is, so a list of them never has to measure one. */
export const PERSON_HEIGHT = 56;
