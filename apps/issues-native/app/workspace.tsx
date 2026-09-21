import type { Write } from "@syncmesh/orpc";

import { WORKSPACE_ID } from "@syncmesh/issues";
import { useCan, useLiveQuery } from "@syncmesh/react";
import { Button, Input, ListGroup, Spinner } from "heroui-native";
import { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { useActor, useApi } from "../src/device";
import { Dot } from "../src/glyphs";

/**
 * Teams, labels and projects — the rows issues hang off, and the one screen where a role bites.
 *
 * **Every button here is gated by `useCan`, which asks the manifest rather than re-stating it.**
 * `team` is `$default: role("admin")`, a label is the same, a project delete is an admin's while
 * making one is any member's. Writing `if (role === "admin")` in this file would be a second copy
 * of those rules that drifts the first time the schema changes; `can("team.insert")` is the schema
 * answering. Signing in as a guest and watching the buttons go flat is the demo.
 *
 * The rules are *enforced* in the engine regardless — a greyed button is a courtesy, not a
 * control. A guest who got past the UI would have the write refused on the way into the log.
 */
export default function WorkspaceScreen() {
  const api = useApi();
  const actor = useActor();
  const teams = useLiveQuery(api.teams.list({ workspaceId: WORKSPACE_ID }));
  const labels = useLiveQuery(api.labels.list({ workspaceId: WORKSPACE_ID }));
  const projects = useLiveQuery(api.projects.list({ workspaceId: WORKSPACE_ID }));

  const mayAddTeam = useCan(api.$can, "team.insert");
  const mayArchiveTeam = useCan(api.$can, "team.update");
  const mayAddLabel = useCan(api.$can, "label.insert");
  const mayRemoveLabel = useCan(api.$can, "label.delete");
  const mayAddProject = useCan(api.$can, "project.insert");
  const mayRemoveProject = useCan(api.$can, "project.delete");

  const [teamName, setTeamName] = useState("");
  const [teamKey, setTeamKey] = useState("");
  const [labelName, setLabelName] = useState("");
  const [projectName, setProjectName] = useState("");

  /**
   * A write, with whatever the engine said about it put on screen.
   *
   * Refusals are the interesting outcome here — sign in as a guest, press something the UI failed
   * to grey out, and this is what shows the rule doing its job. Swallowing them would make the
   * permission model invisible at exactly the moment it is working.
   */
  const attempt = useCallback((what: string, run: () => Write<unknown>, done?: () => void) => {
    // `committed` resolves to a `Result` and never rejects — a refusal is a value here, not a
    // throw, which is exactly why this reads the arm rather than wrapping the call in a `catch`
    void run().committed.then((landed) => {
      if (landed.isErr()) {
        Alert.alert(`${what} was refused`, landed.error.message);
        return;
      }
      done?.();
    });
  }, []);

  const addTeam = () => {
    const key = teamKey.trim().toUpperCase();
    // the procedure's own rule is /^[A-Z]{2,5}$/; checked here only to say so before the round trip
    if (!/^[A-Z]{2,5}$/.test(key) || teamName.trim() === "") {
      Alert.alert("A team needs both", "A name, and a key of two to five capital letters.");
      return;
    }
    attempt(
      "Creating the team",
      () =>
        api.teams.create({
          workspaceId: WORKSPACE_ID,
          key,
          name: teamName.trim(),
          color: PALETTE[teams.data.length % PALETTE.length] ?? "#6366f1",
        }),
      () => {
        setTeamName("");
        setTeamKey("");
      },
    );
  };

  const addLabel = () => {
    if (labelName.trim() === "") return;
    attempt(
      "Creating the label",
      () =>
        api.labels.create({
          workspaceId: WORKSPACE_ID,
          name: labelName.trim(),
          color: PALETTE[labels.data.length % PALETTE.length] ?? "#6366f1",
        }),
      () => setLabelName(""),
    );
  };

  const addProject = () => {
    const teamId = teams.data[0]?.id;
    if (projectName.trim() === "" || teamId === undefined) return;
    attempt(
      "Creating the project",
      () => api.projects.create({ workspaceId: WORKSPACE_ID, teamId, name: projectName.trim() }),
      () => setProjectName(""),
    );
  };

  if (!teams.hasAnswered) return <Notice>Reading the workspace…</Notice>;

  return (
    <ScrollView
      contentContainerStyle={{ gap: 20, padding: 16 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text className="px-1 text-[12px] leading-[17px] text-muted-foreground">
        Acting as {actor.account.replace("acct_", "")} · {actor.role}. What is greyed out below is
        decided by the workspace's own rules, not by this screen.
      </Text>

      <Group title={`Teams · ${String(teams.data.length)}`}>
        <ListGroup>
          {teams.data.map((team) => (
            <ListGroup.Item key={team.id}>
              <ListGroup.ItemPrefix>
                <Dot color={team.color} size={10} />
              </ListGroup.ItemPrefix>
              <ListGroup.ItemContent>
                <ListGroup.ItemTitle>{team.name}</ListGroup.ItemTitle>
                <ListGroup.ItemDescription>{team.key}</ListGroup.ItemDescription>
              </ListGroup.ItemContent>
              <ListGroup.ItemSuffix>
                <Pressable
                  className="h-9 justify-center px-1"
                  disabled={!mayArchiveTeam}
                  onPress={() =>
                    attempt("Archiving the team", () =>
                      api.teams.archive({ workspaceId: WORKSPACE_ID, id: team.id }),
                    )
                  }
                >
                  <Text
                    className={
                      mayArchiveTeam
                        ? "text-[13px] text-danger"
                        : "text-[13px] text-muted-foreground opacity-40"
                    }
                  >
                    Archive
                  </Text>
                </Pressable>
              </ListGroup.ItemSuffix>
            </ListGroup.Item>
          ))}
        </ListGroup>
        {mayAddTeam ? (
          <View className="flex-row items-end gap-2">
            <View className="w-24">
              <Input
                autoCapitalize="characters"
                maxLength={5}
                onChangeText={setTeamKey}
                placeholder="ENG"
                value={teamKey}
              />
            </View>
            <View className="flex-1">
              <Input onChangeText={setTeamName} placeholder="Engineering" value={teamName} />
            </View>
            <Button onPress={addTeam} size="sm">
              Add
            </Button>
          </View>
        ) : (
          <Refused>Only an admin adds a team.</Refused>
        )}
      </Group>

      <Group title={`Labels · ${String(labels.data.length)}`}>
        <View className="flex-row flex-wrap gap-2">
          {labels.data.map((label) => (
            <Pressable
              disabled={!mayRemoveLabel}
              key={label.id}
              onLongPress={() =>
                attempt("Deleting the label", () =>
                  api.labels.remove({ workspaceId: WORKSPACE_ID, id: label.id }),
                )
              }
            >
              <View className="h-8 flex-row items-center gap-1.5 rounded-lg border border-border px-2.5">
                <Dot color={label.color} />
                <Text className="text-[13px] text-foreground">{label.name}</Text>
              </View>
            </Pressable>
          ))}
        </View>
        <Text className="px-1 text-[12px] text-muted-foreground">
          {mayRemoveLabel ? "Long-press a label to delete it." : "Only an admin deletes a label."}
        </Text>
        {mayAddLabel ? (
          <View className="flex-row items-end gap-2">
            <View className="flex-1">
              <Input onChangeText={setLabelName} placeholder="needs-design" value={labelName} />
            </View>
            <Button onPress={addLabel} size="sm">
              Add
            </Button>
          </View>
        ) : null}
      </Group>

      <Group title={`Projects · ${String(projects.data.length)}`}>
        <ListGroup>
          {projects.data.map((project) => (
            <ListGroup.Item key={project.id}>
              <ListGroup.ItemContent>
                <ListGroup.ItemTitle>{project.name}</ListGroup.ItemTitle>
                <ListGroup.ItemDescription>{project.status}</ListGroup.ItemDescription>
              </ListGroup.ItemContent>
              <ListGroup.ItemSuffix>
                <Pressable
                  className="h-9 justify-center px-1"
                  disabled={!mayRemoveProject}
                  onPress={() =>
                    Alert.alert(
                      "Delete project",
                      `"${project.name}" goes from every device that has it.`,
                      [
                        { style: "cancel", text: "Cancel" },
                        {
                          onPress: () =>
                            attempt("Deleting the project", () =>
                              api.projects.remove({ workspaceId: WORKSPACE_ID, id: project.id }),
                            ),
                          style: "destructive",
                          text: "Delete",
                        },
                      ],
                    )
                  }
                >
                  <Text
                    className={
                      mayRemoveProject
                        ? "text-[13px] text-danger"
                        : "text-[13px] text-muted-foreground opacity-40"
                    }
                  >
                    Delete
                  </Text>
                </Pressable>
              </ListGroup.ItemSuffix>
            </ListGroup.Item>
          ))}
        </ListGroup>
        {mayAddProject ? (
          <View className="flex-row items-end gap-2">
            <View className="flex-1">
              <Input
                onChangeText={setProjectName}
                placeholder="Q3 platform work"
                value={projectName}
              />
            </View>
            <Button onPress={addProject} size="sm">
              Add
            </Button>
          </View>
        ) : (
          <Refused>A guest does not make projects.</Refused>
        )}
        {/* the asymmetry is the manifest's and worth naming: any member may make one, only an
            admin may delete one, because a delete syncs to every device and has no way back */}
        <Text className="px-1 text-[12px] text-muted-foreground">
          Any member may make a project. Only an admin may delete one.
        </Text>
      </Group>
    </ScrollView>
  );
}

/** The colours a new team or label gets, so a workspace does not fill up with one hue. */
const PALETTE = ["#6366f1", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#8b5cf6"] as const;

const Refused = ({ children }: { readonly children: React.ReactNode }) => (
  <Text className="px-1 text-[12px] italic text-muted-foreground">{children}</Text>
);

const Group = ({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}) => (
  <View className="gap-2">
    <Text className="px-1 text-[13px] font-medium text-muted-foreground">{title}</Text>
    {children}
  </View>
);

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
