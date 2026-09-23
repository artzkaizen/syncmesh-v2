import { WORKSPACE_ID } from "@syncmesh/issues";
import { useCan, useLiveQuery } from "@syncmesh/react";
import { Button, Input, ListGroup, Spinner } from "heroui-native";
import { useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";

import { mesh, useActor } from "../src/device";
import { LabelChip, ProjectRow, TeamRow, attempt } from "../src/workspace-rows";

/**
 * Teams, labels and projects — the rows issues hang off, and the one screen where a role bites.
 *
 * **Every button here is gated by `useCan`, which rehearses the write it guards rather than
 * re-stating the rule.** `team` is `$default: role("admin")`, a label is the same, a project
 * delete is an admin's while making one is any member's. Writing `if (role === "admin")` in this
 * file would be a second copy of those rules that drifts the first time the schema changes;
 * `mesh.api.teams.create.can(…)` runs the handler against the replica, has the staged row judged by
 * the schema, and rolls back — the schema answering. A row's own button rehearses with that
 * row's id; an insert has no row to name yet, so it stages a stand-in that passes the
 * procedure's schema ({@link PROBE}); a row's button lives in `src/workspace-rows.tsx`. Signing
 * in as a guest and watching the buttons go flat is the demo.
 *
 * The rules are *enforced* in the engine regardless — a greyed button is a courtesy, not a
 * control. A guest who got past the UI would have the write refused on the way into the log.
 */
export default function WorkspaceScreen() {
  const actor = useActor();
  const teams = useLiveQuery(mesh.api.teams.list({ workspaceId: WORKSPACE_ID }));
  const labels = useLiveQuery(mesh.api.labels.list({ workspaceId: WORKSPACE_ID }));
  const projects = useLiveQuery(mesh.api.projects.list({ workspaceId: WORKSPACE_ID }));

  const mayAddTeam = useCan(mesh.api.teams.create.can(PROBE.team));
  const mayAddLabel = useCan(mesh.api.labels.create.can(PROBE.label));
  const mayAddProject = useCan(mesh.api.projects.create.can(PROBE.project));

  const [teamName, setTeamName] = useState("");
  const [teamKey, setTeamKey] = useState("");
  const [labelName, setLabelName] = useState("");
  const [projectName, setProjectName] = useState("");

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
        mesh.api.teams.create({
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
        mesh.api.labels.create({
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
      () =>
        mesh.api.projects.create({ workspaceId: WORKSPACE_ID, teamId, name: projectName.trim() }),
      () => setProjectName(""),
    );
  };

  if (teams.answered === "none") return <Notice>Reading the workspace…</Notice>;

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
            <TeamRow key={team.id} team={team} />
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
            <LabelChip key={label.id} label={label} />
          ))}
        </View>
        <Text className="px-1 text-[12px] text-muted-foreground">
          Long-press a label to delete it. Only an admin may; a label the rules refuse is greyed.
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
            <ProjectRow key={project.id} project={project} />
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

/**
 * The rows the three insert rehearsals stage.
 *
 * An insert has no row to name before the form is filled, and a rehearsal of the form's own,
 * empty input would be refused by the schema for the wrong reason — so each rehearsal stages a
 * row that passes the procedure's input and is rolled back like every rehearsal. What the verdict
 * is about is whether this actor may insert into that table in this workspace, which no value on
 * the row changes. `key` and `teamId` are stand-ins, never written.
 */
const PROBE = {
  team: { workspaceId: WORKSPACE_ID, key: "AA", name: "probe", color: PALETTE[0] },
  label: { workspaceId: WORKSPACE_ID, name: "probe", color: PALETTE[0] },
  project: { workspaceId: WORKSPACE_ID, teamId: "probe", name: "probe" },
};

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
