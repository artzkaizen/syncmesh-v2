import { useSyncExternalStore } from "react";

import { dismiss, onToasts, toasts } from "../overrule.js";
import { BUTTON, COLOR, HAIRLINE, RADIUS, SPACE, TEXT } from "./ui.js";

/** The lines the app is saying over the screen, bottom right; each goes by itself or on its ×. */
export function Toasts() {
  const shown = useSyncExternalStore(onToasts, toasts);
  if (shown.length === 0) return null;
  return (
    <div
      role="status"
      style={{
        bottom: SPACE.lg,
        display: "grid",
        gap: SPACE.xs,
        position: "fixed",
        right: SPACE.lg,
      }}
    >
      {shown.map((toast) => (
        <div
          key={toast.id}
          style={{
            alignItems: "center",
            background: COLOR.raised,
            border: HAIRLINE,
            borderRadius: RADIUS.sm,
            color: COLOR.text,
            display: "flex",
            gap: SPACE.sm,
            padding: `${String(SPACE.sm)}px ${String(SPACE.md)}px`,
            ...TEXT.sm,
          }}
        >
          <span>{toast.text}</span>
          <button
            aria-label="Dismiss"
            onClick={() => dismiss(toast.id)}
            style={BUTTON}
            type="button"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
