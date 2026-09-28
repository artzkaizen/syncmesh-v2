import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { BottomSheet } from "heroui-native";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { sawHandedOff, sawPick, sawSheetShut } from "./pick-timing";

/**
 * The one way this app asks "which one?".
 *
 * **A sheet rather than `Alert.alert`**, which is what the first pass reached for and is wrong for
 * this in every respect: an alert cannot show a status glyph, an avatar or a colour swatch, it caps
 * out at a handful of buttons long before twelve people fit, and it is a system modal that looks
 * like an error. Every property on an issue is picked from the same component here, so status,
 * priority, assignee and labels are one interaction learned once.
 *
 * `HeroUINativeProvider` is already the root and `GestureHandlerRootView` wraps it, which is what
 * makes the drag-to-dismiss work — the layout has had both since before this screen existed.
 */

/** One row of a sheet: what it says, what it looks like, and whether it is the current answer. */
export interface Choice {
  readonly key: string;
  readonly label: string;
  /** Drawn at the leading edge — a status ring, a priority meter, an avatar, a colour. */
  readonly lead?: React.ReactNode;
  /** The quieter second line, where a choice needs explaining rather than naming. */
  readonly hint?: string;
}

/**
 * A modal list of choices, with the current one ticked.
 *
 * Multi-select is the same component with `selected` as a set and no auto-dismiss, because labels
 * are picked several at a time while a status is picked once — and making those two different
 * components is how they end up looking different for no reason a person could name.
 */
export const PickerSheet = memo(function PickerSheet({
  choices,
  isOpen,
  multiple = false,
  onOpenChange,
  onPick,
  selected,
  title,
  warm = false,
}: {
  readonly choices: readonly Choice[];
  readonly isOpen: boolean;
  readonly multiple?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (key: string) => void;
  /** The chosen key, or every chosen key when `multiple`. */
  readonly selected: string | ReadonlySet<string> | undefined;
  readonly title: string;
  /**
   * Mount now, closed, without being opened — for a screen that has finished its transition and
   * would rather pay this cost while nobody is waiting than on the tap that opens it.
   */
  readonly warm?: boolean;
}) {
  const isPicked = (key: string) =>
    typeof selected === "string" ? selected === key : (selected?.has(key) ?? false);

  // the closing edge, in the commit phase: an effect would fire after paint and fold the span
  // being measured — the gap before the first frame — into nothing
  const was = useRef(isOpen);
  useLayoutEffect(() => {
    if (was.current && !isOpen) sawSheetShut();
    was.current = isOpen;
  }, [isOpen]);

  /**
   * Mounting in stages: absent, then mounted-closed, then open.
   *
   * **An earlier "optimisation" returned `null` until `isOpen` and broke every picker in the
   * app**, because `BottomSheet` presents on the *transition* from closed to open. A sheet mounted
   * with `isOpen` already `true` never observes that edge, so the portal never presents and the
   * tap does nothing — status, priority, assignee and labels were all dead. The staging here is
   * what makes a lazy mount legal: the first commit mounts it **closed**, and only the next one
   * opens it, so the edge exists to be seen.
   *
   * The cost this avoids was measured on the same screen with and without these four sheets, on
   * one device over one replica: `commit→paint` **661ms against 104ms**, and the native push
   * transition held off until **731ms against 132ms**. None of that was JavaScript — the thread
   * went idle 8ms after the commit and then nothing drew for 636ms, which is UIKit mounting four
   * full-screen overlays, each with its own gesture detector and animation state, all closed.
   *
   * An earlier note here said the opposite, on the strength of pushing the *roster* and finding it
   * slower. That compared two different screens and settled nothing; this compares one screen
   * against itself.
   */
  const [stage, setStage] = useState<"absent" | "closed" | "open">(warm ? "closed" : "absent");
  useEffect(() => {
    if (stage === "absent" && (isOpen || warm)) setStage("closed");
    else if (stage === "closed" && isOpen) setStage("open");
    else if (stage === "open" && !isOpen) setStage("closed");
  }, [isOpen, stage, warm]);

  if (stage === "absent") return null;

  return (
    <BottomSheet isOpen={stage === "open"} onOpenChange={onOpenChange}>
      {/**
       * **`disableFullWindowOverlay` because the sheet is otherwise invisible to tooling.**
       *
       * On iOS `FullWindowOverlay` puts overlay content in a *separate native window*, so it
       * floats above native modals and the keyboard. The cost is that anything attached to the
       * app's main window cannot see it: the accessibility tree comes back without it, screenshots
       * come back without it, and the React Native element inspector stops working. An open sheet
       * and an absent one look identical from outside — which is exactly how this was mistaken for
       * a sheet that would not open.
       *
       * The trade is that the sheet no longer renders above a *native* modal. Nothing in this app
       * presents one over an issue, so that costs nothing here and buys back the ability to see
       * what we are building.
       */}
      <BottomSheet.Portal disableFullWindowOverlay>
        <BottomSheet.Overlay />
        {/**
         * `snapPoints` rather than dynamic sizing, and a **gorhom** scroll view rather than the
         * plain one — which together are why this sheet never appeared at all.
         *
         * A sheet with no snap points sizes itself to its content, and to do that gorhom has to
         * measure it. A React Native `ScrollView` reports no intrinsic height (a `max-h` class is
         * a ceiling, not a size), so the measurement came back as nothing and the sheet opened to
         * nothing: no error, no warning, no visible sheet. Naming a snap point removes the need to
         * measure, and `BottomSheetScrollView` is the scroller that hands its gestures to the
         * sheet instead of fighting it for the drag.
         *
         * **`accessible={false}`, or the whole sheet is one accessibility element.**
         *
         * gorhom wraps a sheet's children in a view that defaults to `accessible`, labelled
         * "Bottom Sheet" with the `adjustable` role — it is describing the sheet as a single
         * slider you drag up and down. On iOS an accessible view *replaces* its subtree in the
         * accessibility tree, so every row inside it stops existing: VoiceOver reads "Bottom
         * Sheet, adjustable" and offers nothing to choose, and a UI driver sees an open sheet as
         * one opaque node with no options to press. That is what "the sheet never opens" was —
         * it was drawing the whole time and missing only from the tree this app is tested
         * through.
         *
         * Every row already carries its own role and label, so handing accessibility back to
         * them costs nothing, and the drag handle keeps its own label for the gesture.
         */}
        <BottomSheet.Content accessible={false} enableDynamicSizing={false} snapPoints={["55%"]}>
          <View className="gap-1 px-5 pb-2 pt-1">
            <BottomSheet.Title className="text-[17px] font-semibold">{title}</BottomSheet.Title>
          </View>
          {/* 55% rather than full height: a sheet that covers the issue it is editing has taken
              the context away from the choice being made */}
          <BottomSheetScrollView contentContainerStyle={{ paddingBottom: 48 }} style={{ flex: 1 }}>
            {choices.map((choice) => (
              <Pressable
                accessibilityLabel={choice.label}
                accessibilityRole="button"
                accessibilityState={{ selected: isPicked(choice.key) }}
                className="min-h-[52px] flex-row items-center gap-3 px-5 active:bg-surface-secondary"
                key={choice.key}
                onPress={() => {
                  sawPick(title);
                  onPick(choice.key);
                  sawHandedOff();
                  // picking one thing closes; picking several does not, or every label costs a
                  // re-open — the asymmetry is the whole reason `multiple` exists
                  if (!multiple) onOpenChange(false);
                }}
              >
                {choice.lead === undefined ? null : (
                  <View className="w-5 items-center">{choice.lead}</View>
                )}
                <View className="flex-1 py-2">
                  <Text className="text-[16px] text-foreground">{choice.label}</Text>
                  {choice.hint === undefined ? null : (
                    <Text className="text-[13px] text-muted-foreground">{choice.hint}</Text>
                  )}
                </View>
                {isPicked(choice.key) ? (
                  <Text className="text-[17px] font-semibold text-accent">✓</Text>
                ) : null}
              </Pressable>
            ))}
          </BottomSheetScrollView>
        </BottomSheet.Content>
      </BottomSheet.Portal>
    </BottomSheet>
  );
});
