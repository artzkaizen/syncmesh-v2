import { WORKSPACE_ID } from "@syncmesh/issues";
import { useLiveQuery } from "@syncmesh/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useLayoutEffect, useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView } from "react-native";

import { useAfterTransition } from "../../src/after-transition";
import { mesh, useActor, useDevice } from "../../src/device";
import { Absent } from "../../src/issue-absent";
import {
  Composer,
  Description,
  HeaderActions,
  Properties,
  Thread,
  TitleBlock,
} from "../../src/issue-parts";
import { useIssuePicker } from "../../src/issue-picker";
import { useIssueWrites } from "../../src/issue-writes";
import { sawCommit, sawRender } from "../../src/nav-timing";
import { PickerSheet } from "../../src/picker-sheet";
import { SyncNote } from "../../src/sync-note";
import { Overruled } from "../../src/toasts";

/**
 * One issue, and every control that writes to it.
 *
 * Every control here is a **statement**: touching it commits locally and returns, and the screen
 * redraws because the live query underneath re-runs — not because the control awaited anything.
 * That is the whole difference a local-first app is judged on, and it is most obvious with the
 * network off: the status moves the instant it is pressed, on a phone that may not see another
 * device for hours.
 *
 * **This screen used to be read-only in all but one field.** Status could be set; priority was a
 * chip that did nothing; assignee, labels, title, description, comments and delete had no control
 * at all, which made a tracker into a viewer. The procedures for all of them already existed.
 */
export default function IssueScreen() {
  // before any hook that could block: this is the instant the transition stopped waiting on JS
  sawRender();
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Detail id={id} />;
}

function Detail({ id }: { readonly id: string }) {
  const device = useDevice();
  const actor = useActor();
  const router = useRouter();
  const found = useLiveQuery(mesh.api.issues.get({ workspaceId: WORKSPACE_ID, id }));
  const row = found.data[0];

  const people = useLiveQuery(mesh.api.members.list({ workspaceId: WORKSPACE_ID }));
  const labels = useLiveQuery(mesh.api.labels.list({ workspaceId: WORKSPACE_ID }));
  const teams = useLiveQuery(mesh.api.teams.list({ workspaceId: WORKSPACE_ID }));
  const attached = useLiveQuery(
    mesh.api.issues.labelsOf({ workspaceId: WORKSPACE_ID, issueId: id }),
  );
  const thread = useLiveQuery(
    mesh.api.comments.forIssue({ workspaceId: WORKSPACE_ID, issueId: id }),
  );

  // a layout effect rather than an effect: this must run in the commit phase, which is the stage
  // being measured — `useEffect` fires after paint and would fold the two spans into one
  useLayoutEffect(sawCommit, []);

  /**
   * Whether the picker may mount yet — false until this screen's push animation is over.
   *
   * A bottom sheet is a full-window native overlay with its own gesture detector, and mounting one
   * is not free: with four of them here the screen cost **557ms of native mount**, measured with
   * and without — `commit→paint` 661ms against 104ms, the push transition held off until 731ms
   * against 132ms — and none of it was JavaScript, because the thread went idle 8ms after the
   * commit and then nothing drew. There is one sheet now, which is a quarter of that, and it is
   * still worth not paying on the tap: the screen arrives in ~130ms, the sheet arrives while the
   * person is still reading it, and a pill pressed before then still opens, because `PickerSheet`
   * stages its own mount for exactly that case.
   */
  const warm = useAfterTransition();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const personOf = useMemo(
    () => new Map(people.data.map((person) => [person.id, person])),
    [people.data],
  );
  const attachedIds = useMemo(
    () => new Set(attached.data.map((join) => join.labelId)),
    [attached.data],
  );
  /**
   * The labels on this issue, as labels.
   *
   * `issues.labelsOf` returns the *join* rows — `issueId`, `labelId`, who attached it — and not the
   * label's name or colour, which live on the label table this screen already has loaded. Joining
   * here rather than adding a procedure keeps the read a plain index lookup on a catalog of ten.
   */
  const attachedLabels = useMemo(
    () => labels.data.filter((label) => attachedIds.has(label.id)),
    [attachedIds, labels.data],
  );

  const { attempt, lastWrite, pending, ...picks } = useIssueWrites({
    account: actor.account,
    attachedIds,
    id,
  });
  const { answered, ask, asking, sheet } = useIssuePicker({
    attachedIds,
    labels: labels.data,
    people: people.data,
    picks,
    row,
  });

  // if (found.answered === "none") return <Centred>Reading the local replica…</Centred>;
  if (row === undefined)
    return <Absent deleted={device.deleted("issue", id)} settled={found.answered === "settled"} />;

  if (pending.current !== undefined) {
    const { asked, what } = pending.current;
    pending.current = undefined;
    // eslint-disable-next-line no-console -- the number is the point, and a log outlives a screen
    console.log(`[write] ${what} · VISIBLE ${String(Date.now() - asked)}ms`);
  }

  const teamKey = teams.data.find((team) => team.id === row.teamId)?.key ?? "???";
  const assignee = row.assigneeId === null ? undefined : personOf.get(row.assigneeId);
  const identifier = `${teamKey}-${row.number === null ? "•" : String(row.number)}`;

  const post = () => {
    const body = draft.trim();
    if (body === "") return;
    // cleared first: the write is local and synchronous enough that waiting to clear the box shows
    // a visible flash of the text you already sent
    setDraft("");
    attempt("The comment", () =>
      mesh.api.comments.post({
        workspaceId: WORKSPACE_ID,
        issueId: id,
        authorId: actor.account,
        body,
      }),
    );
  };

  const saveEdits = () => {
    setEditing(false);
    attempt("The edit", () =>
      mesh.api.issues.edit({
        workspaceId: WORKSPACE_ID,
        id,
        actorId: actor.account,
        title: title.trim() === "" ? undefined : title.trim(),
        description,
      }),
    );
  };

  const confirmDelete = () =>
    Alert.alert("Delete issue", `${identifier} goes from every device that has it.`, [
      { style: "cancel", text: "Cancel" },
      {
        onPress: () => {
          // the screen leaves first: this row is what it is drawing, and deleting underneath it
          // would put "that issue is not on this device" on screen as the last thing you saw
          router.back();
          attempt("The delete", () => mesh.api.issues.remove({ workspaceId: WORKSPACE_ID, id }));
        },
        style: "destructive",
        text: "Delete",
      },
    ]);

  const startEditing = () => {
    setTitle(row.title);
    setDescription(row.description);
    setEditing(true);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1"
      // the composer is pinned to the bottom, so the keyboard must lift it rather than cover it
      keyboardVerticalOffset={Platform.OS === "ios" ? 96 : 0}
    >
      <Stack.Screen
        options={{
          headerRight: () => <HeaderActions onDelete={confirmDelete} onEdit={startEditing} />,
          title: identifier,
        }}
      />

      <Overruled id={lastWrite} />
      <ScrollView className="flex-1" contentContainerStyle={{ gap: 20, padding: 16 }}>
        <TitleBlock
          editing={editing}
          identifier={identifier}
          onTitle={setTitle}
          saved={row.title}
          title={title}
        />
        <Properties
          assignee={assignee}
          labels={attachedLabels}
          onAsk={ask}
          priority={row.priority}
          status={row.status}
        />
        <Description
          description={description}
          editing={editing}
          onCancel={() => setEditing(false)}
          onDescription={setDescription}
          onSave={saveEdits}
          saved={row.description}
        />
        <SyncNote sync={row.sync} />
        <Thread notes={thread.data} personOf={personOf} />
      </ScrollView>

      <Composer draft={draft} onDraft={setDraft} onSend={post} />

      <PickerSheet {...asking} isOpen={sheet.open} onOpenChange={answered} warm={warm} />
    </KeyboardAvoidingView>
  );
}
