import { healthWord } from "@syncmesh/issues";
import { Text, View } from "react-native";

import { mesh } from "./device";

/**
 * One word in the header about the mesh, or nothing.
 *
 * Nothing is the ordinary case: a device at `local-ready` has its rows and needs no sentence
 * about them. The word appears only while the mesh is still carrying, retrying a dial, or has
 * no medium left to try — the three states a person can act on, and the same three the web
 * app's pill says, from the same `healthWord`.
 */
export function HealthPill() {
  const word = healthWord(mesh.useStatus());
  if (word === undefined) return null;
  return (
    <View
      accessibilityRole="text"
      className="rounded-full border border-border bg-surface-secondary px-2.5 py-1"
    >
      <Text className="text-[12px] text-muted-foreground">{word}</Text>
    </View>
  );
}
