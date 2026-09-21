import type { Write } from "@syncmesh/orpc";

import { PRIORITY_NAME, WORKSPACE_ID } from "@syncmesh/issues";
import { useLiveQuery } from "@syncmesh/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Spinner } from "heroui-native";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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

import { useAfterTransition } from "../../src/after-transition";
import { PRIORITY_CHOICES, STATUS_CHOICES, labelChoices, peopleChoices } from "../../src/choices";
import { useActor, useApi, useDevice } from "../../src/device";
import { Dot, PriorityGlyph, StatusGlyph } from "../../src/glyphs";
import { sawCommit, sawRender } from "../../src/nav-timing";
import { Avatar } from "../../src/people";
import { PickerSheet } from "../../src/picker-sheet";
import { PropertyPill, PropertyRow } from "../../src/property-row";
import { SyncNote } from "../../src/sync-note";

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

/** Which sheet is open, as one value — two booleans would let two sheets open at once. */
/** Which of the four questions a picker is asking. */
type Picker = "status" | "priority" | "assignee" | "labels";

/**
 * The one sheet's state: which question, and whether it is being asked.
 *
 * `which` outlives `open` on purpose. A choice closes the sheet, and the sheet then animates out
 * over the frames that follow; content read off a "nothing is open" state would blank — or, worse,
 * swap to another picker's rows — halfway down. Keeping the two facts apart is what lets the sheet
 * go on showing the question it was asked while it leaves.
 */
interface Asked {
  readonly which: Picker;
  readonly open: boolean;
}

function Detail({ id }: { readonly id: string }) {
  const device = useDevice();
  const actor = useActor();
  const api = useApi();
  const router = useRouter();
  const found = useLiveQuery(api.issues.get({ workspaceId: WORKSPACE_ID, id }));
  const row = found.data[0];

  const people = useLiveQuery(api.members.list({ workspaceId: WORKSPACE_ID }));
  const labels = useLiveQuery(api.labels.list({ workspaceId: WORKSPACE_ID }));
  const teams = useLiveQuery(api.teams.list({ workspaceId: WORKSPACE_ID }));
  const attached = useLiveQuery(api.issues.labelsOf({ workspaceId: WORKSPACE_ID, issueId: id }));
  const thread = useLiveQuery(api.comments.forIssue({ workspaceId: WORKSPACE_ID, issueId: id }));

  // a layout effect rather than an effect: this must run in the commit phase, which is the stage
  // being measured — `useEffect` fires after paint and would fold the two spans into one
  useLayoutEffect(sawCommit, []);

  /** The write this screen is waiting to see, so the redraw that shows it can be timed. */
  const pending = useRef<{ readonly what: string; readonly asked: number }>(undefined);

  const [sheet, setSheet] = useState<Asked>({ open: false, which: "status" });
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

  // memoised because `PickerSheet` is `memo`'d and a fresh array every render defeats that
  // outright — see `src/choices.tsx` for what four reconciled sheets cost a write
  const whoChoices = useMemo(() => peopleChoices(people.data), [people.data]);
  const whichLabels = useMemo(() => labelChoices(labels.data), [labels.data]);
  const ask = useCallback((which: Picker) => setSheet({ open: true, which }), []);
  const answered = useCallback(
    (open: boolean) => (open ? undefined : setSheet((was) => ({ ...was, open: false }))),
    [],
  );

  /**
   * A write, with a refusal put on screen rather than swallowed.
   *
   * `committed` resolves to a `Result` and never rejects, so a refusal is a value to read and not
   * a throw to catch. Surfacing it is what makes the role model visible: sign in as a guest, press
   * something, and the rule says so in its own words.
   */
  /**
   * A write, timed, with a refusal put on screen rather than swallowed.
   *
   * `committed` resolves to a `Result` and never rejects, so a refusal is a value to read and not a
   * throw to catch. Surfacing it is what makes the role model visible: sign in as a guest, press
   * something, and the rule says so in its own words.
   *
   * The timing splits "the write was slow" from "the screen was slow to show it", which feel
   * identical and have nothing to do with each other: `commit` is the engine appending and folding
   * locally, `visible` is the live query re-running and React drawing the result.
   */
  const attempt = useCallback((what: string, run: () => Write<unknown>) => {
    const asked = Date.now();
    pending.current = { what, asked };
    void run().committed.then((landed) => {
      if (landed.isErr()) {
        pending.current = undefined;
        Alert.alert(`${what} was refused`, landed.error.message);
        return;
      }
      // eslint-disable-next-line no-console -- the number is the point, and a log outlives a screen
      console.log(`[write] ${what} · commit ${String(Date.now() - asked)}ms`);
    });
  }, []);

  const account = actor.account;
  const pickStatus = useCallback(
    (status: string) =>
      attempt("The status change", () =>
        // SAFETY: every key came from `STATUS_CHOICES`, which is the procedure's own enum
        api.issues.setStatus({
          workspaceId: WORKSPACE_ID,
          id,
          actorId: account,
          status: status as never,
        }),
      ),
    [api, attempt, id, account],
  );
  const pickPriority = useCallback(
    (level: string) =>
      attempt("The priority change", () =>
        api.issues.edit({
          workspaceId: WORKSPACE_ID,
          id,
          actorId: account,
          priority: Number(level),
        }),
      ),
    [api, attempt, id, account],
  );
  const pickAssignee = useCallback(
    (who: string) =>
      attempt("The assignment", () =>
        api.issues.assign({
          workspaceId: WORKSPACE_ID,
          id,
          actorId: account,
          // the empty key is "nobody", which the procedure takes as an explicit null
          assigneeId: who === "" ? null : who,
        }),
      ),
    [api, attempt, id, account],
  );
  const pickLabel = useCallback(
    (labelId: string) => {
      const on = attachedIds.has(labelId);
      attempt(on ? "Removing the label" : "Adding the label", () =>
        (on ? api.issueLabels.detach : api.issueLabels.attach)({
          workspaceId: WORKSPACE_ID,
          issueId: id,
          labelId,
          actorId: account,
        }),
      );
    },
    [api, attempt, attachedIds, id, account],
  );

  /**
   * What the one sheet is currently asking — the whole of the difference from four of them.
   *
   * There was a `PickerSheet` per property, all four mounted, to show one at a time. Each is a
   * full-window overlay with its own gesture detector and animation state, so the screen paid four
   * native mounts on arrival and reconciled four subtrees on every write: measured, ~290ms of
   * nothing drawing when the push animation ended, and ~960ms after an assignment landed. One
   * sheet asking whichever question was pressed is the same interaction and a quarter of the tree.
   *
   * Memoised because `PickerSheet` is `memo`'d: a fresh props object every render would defeat
   * that as surely as the fresh arrays in `src/choices.tsx` did — and this screen re-renders on
   * every keystroke in the description field.
   */
  const asking = useMemo(() => {
    const pick = {
      assignee: {
        choices: whoChoices,
        onPick: pickAssignee,
        selected: row?.assigneeId ?? "",
        title: "Assignee",
      },
      labels: {
        choices: whichLabels,
        multiple: true,
        onPick: pickLabel,
        selected: attachedIds,
        title: "Labels",
      },
      priority: {
        choices: PRIORITY_CHOICES,
        onPick: pickPriority,
        selected: row === undefined ? undefined : String(row.priority),
        title: "Priority",
      },
      status: {
        choices: STATUS_CHOICES,
        onPick: pickStatus,
        selected: row?.status,
        title: "Status",
      },
    };
    return pick[sheet.which];
  }, [
    attachedIds,
    pickAssignee,
    pickLabel,
    pickPriority,
    pickStatus,
    row,
    sheet.which,
    whichLabels,
    whoChoices,
  ]);

  if (!found.hasAnswered) return <Centred>Reading the local replica…</Centred>;
  if (row === undefined)
    return <Absent deleted={device.deleted("issue", id)} settled={found.isSettled} />;

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
      api.comments.post({ workspaceId: WORKSPACE_ID, issueId: id, authorId: actor.account, body }),
    );
  };

  const saveEdits = () => {
    setEditing(false);
    attempt("The edit", () =>
      api.issues.edit({
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
          attempt("The delete", () => api.issues.remove({ workspaceId: WORKSPACE_ID, id }));
        },
        style: "destructive",
        text: "Delete",
      },
    ]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1"
      // the composer is pinned to the bottom, so the keyboard must lift it rather than cover it
      keyboardVerticalOffset={Platform.OS === "ios" ? 96 : 0}
    >
      <Stack.Screen
        options={{
          headerRight: () => (
            <View className="flex-row items-center gap-4">
              <Pressable
                accessibilityLabel="Edit issue"
                accessibilityRole="button"
                onPress={() => {
                  setTitle(row.title);
                  setDescription(row.description);
                  setEditing(true);
                }}
              >
                <Text className="text-[16px] text-accent">Edit</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Delete issue"
                accessibilityRole="button"
                onPress={confirmDelete}
              >
                <Text className="text-[16px] text-danger">Delete</Text>
              </Pressable>
            </View>
          ),
          title: identifier,
        }}
      />

      <ScrollView className="flex-1" contentContainerStyle={{ gap: 20, padding: 16 }}>
        <View className="gap-2">
          <Text className="text-[13px] text-muted-foreground">{identifier}</Text>
          {editing ? (
            <TextInput
              autoFocus
              className="text-[24px] font-semibold text-foreground"
              multiline
              onChangeText={setTitle}
              value={title}
            />
          ) : (
            <Text className="text-[24px] font-semibold leading-[30px] text-foreground">
              {row.title}
            </Text>
          )}
        </View>

        {/* every property is the same pill and every one of them writes — see `property-row.tsx` */}
        <PropertyRow>
          <PropertyPill
            lead={<StatusGlyph size={14} status={row.status} />}
            onPress={() => ask("status")}
            value={row.status}
          />
          <PropertyPill
            isSet={row.priority > 0}
            lead={<PriorityGlyph priority={row.priority} size={14} />}
            onPress={() => ask("priority")}
            value={PRIORITY_NAME[row.priority] ?? "none"}
          />
          <PropertyPill
            isSet={assignee !== undefined}
            lead={assignee === undefined ? undefined : <Avatar person={assignee} size={16} />}
            onPress={() => ask("assignee")}
            value={assignee?.name ?? "Assignee"}
          />
          <PropertyPill
            isSet={attachedLabels.length > 0}
            lead={
              attachedLabels[0] === undefined ? undefined : <Dot color={attachedLabels[0].color} />
            }
            onPress={() => ask("labels")}
            value={
              attachedLabels.length === 0
                ? "Label"
                : attachedLabels.length === 1
                  ? (attachedLabels[0]?.name ?? "Label")
                  : `${String(attachedLabels.length)} labels`
            }
          />
        </PropertyRow>

        {editing ? (
          <View className="gap-3">
            <TextInput
              className="min-h-24 rounded-xl border border-border p-3 text-[15px] text-foreground"
              multiline
              onChangeText={setDescription}
              placeholder="Add a description…"
              textAlignVertical="top"
              value={description}
            />
            <View className="flex-row gap-2">
              <Pressable
                className="h-10 flex-1 items-center justify-center rounded-xl bg-accent active:opacity-80"
                onPress={saveEdits}
              >
                <Text className="text-[15px] font-medium text-accent-foreground">Save</Text>
              </Pressable>
              <Pressable
                className="h-10 flex-1 items-center justify-center rounded-xl border border-border active:opacity-60"
                onPress={() => setEditing(false)}
              >
                <Text className="text-[15px] text-foreground">Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : row.description === "" ? null : (
          <Text className="text-[15px] leading-[22px] text-foreground">{row.description}</Text>
        )}

        <SyncNote sync={row.sync} />

        <View className="gap-3">
          <Text className="text-[13px] font-medium text-muted-foreground">
            {thread.data.length === 0
              ? "No comments"
              : `${String(thread.data.length)} comment${thread.data.length === 1 ? "" : "s"}`}
          </Text>
          {thread.data.map((note) => {
            const author = personOf.get(note.authorId);
            return (
              <View className="flex-row gap-3" key={note.id}>
                {author === undefined ? (
                  <View className="h-7 w-7 rounded-full bg-surface-secondary" />
                ) : (
                  <Avatar person={author} size={28} />
                )}
                <View className="flex-1 gap-1">
                  <Text className="text-[13px] font-medium text-foreground">
                    {author?.name ?? note.authorId}
                  </Text>
                  <Text className="text-[15px] leading-[21px] text-foreground">{note.body}</Text>
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>

      {/* pinned rather than at the end of the scroll, because the reason to open an issue with
          forty comments is usually to add the forty-first */}
      <View className="flex-row items-end gap-2 border-t border-border px-4 pb-8 pt-3">
        <TextInput
          className="max-h-28 min-h-11 flex-1 rounded-2xl border border-border px-4 py-2.5 text-[15px] text-foreground"
          multiline
          onChangeText={setDraft}
          placeholder="Comment"
          value={draft}
        />
        <Pressable
          accessibilityLabel="Send comment"
          accessibilityRole="button"
          accessibilityState={{ disabled: draft.trim() === "" }}
          className={
            draft.trim() === ""
              ? "h-11 w-11 items-center justify-center rounded-full bg-surface-secondary"
              : "h-11 w-11 items-center justify-center rounded-full bg-accent active:opacity-80"
          }
          disabled={draft.trim() === ""}
          onPress={post}
        >
          <Text
            className={
              draft.trim() === ""
                ? "text-[17px] text-muted-foreground"
                : "text-[17px] text-accent-foreground"
            }
          >
            ↑
          </Text>
        </Pressable>
      </View>

      <PickerSheet {...asking} isOpen={sheet.open} onOpenChange={answered} warm={warm} />
    </KeyboardAvoidingView>
  );
}

/**
 * Absent is three different facts, and only one of them is "deleted".
 *
 * **The screen used to render two of the three.** A row deleted on another phone is taken out of
 * this one's tables outright — the fold hard-deletes it — so `issues.get` answers *deleted* and
 * *never heard of* with the same empty result, and this screen said "not on this device" about an
 * issue it had watched a peer delete. The record that remembers the delete is the engine's, kept
 * because a concurrent edit has to be able to beat it, and `Replica.deleted` is the door onto it.
 *
 * `deleted` is read first because it is the only one of the three that is positive knowledge. The
 * other two are readings of an absence; this one is a fact the replica holds, so a device that is
 * still catching up already knows it — and no amount of catching up produces a row a peer deleted.
 *
 * `settled` separates the remaining two: until every source has answered, an issue this device has
 * not heard of yet is *not here yet* rather than gone, and saying "not on this device" about a row
 * a laptop is holding would be as wrong as the opposite (book ch. 9).
 *
 * What none of them says is **who**. The tombstone names the device that wrote the delete, and a
 * device is not an account; "deleted by Bo" is a join against the activity feed, not this.
 */
const Absent = ({ deleted, settled }: { readonly deleted: boolean; readonly settled: boolean }) => {
  if (deleted) return <Centred busy={false}>That issue was deleted.</Centred>;
  if (settled) return <Centred busy={false}>That issue is not on this device.</Centred>;
  return <Centred>Catching up…</Centred>;
};

/**
 * One sentence in the middle of the screen, with a spinner only where something is still running.
 *
 * `busy` is not decoration. "That issue was deleted." is a final answer, and a spinner under it
 * says the opposite — that this device is still working and the sentence may yet change.
 */
const Centred = ({
  busy = true,
  children,
}: {
  readonly busy?: boolean;
  readonly children: React.ReactNode;
}) => (
  <View className="flex-1 items-center justify-center gap-3 p-8">
    {busy ? <Spinner size="sm" /> : null}
    <Text className="text-center text-[15px] text-muted-foreground">{children}</Text>
  </View>
);
