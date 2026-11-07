import { PRIORITY_NAME } from "@syncmesh/issues";
import { Pressable, Text, TextInput, View } from "react-native";

import type { PersonRow } from "./people";

import { Dot, PriorityGlyph, StatusGlyph } from "./glyphs";
import { Avatar } from "./people";
import { PropertyPill, PropertyRow } from "./property-row";

/** A label as the issue screen draws it: a name and a colour. */
interface LabelRow {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

/** Which of the four questions the issue screen's one picker is asking. */
export type Picker = "status" | "priority" | "assignee" | "labels";

/** The header's Edit and Delete. */
export function HeaderActions({
  onDelete,
  onEdit,
}: {
  readonly onDelete: () => void;
  readonly onEdit: () => void;
}) {
  return (
    <View className="flex-row items-center gap-4">
      <Pressable accessibilityLabel="Edit issue" accessibilityRole="button" onPress={onEdit}>
        <Text className="text-[16px] text-accent">Edit</Text>
      </Pressable>
      <Pressable accessibilityLabel="Delete issue" accessibilityRole="button" onPress={onDelete}>
        <Text className="text-[16px] text-danger">Delete</Text>
      </Pressable>
    </View>
  );
}

/** The identifier, and the title — as text, or as a field while editing. */
export function TitleBlock({
  editing,
  identifier,
  onTitle,
  saved,
  title,
}: {
  readonly editing: boolean;
  readonly identifier: string;
  readonly onTitle: (text: string) => void;
  readonly saved: string;
  readonly title: string;
}) {
  return (
    <View className="gap-2">
      <Text className="text-[13px] text-muted-foreground">{identifier}</Text>
      {editing ? (
        <TextInput
          autoFocus
          className="text-[24px] font-semibold text-foreground"
          multiline
          onChangeText={onTitle}
          value={title}
        />
      ) : (
        <Text className="text-[24px] font-semibold leading-[30px] text-foreground">{saved}</Text>
      )}
    </View>
  );
}

/** What the labels pill reads: none, the one, or how many. */
const labelsValue = (labels: readonly LabelRow[]) => {
  if (labels.length === 0) return "Label";
  if (labels.length === 1) return labels[0]?.name ?? "Label";
  return `${String(labels.length)} labels`;
};

/** Every property is the same pill and every one of them writes — see `property-row.tsx`. */
export function Properties({
  assignee,
  labels,
  onAsk,
  priority,
  status,
}: {
  readonly assignee: PersonRow | undefined;
  readonly labels: readonly LabelRow[];
  readonly onAsk: (which: Picker) => void;
  readonly priority: number;
  readonly status: string;
}) {
  return (
    <PropertyRow>
      <PropertyPill
        lead={<StatusGlyph size={14} status={status} />}
        onPress={() => onAsk("status")}
        value={status}
      />
      <PropertyPill
        isSet={priority > 0}
        lead={<PriorityGlyph priority={priority} size={14} />}
        onPress={() => onAsk("priority")}
        value={PRIORITY_NAME[priority] ?? "none"}
      />
      <PropertyPill
        isSet={assignee !== undefined}
        lead={assignee === undefined ? undefined : <Avatar person={assignee} size={16} />}
        onPress={() => onAsk("assignee")}
        value={assignee?.name ?? "Assignee"}
      />
      <PropertyPill
        isSet={labels.length > 0}
        lead={labels[0] === undefined ? undefined : <Dot color={labels[0].color} />}
        onPress={() => onAsk("labels")}
        value={labelsValue(labels)}
      />
    </PropertyRow>
  );
}

/** The description: its text, nothing when empty, or a field with Save and Cancel while editing. */
export function Description({
  description,
  editing,
  onCancel,
  onDescription,
  onSave,
  saved,
}: {
  readonly description: string;
  readonly editing: boolean;
  readonly onCancel: () => void;
  readonly onDescription: (text: string) => void;
  readonly onSave: () => void;
  readonly saved: string;
}) {
  if (!editing)
    return saved === "" ? null : (
      <Text className="text-[15px] leading-[22px] text-foreground">{saved}</Text>
    );
  return (
    <View className="gap-3">
      <TextInput
        className="min-h-24 rounded-xl border border-border p-3 text-[15px] text-foreground"
        multiline
        onChangeText={onDescription}
        placeholder="Add a description…"
        textAlignVertical="top"
        value={description}
      />
      <View className="flex-row gap-2">
        <Pressable
          className="h-10 flex-1 items-center justify-center rounded-xl bg-accent active:opacity-80"
          onPress={onSave}
        >
          <Text className="text-[15px] font-medium text-accent-foreground">Save</Text>
        </Pressable>
        <Pressable
          className="h-10 flex-1 items-center justify-center rounded-xl border border-border active:opacity-60"
          onPress={onCancel}
        >
          <Text className="text-[15px] text-foreground">Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** The comments, oldest first, each under its author. */
export function Thread({
  notes,
  personOf,
}: {
  readonly notes: readonly {
    readonly id: string;
    readonly authorId: string;
    readonly body: string;
  }[];
  readonly personOf: ReadonlyMap<string, PersonRow>;
}) {
  return (
    <View className="gap-3">
      <Text className="text-[13px] font-medium text-muted-foreground">
        {notes.length === 0
          ? "No comments"
          : `${String(notes.length)} comment${notes.length === 1 ? "" : "s"}`}
      </Text>
      {notes.map((note) => {
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
  );
}

/**
 * The comment box, pinned rather than at the end of the scroll, because the reason to open an
 * issue with forty comments is usually to add the forty-first.
 */
export function Composer({
  draft,
  onDraft,
  onSend,
}: {
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onSend: () => void;
}) {
  const empty = draft.trim() === "";
  return (
    <View className="flex-row items-end gap-2 border-t border-border px-4 pb-8 pt-3">
      <TextInput
        className="max-h-28 min-h-11 flex-1 rounded-2xl border border-border px-4 py-2.5 text-[15px] text-foreground"
        multiline
        onChangeText={onDraft}
        placeholder="Comment"
        value={draft}
      />
      <Pressable
        accessibilityLabel="Send comment"
        accessibilityRole="button"
        accessibilityState={{ disabled: empty }}
        className={
          empty
            ? "h-11 w-11 items-center justify-center rounded-full bg-surface-secondary"
            : "h-11 w-11 items-center justify-center rounded-full bg-accent active:opacity-80"
        }
        disabled={empty}
        onPress={onSend}
      >
        <Text
          className={
            empty ? "text-[17px] text-muted-foreground" : "text-[17px] text-accent-foreground"
          }
        >
          ↑
        </Text>
      </Pressable>
    </View>
  );
}
