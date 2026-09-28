import { dismiss, onToasts, toasts, useOverruled } from "@syncmesh/issues";
import { useOperation } from "@syncmesh/react";
import { useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";

import { mesh } from "./device";

/**
 * The lines the app is saying over the screen, bottom of the window; each goes by itself or on a tap.
 *
 * Drawn beside the navigator rather than inside a screen, because the write a toast is about was
 * made on one screen and the sentence should survive leaving it. The store is `@syncmesh/issues`'s
 * own, shared with the web app, so the two say the same thing for the same reason.
 */
export function Toasts() {
  const shown = useSyncExternalStore(onToasts, toasts);
  if (shown.length === 0) return null;
  return (
    <View className="absolute inset-x-4 bottom-10 gap-2" pointerEvents="box-none">
      {shown.map((toast) => (
        <Pressable
          accessibilityRole="button"
          className="rounded-xl bg-accent px-4 py-3 active:opacity-80"
          key={toast.id}
          onPress={() => dismiss(toast.id)}
        >
          <Text className="text-[14px] text-accent-foreground">{toast.text}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Follows one write's durable record and says so the moment the office overrules it. Draws nothing.
 *
 * The id is handed over when the write is made, before the commit resolves, so this follows the
 * operation through its whole life rather than picking it up once it has settled — which is what
 * a durable operation record is for.
 */
export function Overruled({ id }: { readonly id: string | undefined }) {
  // the ledger is optional on the contract — a mesh over a bare event store has none — and this
  // app always builds one; an absent ledger is simply nothing to follow
  const ledger = mesh.api.$operations;
  useOverruled(useOperation(id === undefined || ledger === undefined ? undefined : ledger.get(id)));
  return null;
}
