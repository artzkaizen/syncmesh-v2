import { useEffect, useState } from "react";

import type { Actor, Role } from "../actor.js";

import { ROLES, ROLE_EXPLAINS } from "../actor.js";
import { Avatar } from "./atoms.js";
import { useActing, useCatalog } from "./context.js";
import { enterAs } from "./install.js";
import {
  BUTTON,
  CAPTION,
  COLOR,
  FONT,
  HAIRLINE,
  RADIUS,
  SEVERITY_COLOR,
  SPACE,
  TEXT,
} from "./ui.js";

/**
 * Who to go in as — the screen a fresh install opens on, and the one "switch user" comes back to.
 *
 * **This is a demo affordance and it says so out loud.** Every build of this app carries the
 * issuer's private key, so it can mint itself a grant for anybody in the workspace at any rung;
 * `../actor.ts` documents what a real deployment does instead. What that shortcut buys is the thing
 * this screen exists for: watching the *same workspace* from twelve people's seats and four rungs
 * of the ladder, without twelve installs and without a server to ask.
 *
 * Choosing touches no row of state, no event in the log and not the device key. It mints a grant
 * and registers it; the registry keeps whichever grant per device has the newest `issuedAt`, so
 * the change is one object superseding another. Nothing resyncs, no engine restarts, and the tab
 * that is not showing this screen keeps the list it was already drawing until the new name arrives.
 *
 * It is a component and not a route, because it is drawn in two places that have nothing in
 * common: `workspace.tsx` renders it *instead of* the router on an install nobody has answered
 * for, and `routes/identity.tsx` renders it as a page somebody navigated to. So there is no
 * router in this file, and `onEntered` is how the second of those finds out.
 */

/** The tick beside a chosen person: a filled disc, because two adjacent greys are not a signal. */
const Tick = ({ picked }: { readonly picked: boolean }) => (
  <span
    style={{
      alignItems: "center",
      background: picked ? COLOR.text : "transparent",
      border: picked ? "none" : `1px solid ${COLOR.hairlineStrong}`,
      borderRadius: RADIUS.pill,
      color: COLOR.surface,
      display: "inline-flex",
      flex: "none",
      height: 18,
      justifyContent: "center",
      width: 18,
      ...TEXT.xs,
    }}
  >
    {picked ? "✓" : ""}
  </span>
);

export function Picker({
  onEntered,
}: {
  /**
   * The install is now who this screen asked it to be — for a caller that has somewhere to go.
   *
   * Called after the *origin* has confirmed it rather than when the button was pressed, which is
   * the difference between navigating to a list drawn as Bo and navigating to one still drawn as
   * Ada. On a first launch there is no caller: the picker is replaced by the app the moment
   * `chosen` turns true, which is the same fact arriving through the same channel.
   */
  readonly onEntered?: () => void;
}) {
  const acting = useActing();
  const catalog = useCatalog();

  /**
   * The selection, held here and not written until the button is pressed.
   *
   * A picker that signed in on every click would make "reading who exists" indistinguishable from
   * "becoming them", and on a list of twelve that is a lot of grants minted by a wandering mouse.
   * It starts from whoever this install currently is, so the screen opens on the current answer
   * rather than on a blank one.
   */
  const [account, setAccount] = useState(acting.actor.account);
  const [role, setRole] = useState<Role>(acting.actor.role);
  /** What this screen asked for, so it can tell the origin agreeing from the origin not answering. */
  const [asked, setAsked] = useState<Actor>();

  const arrived =
    asked !== undefined &&
    acting.actor.account === asked.account &&
    acting.actor.role === asked.role;

  useEffect(() => {
    if (arrived) onEntered?.();
  }, [arrived, onEntered]);

  const enter = () => {
    const wanted = { account, role } satisfies Actor;
    setAsked(wanted);
    enterAs(wanted);
  };

  const chosen = catalog.member.get(account);

  return (
    <div
      style={{
        alignItems: "center",
        background: COLOR.surface,
        color: COLOR.text,
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT.sans,
        height: "100vh",
        justifyContent: "center",
        padding: SPACE.xl,
        ...TEXT.md,
      }}
    >
      <div
        style={{
          border: HAIRLINE,
          borderRadius: RADIUS.md,
          display: "flex",
          flexDirection: "column",
          maxHeight: "min(680px, 90vh)",
          overflow: "hidden",
          width: "min(520px, 100%)",
        }}
      >
        <header style={{ borderBottom: HAIRLINE, display: "grid", gap: 2, padding: SPACE.lg }}>
          <span style={{ ...TEXT.md, fontWeight: 500 }}>Go in as</span>
          <span style={{ ...TEXT.sm, color: COLOR.textDim }}>
            Everything you file, comment on and react to is attributed to this person, and the role
            decides what the workspace lets you do.
          </span>
        </header>

        {catalog.members.length === 0 ? (
          /* an empty roster is a workspace this device has not heard yet, not a workspace with
             nobody in it — and on a first launch those are minutes apart, so the default stays
             enterable while the list fills in behind it */
          <p style={{ ...TEXT.sm, color: COLOR.textFaint, padding: SPACE.lg }}>
            Nobody has arrived yet — this device is still catching up with the workspace. You can go
            in as {account} and choose again once the roster lands.
          </p>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: SPACE.sm }}>
            {catalog.members.map((who) => (
              <button
                aria-pressed={who.id === account}
                key={who.id}
                onClick={() => setAccount(who.id)}
                style={{
                  alignItems: "center",
                  appearance: "none",
                  background: who.id === account ? COLOR.raised : "transparent",
                  border: "none",
                  borderRadius: RADIUS.sm,
                  color: COLOR.text,
                  cursor: "pointer",
                  display: "flex",
                  font: "inherit",
                  gap: SPACE.sm,
                  padding: `${String(SPACE.sm)}px ${String(SPACE.md)}px`,
                  textAlign: "left",
                  width: "100%",
                }}
                type="button"
              >
                <Avatar size={26} who={who} />
                <span style={{ display: "grid", flex: 1, gap: 1, minWidth: 0 }}>
                  <span style={{ ...TEXT.sm, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {who.name}
                  </span>
                  <span style={{ ...TEXT.xs, color: COLOR.textFaint }}>@{who.handle}</span>
                </span>
                <Tick picked={who.id === account} />
              </button>
            ))}
          </div>
        )}

        <footer style={{ borderTop: HAIRLINE, display: "grid", gap: SPACE.sm, padding: SPACE.lg }}>
          <span style={CAPTION}>Role</span>
          <div style={{ display: "flex", gap: SPACE.xs }}>
            {ROLES.map((rung) => (
              <button
                aria-pressed={rung === role}
                key={rung}
                onClick={() => setRole(rung)}
                style={{
                  ...BUTTON,
                  background: rung === role ? COLOR.raised : "transparent",
                  borderColor: rung === role ? COLOR.hairlineStrong : COLOR.hairline,
                  color: rung === role ? COLOR.text : COLOR.textDim,
                  flex: 1,
                }}
                type="button"
              >
                {rung}
              </button>
            ))}
          </div>
          <span style={{ ...TEXT.xs, color: COLOR.textDim }}>{ROLE_EXPLAINS[role]}</span>
          {acting.failure === undefined ? null : (
            <span style={{ ...TEXT.xs, color: SEVERITY_COLOR.critical }}>{acting.failure}</span>
          )}
          <button
            onClick={enter}
            style={{
              ...BUTTON,
              background: COLOR.raised,
              borderColor: COLOR.hairlineStrong,
              color: COLOR.text,
              padding: `${String(SPACE.sm)}px ${String(SPACE.md)}px`,
            }}
            type="button"
          >
            Enter as {chosen?.name ?? account} · {role}
          </button>
          {/* said plainly, because the rest of this app is careful and a reader could reasonably
              assume the grant is not self-minted — `../actor.ts` has the long version */}
          <span style={{ ...TEXT.xs, color: COLOR.textFaint }}>
            This build mints its own grant from a bundled issuer key, so it can act as anyone at any
            role. A real deployment asks an authority instead.
          </span>
        </footer>
      </div>
    </div>
  );
}
