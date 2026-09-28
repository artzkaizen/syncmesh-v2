import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";

import { COLOR, FONT, HAIRLINE, SPACE, TEXT } from "./ui.js";

/**
 * The frame the two screens that are not the list share: a title, a way back, and prose width.
 *
 * **Not the `_shell` layout, and the difference is what these screens are for.** `_shell` is the
 * board — a header of live totals, a sidebar of filters and a list that must not unmount when
 * somebody opens a row — and drawing the roster or the settings inside it would put a second
 * navigation beside a set of filters that do not apply to either. So they are siblings of that
 * layout rather than children of it, they own the whole window, and this is the one piece of
 * chrome they have in common.
 *
 * The way back is a `<Link to="/">` and not `history.back()`. A settings screen reached by typing
 * its address has nothing behind it, and a back button that does nothing on the one occasion
 * somebody actually needed it is worse than no back button — where this goes is stated rather than
 * inferred from a stack this app did not fill.
 */
export function Page({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      style={{
        background: COLOR.surface,
        color: COLOR.text,
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT.sans,
        height: "100vh",
        ...TEXT.md,
      }}
    >
      <header
        style={{
          alignItems: "center",
          borderBottom: HAIRLINE,
          display: "flex",
          flex: "none",
          gap: SPACE.md,
          padding: `${String(SPACE.md)}px ${String(SPACE.lg)}px`,
        }}
      >
        <Link style={{ ...TEXT.sm, color: COLOR.textDim, textDecoration: "none" }} to="/">
          ← Issues
        </Link>
        <span style={{ ...TEXT.md, color: COLOR.text, fontWeight: 500 }}>{title}</span>
      </header>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ margin: "0 auto", maxWidth: 680, padding: SPACE.lg }}>{children}</div>
      </div>
    </div>
  );
}
