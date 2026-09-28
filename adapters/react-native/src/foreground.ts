import type { Knock } from "@syncmesh/client";

import { AppState } from "react-native";

/**
 * The app coming back to the front, as a {@link Knock} on every medium's door.
 *
 * **The cheapest recovery a phone has, and the one that covers the ordinary case.** Almost
 * everything a person does to fix their connection takes them out of the app and brings them back:
 * toggling Wi-Fi means Settings or Control Centre, joining a network means the Wi-Fi list, leaving
 * aeroplane mode means the same. Every one of those ends with this app becoming `active` again, and
 * this is the signal that says so — no native module, no permission, nothing to rebuild for.
 *
 * It does not cover a network that comes and goes while the app stays in front: a train, a lift, an
 * access point with a captive portal. That is what `reachability` in `@syncmesh/react-native/network`
 * is for, and the two are meant to be used together — they knock on the same door for different
 * reasons, and the mesh does not care which of them knocked.
 *
 * Returning to the foreground is also the moment it matters most. The link has had the whole
 * background to go stale, the person is looking at the screen, and the ~37 seconds a relay takes to
 * notice a dead socket on its own is time spent watching a list that is not updating.
 *
 * @example
 * const app = createClient({ schema, procedures, knocks: [foreground()] });
 */
export const foreground = (): Knock => (wake) => {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") wake();
  });
  return () => subscription.remove();
};
