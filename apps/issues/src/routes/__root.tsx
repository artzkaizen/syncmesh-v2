import { Link, Outlet, createRootRoute } from "@tanstack/react-router";

import { BUTTON, COLOR, FONT, SPACE, TEXT } from "../app/ui.js";

/**
 * The root of the tree, and deliberately almost empty.
 *
 * There is no document to render here — this app is mounted into an `index.html` that already
 * carries its reset and its `#root`, and the replica is opened and held above the router in
 * `app/main.tsx`. What the root owns is the one thing no child route can: the answer for a URL
 * that names nothing at all.
 */
export const Route = createRootRoute({ component: Outlet, notFoundComponent: NoSuchPage });

/**
 * A URL this app has no view for, said plainly.
 *
 * Deliberately not a redirect to `/`. An address that quietly becomes a different address teaches
 * a reader that the one they had was right, and the next person they send it to sees the same
 * silence — the same objection the header's storage badge is built on. An issue that is merely
 * *absent from this device* is a different sentence and is said by the detail panel, which knows
 * the difference between "not here yet" and "not here".
 */
function NoSuchPage() {
  return (
    <div
      style={{
        alignItems: "center",
        background: COLOR.surface,
        color: COLOR.textDim,
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT.sans,
        gap: SPACE.md,
        height: "100vh",
        justifyContent: "center",
        ...TEXT.sm,
      }}
    >
      <span>This workspace has no page at that address.</span>
      <Link style={{ ...BUTTON, color: COLOR.text, textDecoration: "none" }} to="/">
        Back to the issues
      </Link>
    </div>
  );
}
