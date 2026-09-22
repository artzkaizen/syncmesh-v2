import { healthWord } from "./health-word.js";
import { mesh } from "./mesh.js";
import { COLOR, HAIRLINE, RADIUS, SPACE, TEXT } from "./ui.js";

/**
 * The pill: one word about the mesh, drawn only when there is one to say.
 *
 * Over `mesh.useStatus()` and nothing else — the facts are the device's, pushed to this window —
 * and beside the storage and role badges because it answers the same kind of question: not "what
 * is in the workspace" but "is what I am looking at the whole of it yet".
 */
export function HealthPill() {
  const word = healthWord(mesh.useStatus());
  if (word === undefined) return null;
  return (
    <span
      data-health={word}
      style={{
        alignItems: "center",
        border: HAIRLINE,
        borderRadius: RADIUS.pill,
        color: COLOR.textDim,
        display: "inline-flex",
        gap: SPACE.xs,
        padding: `2px ${String(SPACE.sm)}px`,
        ...TEXT.xs,
      }}
    >
      {word}
    </span>
  );
}
