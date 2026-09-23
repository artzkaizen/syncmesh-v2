import type { Role } from "@syncmesh/issues";

import { LegendList } from "@legendapp/list/react-native";
import { ROLES, ROLE_EXPLAINS, WORKSPACE_ID } from "@syncmesh/issues";
import { useLiveQuery } from "@syncmesh/react";
import { useRouter } from "expo-router";
import { Button, Spinner } from "heroui-native";
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import type { PersonRow } from "../src/people";

import { mesh, useDevice } from "../src/device";
import { Avatar, PERSON_HEIGHT } from "../src/people";

/**
 * Who to go in as — the screen a fresh install opens on.
 *
 * **This is a demo affordance and it says so out loud.** Every build of this app carries the
 * issuer's private key, so it can mint itself a grant for anybody in the workspace at any role;
 * `actor.ts` documents what a real deployment does instead. What that shortcut buys is the thing
 * this screen exists for: the ability to watch the *same workspace* from twelve people's seats and
 * four rungs of the ladder, without twelve installs and without a server to ask.
 *
 * Choosing does not touch the log, the device key, or a single row of state. It mints a grant and
 * registers it; the engine keeps the grant with the newest `issuedAt` per device, so the change
 * is one object replacing another. Nothing resyncs.
 */
export default function IdentityScreen() {
  const device = useDevice();
  const router = useRouter();
  const people = useLiveQuery(mesh.api.members.list({ workspaceId: WORKSPACE_ID }));

  /**
   * The selection, held here and not written until the button is pressed.
   *
   * A picker that signed in on every tap would make "browsing who exists" indistinguishable from
   * "becoming them", and on a list of twelve that is a lot of grants minted by a scrolling thumb.
   * It starts from whoever this install currently is, so the screen opens on the current answer.
   */
  const [account, setAccount] = useState(device.actor.account);
  const [role, setRole] = useState<Role>(device.actor.role);
  const [entering, setEntering] = useState(false);
  const [failed, setFailed] = useState<string>();

  const enter = useCallback(() => {
    setEntering(true);
    setFailed(undefined);
    void device
      .signInAs({ account, role })
      // `dismissTo` rather than `push`: this screen is reachable from settings as well as from a
      // cold start, and a back stack that can return to "who are you" after the answer is a stack
      // that can show the list as two different people at once
      .then(() => router.dismissTo("/"))
      .catch((cause: unknown) => {
        setFailed(cause instanceof Error ? cause.message : "the grant would not register");
        setEntering(false);
      });
  }, [account, device, role, router]);

  const renderItem = useCallback(
    ({ item }: { readonly item: PersonRow }) => {
      const picked = item.id === account;
      return (
        <Pressable
          accessibilityLabel={`${item.name}, @${item.handle}`}
          accessibilityRole="button"
          accessibilityState={{ selected: picked }}
          className="h-14 flex-row items-center gap-3 active:opacity-60"
          onPress={() => setAccount(item.id)}
        >
          <Avatar person={item} size={32} />
          <View className="flex-1">
            <Text className="text-[15px] text-foreground" numberOfLines={1}>
              {item.name}
            </Text>
            <Text className="text-[13px] text-muted-foreground" numberOfLines={1}>
              @{item.handle}
            </Text>
          </View>
          {/* a filled disc with a tick, not a tinted background: two adjacent greys are not a
              signal on a phone in daylight */}
          <View
            className={
              picked
                ? "h-[22px] w-[22px] items-center justify-center rounded-full bg-accent"
                : "h-[22px] w-[22px] rounded-full border border-border"
            }
          >
            {picked ? (
              <Text className="text-[12px] font-bold text-accent-foreground">✓</Text>
            ) : null}
          </View>
        </Pressable>
      );
    },
    [account],
  );

  if (people.answered === "none") return <Notice>Reading the workspace…</Notice>;

  /**
   * An empty roster is a workspace this device has not heard yet, not a workspace with nobody in
   * it — and on a first launch those are minutes apart. Offering the default is what keeps the
   * app enterable meanwhile; the list fills in behind it and the choice can be made again.
   */
  if (people.data.length === 0)
    return (
      <View className="flex-1 items-center justify-center gap-4 p-8">
        {people.answered === "settled" ? null : <Spinner size="sm" />}
        <Text className="text-center text-[15px] text-muted-foreground">
          {people.answered === "settled"
            ? "This workspace has no members yet."
            : "Catching up with the workspace — nobody has arrived yet."}
        </Text>
        <Button
          onPress={() => void device.signInAs(device.actor).then(() => router.dismissTo("/"))}
        >
          Continue as {device.actor.account.replace("acct_", "")}
        </Button>
      </View>
    );

  return (
    <View className="flex-1">
      <LegendList
        contentContainerStyle={{ paddingBottom: 16, paddingHorizontal: 16 }}
        contentInsetAdjustmentBehavior="automatic"
        data={people.data}
        /**
         * The selection is not in `data`, so the list has to be told it changed.
         *
         * `recycleItems` reuses a row's views for whatever item scrolls into its place, and the
         * list re-renders a row when its *item* changes — which the tick moving from Ada to Bo is
         * not. Without this the tap set the state and nothing on screen moved, which reads exactly
         * like a tap that was never received.
         */
        extraData={account}
        getFixedItemSize={() => PERSON_HEIGHT}
        keyExtractor={(person) => person.id}
        ListHeaderComponent={
          <Text className="py-3 text-[13px] leading-[18px] text-muted-foreground">
            Everything you file, comment on and react to is attributed to this person, and the role
            decides what the workspace lets you do.
          </Text>
        }
        recycleItems
        renderItem={renderItem}
        /**
         * **A scroll view in a flex column does not flex by default**, so this sized itself to
         * twelve rows of content and pushed the bar below it — the role chips and the button that
         * actually signs in — off the bottom of the screen.
         */
        style={{ flex: 1 }}
      />

      <View className="gap-3 border-t border-border px-4 pb-8 pt-4">
        <Text className="text-[13px] font-medium text-muted-foreground">Role</Text>
        {/* a segmented control, sized to the row: four chips of different widths read as tags
            rather than as one choice among four */}
        <View className="flex-row rounded-xl bg-surface-secondary p-1">
          {ROLES.map((rung) => (
            <Pressable
              accessibilityLabel={rung}
              accessibilityRole="button"
              accessibilityState={{ selected: rung === role }}
              className={
                rung === role
                  ? "h-9 flex-1 items-center justify-center rounded-lg bg-accent"
                  : "h-9 flex-1 items-center justify-center rounded-lg"
              }
              key={rung}
              onPress={() => setRole(rung)}
            >
              <Text
                className={
                  rung === role
                    ? "text-[13px] font-medium text-accent-foreground"
                    : "text-[13px] text-muted-foreground"
                }
              >
                {rung}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text className="text-[12px] leading-[17px] text-muted-foreground">
          {ROLE_EXPLAINS[role]}
        </Text>
        {failed === undefined ? null : <Text className="text-[12px] text-danger">{failed}</Text>}
        <Button isDisabled={entering} onPress={enter} size="lg">
          {entering ? "Entering…" : "Enter workspace"}
        </Button>
      </View>
    </View>
  );
}

const Notice = ({
  children,
  spinner = true,
}: {
  readonly children: React.ReactNode;
  readonly spinner?: boolean;
}) => (
  <View className="flex-1 items-center justify-center gap-3 p-8">
    {spinner ? <Spinner size="sm" /> : null}
    <Text className="text-center text-[15px] text-muted-foreground">{children}</Text>
  </View>
);
