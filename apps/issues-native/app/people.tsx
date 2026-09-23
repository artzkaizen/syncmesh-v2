import { LegendList } from "@legendapp/list/react-native";
import { WORKSPACE_ID } from "@syncmesh/issues";
import { useLiveQuery } from "@syncmesh/react";
import { useRouter } from "expo-router";
import { Spinner } from "heroui-native";
import { useCallback, useLayoutEffect, useMemo } from "react";
import { Alert, Pressable, Text, View } from "react-native";

import type { PersonRow } from "../src/people";

import { mesh, useActor, useDevice } from "../src/device";
import { sawCommit, sawRender } from "../src/nav-timing";
import { Avatar, PERSON_HEIGHT } from "../src/people";

/**
 * Who is in this workspace, and how much open work each of them is carrying.
 *
 * **A roster, not a filter.** The web app has had "People" in its sidebar for a while, but that is
 * a list of names that narrows a query — it cannot answer "who is on this team", "who is drowning",
 * or "who am I". This screen is the noun; tapping a row offers the two verbs.
 *
 * The counts come from one grouped read (`members.workload`) rather than a query per person. A
 * roster that asked twelve questions would re-run twelve subscriptions on every fold, and the same
 * screen over a real workspace would ask hundreds.
 */
export default function PeopleScreen() {
  const actor = useActor();
  const device = useDevice();
  sawRender();
  useLayoutEffect(sawCommit, []);
  const router = useRouter();
  const people = useLiveQuery(mesh.api.members.list({ workspaceId: WORKSPACE_ID }));
  const workload = useLiveQuery(mesh.api.members.workload({ workspaceId: WORKSPACE_ID }));

  const openBy = useMemo(
    () =>
      new Map(
        workload.data.flatMap((row) =>
          row.assigneeId === null ? [] : [[row.assigneeId, row.open] as const],
        ),
      ),
    [workload.data],
  );

  /**
   * Tapping a person asks which of the two things it meant, because both are reasonable.
   *
   * "Show me their work" is the roster narrowing the list. "Become them" is the demo affordance
   * this whole build exists to offer — and it is the one a person looking at a list of users
   * reaches for first. Guessing either way is how a tap ends up feeling broken: the roster used to
   * silently do the first, so anybody here to switch users found a screen that appeared to ignore
   * them.
   */
  const choose = useCallback(
    (person: PersonRow) => {
      const mine = person.id === actor.account;
      Alert.alert(person.name, mine ? "This is who you are." : undefined, [
        { style: "cancel", text: "Cancel" },
        {
          onPress: () => router.push({ pathname: "/", params: { assignee: person.id } }),
          text: "Show their issues",
        },
        ...(mine
          ? []
          : [
              {
                onPress: () =>
                  void device
                    .signInAs({ account: person.id, role: actor.role })
                    .then(() => router.back()),
                // the role is carried over rather than reset: somebody switching from the roster
                // is changing who, not what they may do — the picker is where that is chosen
                text: `Sign in as ${person.name.split(" ")[0] ?? person.name}`,
              },
            ]),
      ]);
    },
    [device, router],
  );

  const renderItem = useCallback(
    ({ item }: { readonly item: PersonRow }) => {
      const open = openBy.get(item.id) ?? 0;
      const mine = item.id === actor.account;
      return (
        <Pressable
          accessibilityLabel={`${item.name}, @${item.handle}`}
          accessibilityRole="button"
          className="h-14 flex-row items-center gap-3 active:opacity-60"
          onPress={() => choose(item)}
        >
          <Avatar person={item} size={32} />
          <View className="flex-1">
            <View className="flex-row items-center gap-1.5">
              <Text className="text-[15px] text-foreground" numberOfLines={1}>
                {item.name}
              </Text>
              {mine ? <Text className="text-[13px] text-accent">you</Text> : null}
            </View>
            <Text className="text-[13px] text-muted-foreground" numberOfLines={1}>
              @{item.handle}
            </Text>
          </View>
          {/* a zero is worth drawing: "nothing assigned" is a fact about a person, and a blank
              space is the same pixels as a count that failed to load */}
          <Text className="text-[13px] text-muted-foreground">{String(open)}</Text>
        </Pressable>
      );
    },
    [choose, openBy, actor.account],
  );

  if (people.answered === "none") return <Notice>Reading the workspace…</Notice>;
  if (people.data.length === 0)
    return people.answered === "settled" ? (
      <Notice spinner={false}>This workspace has no members yet.</Notice>
    ) : (
      <Notice>Catching up with the workspace…</Notice>
    );

  return (
    <LegendList
      contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 16 }}
      contentInsetAdjustmentBehavior="automatic"
      data={people.data}
      // the "you" chip and the counts are not in `data`; a recycled row needs telling they moved
      extraData={`${actor.account}:${String(openBy.size)}`}
      getFixedItemSize={() => PERSON_HEIGHT}
      keyExtractor={(person) => person.id}
      ListHeaderComponent={
        <Text className="py-3 text-[13px] text-muted-foreground">
          {String(people.data.length)} people · the number is how many open issues each is assigned
        </Text>
      }
      recycleItems
      renderItem={renderItem}
      style={{ flex: 1 }}
    />
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
    <Text className="text-center text-muted-foreground">{children}</Text>
  </View>
);
