import type {
  label as labelTable,
  project as projectTable,
  team as teamTable,
} from "@syncmesh/issues";
import type { Write } from "@syncmesh/orpc";

import { WORKSPACE_ID } from "@syncmesh/issues";
import { useCan } from "@syncmesh/react";
import { ListGroup } from "heroui-native";
import { Alert, Pressable, Text, View } from "react-native";

import { useApi } from "./device";
import { Dot } from "./glyphs";

/**
 * The rows of the workspace screen — one team, one label, one project — each with the one
 * destructive button that is its own, gated by rehearsing that very write with the row's id
 * (`api.teams.archive.can({ id })`, book ch. 15). A stand-in id would not do: a rehearsal that
 * stages no change has nothing to refuse and answers "allowed", so the verdict has to be about
 * the row on screen.
 */

/**
 * A write, with whatever the engine said about it put on screen.
 *
 * Refusals are the interesting outcome here — sign in as a guest, press something the UI failed
 * to grey out, and this is what shows the rule doing its job. Swallowing them would make the
 * permission model invisible at exactly the moment it is working.
 */
export const attempt = (what: string, run: () => Write<unknown>, done?: () => void): void => {
  // `committed` resolves to a `Result` and never rejects — a refusal is a value here, not a
  // throw, which is exactly why this reads the arm rather than wrapping the call in a `catch`
  void run().committed.then((landed) => {
    if (landed.isErr()) {
      Alert.alert(`${what} was refused`, landed.error.message);
      return;
    }
    done?.();
  });
};

/** One team, with an archive that is greyed unless this actor may make that very write. */
export const TeamRow = ({ team }: { readonly team: typeof teamTable.$inferSelect }) => {
  const api = useApi();
  const mayArchive = useCan(api.teams.archive.can({ workspaceId: WORKSPACE_ID, id: team.id }));
  return (
    <ListGroup.Item>
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
          disabled={!mayArchive}
          onPress={() =>
            attempt("Archiving the team", () =>
              api.teams.archive({ workspaceId: WORKSPACE_ID, id: team.id }),
            )
          }
        >
          <Text
            className={
              mayArchive
                ? "text-[13px] text-danger"
                : "text-[13px] text-muted-foreground opacity-40"
            }
          >
            Archive
          </Text>
        </Pressable>
      </ListGroup.ItemSuffix>
    </ListGroup.Item>
  );
};

/** One label; a long press deletes it, and the chip is greyed when the rules would refuse. */
export const LabelChip = ({ label }: { readonly label: typeof labelTable.$inferSelect }) => {
  const api = useApi();
  const mayRemove = useCan(api.labels.remove.can({ workspaceId: WORKSPACE_ID, id: label.id }));
  return (
    <Pressable
      className={mayRemove ? undefined : "opacity-40"}
      disabled={!mayRemove}
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
  );
};

/** One project, with a delete that is confirmed first and greyed unless this actor may make it. */
export const ProjectRow = ({ project }: { readonly project: typeof projectTable.$inferSelect }) => {
  const api = useApi();
  const mayRemove = useCan(api.projects.remove.can({ workspaceId: WORKSPACE_ID, id: project.id }));
  return (
    <ListGroup.Item>
      <ListGroup.ItemContent>
        <ListGroup.ItemTitle>{project.name}</ListGroup.ItemTitle>
        <ListGroup.ItemDescription>{project.status}</ListGroup.ItemDescription>
      </ListGroup.ItemContent>
      <ListGroup.ItemSuffix>
        <Pressable
          className="h-9 justify-center px-1"
          disabled={!mayRemove}
          onPress={() =>
            Alert.alert("Delete project", `"${project.name}" goes from every device that has it.`, [
              { style: "cancel", text: "Cancel" },
              {
                onPress: () =>
                  attempt("Deleting the project", () =>
                    api.projects.remove({ workspaceId: WORKSPACE_ID, id: project.id }),
                  ),
                style: "destructive",
                text: "Delete",
              },
            ])
          }
        >
          <Text
            className={
              mayRemove ? "text-[13px] text-danger" : "text-[13px] text-muted-foreground opacity-40"
            }
          >
            Delete
          </Text>
        </Pressable>
      </ListGroup.ItemSuffix>
    </ListGroup.Item>
  );
};
