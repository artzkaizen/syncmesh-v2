import { Text, View } from "react-native";

/**
 * Where this row's own write has got to — the sentence, not a spinner.
 *
 * Three states and they are genuinely different claims. `local` means it is in this phone's log
 * and nobody has acknowledged it: nothing is lost, and nothing is shared. `delivered` means a peer
 * has it in durable custody — which is *not* acceptance, and the difference matters, because a
 * carrier holds a write it has no opinion about. `remote` means it came from somebody else, so
 * there is no journey of ours to report.
 *
 * A `null` is the honest fourth case: this read did not ask for the column, so the panel says
 * nothing rather than guessing.
 */
export function SyncNote({ sync }: { readonly sync: string | null }) {
  if (sync === null || sync === "remote") return null;
  const note =
    sync === "local"
      ? "In this device's log. No peer has acknowledged it yet — nothing is lost; nothing is shared."
      : "A peer holds a copy. Custody, not agreement: it has no opinion about what it carries.";
  return (
    <View className="rounded-lg bg-surface-secondary px-3 py-2">
      <Text className="text-xs text-muted-foreground">{note}</Text>
    </View>
  );
}
