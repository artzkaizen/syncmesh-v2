import { useNavigation } from "expo-router";
import { useEffect, useState } from "react";

/**
 * Whether this screen's push animation has finished — for work worth doing, but not yet.
 *
 * **Not `InteractionManager.runAfterInteractions`**, which is the usual answer and is wrong here.
 * It waits on interaction *handles*, and a native stack transition is run by UIKit rather than by
 * React Native's animation loop, so it registers none: the callback fires on the very next tick,
 * in the same breath as the mount it was supposed to follow. Measured, deferring this screen's
 * pickers that way moved nothing at all — `commit→paint` stayed at 510ms against the 104ms the
 * screen costs without them.
 *
 * `transitionEnd` is UIKit's own answer to the same question, and it is the one that is true.
 */

/** If the event never arrives — a screen presented without an animation — stop waiting. */
const GIVE_UP_MS = 700;

interface Transitions {
  addListener(
    type: "transitionEnd",
    listener: (event: { readonly data: { readonly closing: boolean } }) => void,
  ): () => void;
}

export function useAfterTransition(): boolean {
  const navigation = useNavigation<Transitions>();
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const off = navigation.addListener("transitionEnd", ({ data }) => {
      if (!data.closing) setArrived(true);
    });
    const fallback = setTimeout(() => setArrived(true), GIVE_UP_MS);
    return () => {
      off();
      clearTimeout(fallback);
    };
  }, [navigation]);
  return arrived;
}
