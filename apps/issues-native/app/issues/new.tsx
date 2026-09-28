import { ISSUE_STATUS, PRIORITY_NAME, WORKSPACE_ID } from "@syncmesh/issues";
import { useLiveQuery } from "@syncmesh/react";
import { Stack, useRouter } from "expo-router";
import { Spinner } from "heroui-native";
import { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";

import type { Choice } from "../../src/picker-sheet";

import { mesh, useActor } from "../../src/device";
import { PriorityGlyph, StatusGlyph } from "../../src/glyphs";
import { Avatar } from "../../src/people";
import { PickerSheet } from "../../src/picker-sheet";
import { PropertyPill, PropertyRow } from "../../src/property-row";

/**
 * Filing an issue.
 *
 * **A static route beside `[id].tsx`, which Expo Router resolves first**, so `/issues/new` is this
 * screen and `/issues/<uuid>` is the detail — no guard, no reserved id, and no chance of a real
 * issue whose id happens to be "new" being shadowed, because ids here are UUIDs.
 *
 * It files with **no number**, and that is the product rather than a limitation: `ENG-42` is minted
 * by an authority (`claimNumber`), and a tracker that refused to accept an issue until it could
 * reach one would be useless on the train where issues are actually thought of. The row appears in
 * the list immediately, reading `ENG-•` until a number arrives.
 */
type Sheet = "status" | "priority" | "assignee" | "team" | undefined;

export default function NewIssueScreen() {
  const actor = useActor();
  const router = useRouter();
  const teams = useLiveQuery(mesh.api.teams.list({ workspaceId: WORKSPACE_ID }));
  const people = useLiveQuery(mesh.api.members.list({ workspaceId: WORKSPACE_ID }));

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<string>("todo");
  const [priority, setPriority] = useState(0);
  const [assigneeId, setAssigneeId] = useState<string>();
  const [teamId, setTeamId] = useState<string>();
  const [sheet, setSheet] = useState<Sheet>();
  const [filing, setFiling] = useState(false);

  // whichever team the workspace lists first, until somebody says otherwise — an issue has to
  // belong to one, and making that a required tap before typing is a form nobody finishes
  const team = teams.data.find((one) => one.id === teamId) ?? teams.data[0];
  const assignee = people.data.find((person) => person.id === assigneeId);
  const ready = title.trim() !== "" && team !== undefined;

  const file = () => {
    if (!ready) return;
    setFiling(true);
    void mesh.api.issues
      .create({
        workspaceId: WORKSPACE_ID,
        actorId: actor.account,
        teamId: team.id,
        title: title.trim(),
        description: description.trim() === "" ? undefined : description.trim(),
        // SAFETY: every key came from `ISSUE_STATUS`, which is the procedure's own enum
        status: status as never,
        priority,
        assigneeId: assigneeId ?? null,
      })
      .committed.then((landed) => {
        if (landed.isErr()) {
          setFiling(false);
          Alert.alert("The issue was refused", landed.error.message);
          return;
        }
        router.back();
      });
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1"
      keyboardVerticalOffset={Platform.OS === "ios" ? 96 : 0}
    >
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              accessibilityLabel="Create issue"
              accessibilityRole="button"
              disabled={!ready || filing}
              onPress={file}
            >
              <Text
                className={
                  ready && !filing
                    ? "text-[16px] font-medium text-accent"
                    : "text-[16px] font-medium text-muted-foreground opacity-40"
                }
              >
                {filing ? "Filing…" : "Create"}
              </Text>
            </Pressable>
          ),
          title: "New issue",
        }}
      />

      <ScrollView className="flex-1" contentContainerStyle={{ gap: 16, padding: 16 }}>
        <TextInput
          autoFocus
          className="text-[22px] font-semibold text-foreground"
          multiline
          onChangeText={setTitle}
          placeholder="Issue title"
          value={title}
        />
        <TextInput
          className="min-h-32 text-[15px] leading-[22px] text-foreground"
          multiline
          onChangeText={setDescription}
          placeholder="Add a description…"
          textAlignVertical="top"
          value={description}
        />
      </ScrollView>

      {/* the same pills the detail screen uses, so filing and editing are one vocabulary */}
      <View className="border-t border-border px-4 pb-8 pt-3">
        <PropertyRow>
          <PropertyPill
            lead={<StatusGlyph size={14} status={status} />}
            onPress={() => setSheet("status")}
            value={status}
          />
          <PropertyPill
            isSet={priority > 0}
            lead={<PriorityGlyph priority={priority} size={14} />}
            onPress={() => setSheet("priority")}
            value={PRIORITY_NAME[priority] ?? "none"}
          />
          <PropertyPill
            isSet={assignee !== undefined}
            lead={assignee === undefined ? undefined : <Avatar person={assignee} size={16} />}
            onPress={() => setSheet("assignee")}
            value={assignee?.name ?? "Assignee"}
          />
          <PropertyPill
            isSet={team !== undefined}
            onPress={() => setSheet("team")}
            value={team?.key ?? "Team"}
          />
        </PropertyRow>
      </View>

      <PickerSheet
        choices={ISSUE_STATUS.map((one): Choice => ({
          key: one,
          label: one,
          lead: <StatusGlyph size={16} status={one} />,
        }))}
        isOpen={sheet === "status"}
        onOpenChange={(open) => setSheet(open ? "status" : undefined)}
        onPick={setStatus}
        selected={status}
        title="Status"
      />
      <PickerSheet
        choices={PRIORITY_NAME.map((name, level): Choice => ({
          key: String(level),
          label: name,
          lead: <PriorityGlyph priority={level} size={16} />,
        }))}
        isOpen={sheet === "priority"}
        onOpenChange={(open) => setSheet(open ? "priority" : undefined)}
        onPick={(level) => setPriority(Number(level))}
        selected={String(priority)}
        title="Priority"
      />
      <PickerSheet
        choices={[
          { key: "", label: "Unassigned" },
          ...people.data.map((person): Choice => ({
            key: person.id,
            label: person.name,
            hint: `@${person.handle}`,
            lead: <Avatar person={person} size={20} />,
          })),
        ]}
        isOpen={sheet === "assignee"}
        onOpenChange={(open) => setSheet(open ? "assignee" : undefined)}
        onPick={(who) => setAssigneeId(who === "" ? undefined : who)}
        selected={assigneeId ?? ""}
        title="Assignee"
      />
      <PickerSheet
        choices={teams.data.map((one): Choice => ({ key: one.id, label: one.name, hint: one.key }))}
        isOpen={sheet === "team"}
        onOpenChange={(open) => setSheet(open ? "team" : undefined)}
        onPick={setTeamId}
        selected={team?.id ?? ""}
        title="Team"
      />
    </KeyboardAvoidingView>
  );
}
