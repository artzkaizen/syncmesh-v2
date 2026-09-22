import { installNativeCrypto } from "@syncmesh/react-native/crypto";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider, Spinner } from "heroui-native";
import { Pressable, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import type { MeshUnavailable } from "../src/mesh";

import { MeshGate } from "../src/device";
import { sawTap } from "../src/nav-timing";

import "@syncmesh/react-native/entropy";

import "../global.css";

/**
 * The shell every screen draws inside.
 *
 * `GestureHandlerRootView` is outermost because HeroUI's overlays are gesture-driven and mount
 * into it — a sheet that dismisses by dragging has nothing to drag against otherwise. Beyond that
 * there is nothing here but the gate: no store and no query client. {@link MeshGate} is the
 * one place that knows the database opens slowly — it asks once, above the navigator, and every
 * screen below it is handed a replica rather than a verdict about one.
 *
 * It used to be the other way round: eight screens each subscribed to the open state and each
 * re-answered "is it ready" before it could draw, in four spellings of the same card. That is one
 * question, with one answer, that changes once per launch. It belongs here.
 */
installNativeCrypto();

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <HeroUINativeProvider>
        <StatusBar style="auto" />
        {/**
         * **Large titles are off by default, and that is a measured decision rather than taste.**
         *
         * A large title is not a font size — it is the collapsing-header machinery, an extra
         * layout pass, and on iOS 26 a blurred bar underneath it. Pushing the *same* screen with
         * and without one:
         *
         * ```
         * with:    render→commit 26ms · commit→paint 175ms · visible at 215ms
         * without: render→commit  8ms · commit→paint  99ms · visible at 116ms
         * ```
         *
         * Roughly 100ms per push, on a simulator, for every screen in the app. The root list keeps
         * one because that is where it is actually read as a title; nothing you navigate *to*
         * pays for it, because a pushed screen already has its name in the bar you came from.
         */}
        <MeshGate
          whenUnavailable={(reason: MeshUnavailable) => <Blocked>{reason.message}</Blocked>}
          whileOpening={<Blocked spinner>Opening the local database…</Blocked>}
        >
          <Stack screenOptions={{ headerLargeTitle: false }}>
            <Stack.Screen
              name="index"
              options={{
                headerLargeTitle: true,
                title: "Issues",
                /**
                 * The two places the app goes that are not an issue.
                 *
                 * In the header rather than a tab bar because there are two of them and they are
                 * both *leaving* the list rather than peers of it — a tab bar would say the roster
                 * and the settings are as important as the work, which they are not.
                 */
                headerRight: () => (
                  <View className="flex-row items-center gap-4">
                    <HeaderLink href="/people">People</HeaderLink>
                    <HeaderLink href="/settings">Settings</HeaderLink>
                  </View>
                ),
              }}
            />
            <Stack.Screen name="issues/[id]" options={{ headerLargeTitle: false, title: "" }} />
            {/* a static route beside the dynamic one, which Expo Router resolves first */}
            <Stack.Screen
              name="issues/new"
              options={{ headerLargeTitle: false, presentation: "modal", title: "New issue" }}
            />
            <Stack.Screen name="people" options={{ title: "People" }} />
            <Stack.Screen name="settings" options={{ title: "Settings" }} />
            <Stack.Screen name="workspace" options={{ title: "Workspace" }} />
            <Stack.Screen name="devtools" options={{ title: "Devtools" }} />
            {/* a sheet, because choosing who you are is a decision over the app rather than a place
                in it — and because it is reachable both from a cold start and from settings */}
            <Stack.Screen
              name="identity"
              options={{ headerLargeTitle: false, presentation: "modal", title: "Go in as" }}
            />
          </Stack>
        </MeshGate>
      </HeroUINativeProvider>
    </GestureHandlerRootView>
  );
}

/**
 * A header destination, as a control the platform can actually see.
 *
 * **`Link` wrapping a bare `Text` is not a button.** It renders as text with a press handler, so
 * the accessibility tree reports it as `other` — VoiceOver does not announce it as tappable, and
 * neither a UI test nor a screen reader can reliably activate it. It was found exactly that way:
 * the driver could not press "People" at all. A `Pressable` with a role, a label and a real touch
 * target is the honest version, and the 44pt height is Apple's minimum rather than a guess.
 */
const HeaderLink = ({
  children,
  href,
}: {
  readonly children: React.ReactNode;
  readonly href: "/people" | "/settings";
}) => {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      className="h-11 justify-center px-1 active:opacity-50"
      onPress={() => {
        sawTap(href);
        router.push(href);
      }}
    >
      <Text className="text-[16px] text-accent">{children}</Text>
    </Pressable>
  );
};

/**
 * The whole app, not drawn yet, said once.
 *
 * Above the navigator rather than inside a screen, because "this device has no database" is not a
 * fact about the issue list — and a card drawn per screen is a card that drifts per screen, which
 * is what four slightly different versions of it had already done.
 */
const Blocked = ({
  children,
  spinner = false,
}: {
  readonly children: React.ReactNode;
  readonly spinner?: boolean;
}) => (
  <View className="flex-1 items-center justify-center gap-3 p-8">
    {spinner ? <Spinner /> : null}
    <Text className="text-center text-[15px] text-muted">{children}</Text>
  </View>
);
