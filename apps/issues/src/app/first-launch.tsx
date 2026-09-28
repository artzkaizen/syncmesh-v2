import { COLOR, SPACE, TEXT } from "./ui.js";

/**
 * The first launch: this device's copy has answered and it is empty, and no other source has
 * answered yet. Not "no issues" — a workspace this device has not heard about is not an empty
 * one — so the screen says what is happening rather than what is not there.
 */
export function FirstLaunch() {
  return (
    <div
      data-first-launch
      style={{
        color: COLOR.textDim,
        display: "grid",
        gap: SPACE.xs,
        padding: SPACE.xl,
        textAlign: "center",
        ...TEXT.sm,
      }}
    >
      <strong style={{ color: COLOR.text }}>Catching up with the workspace…</strong>
      <span style={{ color: COLOR.textFaint, ...TEXT.xs }}>
        This device holds nothing yet and no other source has answered. The list fills in as they
        do; nothing here needs a reload.
      </span>
    </div>
  );
}
