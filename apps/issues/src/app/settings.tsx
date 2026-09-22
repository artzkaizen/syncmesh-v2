import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { Scale } from "./install.js";
import type { Reach } from "./reach.js";

import { Avatar } from "./atoms.js";
import { useActing, useCatalog, useTab } from "./context.js";
import { AUTHORITY_URL } from "./identity.js";
import { leaveWorkspace, scaleOf, wipeReplica } from "./install.js";
import { mesh } from "./mesh.js";
import { watchReach } from "./reach.js";
import { BUTTON, CAPTION, COLOR, HAIRLINE, SEVERITY_COLOR, SPACE, TEXT } from "./ui.js";

/**
 * Everything about *this install* rather than about the workspace: who it is, what it can reach,
 * what it is holding, and the two destructive buttons.
 *
 * All four are facts the rest of the app deliberately refuses to guess at, gathered in the one
 * place somebody goes looking for them. The relay comes off the same broadcast the corner badge
 * reads, because there is one answer and two views of it; the authority is what this build was
 * *told*, which is a different question from whether it answered; and the three counts underneath
 * are the log itself, read across the port like any other query.
 *
 * **Nothing here polls.** The relay's state is pushed when it changes, and the size of the log is
 * read once when this screen opens — three `count(*)`s over the whole store is a real cost and a
 * number nobody watches tick, so it is a fact as of the moment somebody asked rather than a meter.
 */

const Section = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <section style={{ display: "grid", gap: SPACE.sm, marginBottom: SPACE.xl }}>
    <span style={CAPTION}>{title}</span>
    <div style={{ border: HAIRLINE, borderRadius: 6 }}>{children}</div>
  </section>
);

/** A name on the left and a value on the right. Selectable, because a wrong URL gets pasted. */
const Detail = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div
    style={{
      alignItems: "baseline",
      borderBottom: HAIRLINE,
      display: "flex",
      gap: SPACE.lg,
      padding: `${String(SPACE.sm)}px ${String(SPACE.md)}px`,
    }}
  >
    <span style={{ ...TEXT.sm, color: COLOR.textDim, flex: 1 }}>{label}</span>
    <span style={{ ...TEXT.sm, color: COLOR.text, overflowWrap: "anywhere", textAlign: "right" }}>
      {value}
    </span>
  </div>
);

const Caption = ({ children }: { readonly children: ReactNode }) => (
  <span style={{ ...TEXT.xs, color: COLOR.textFaint }}>{children}</span>
);

/**
 * A button that asks first, and asks with the sentence that says what is lost.
 *
 * `confirm` rather than a modal of this app's own: both of these are rare, both are irreversible
 * in the only sense that matters here, and a dialog the page draws itself is one more surface to
 * get the focus trap wrong on. What matters is that the question names the consequence.
 */
const Dangerous = ({
  label,
  asks,
  onConfirm,
}: {
  readonly label: string;
  readonly asks: string;
  readonly onConfirm: () => void;
}) => (
  <button
    onClick={() => {
      if (globalThis.confirm(asks)) onConfirm();
    }}
    style={{
      ...BUTTON,
      borderColor: COLOR.hairline,
      color: SEVERITY_COLOR.critical,
      margin: SPACE.md,
    }}
    type="button"
  >
    {label}
  </button>
);

export function Settings() {
  const follower = mesh.api.$mesh;
  const { durable, role, shared } = useTab();
  const acting = useActing();
  const catalog = useCatalog();
  const me = catalog.member.get(acting.actor.account);

  const [reach, setReach] = useState<Reach>();
  useEffect(() => watchReach(setReach), []);

  const [scale, setScale] = useState<Scale>();
  useEffect(() => {
    let live = true;
    void scaleOf(follower).then((held) => {
      if (live) setScale(held);
    });
    return () => {
      live = false;
    };
  }, [follower]);

  return (
    <>
      <Section title="Account">
        <div
          style={{
            alignItems: "center",
            borderBottom: HAIRLINE,
            display: "flex",
            gap: SPACE.sm,
            padding: SPACE.md,
          }}
        >
          <Avatar size={32} who={me} />
          <span style={{ display: "grid", flex: 1, gap: 1 }}>
            <span style={TEXT.sm}>{me?.name ?? acting.actor.account}</span>
            <Caption>
              {me === undefined ? "not in this workspace yet" : `@${me.handle}`} ·{" "}
              {acting.actor.role}
            </Caption>
          </span>
          <Link style={{ ...BUTTON, textDecoration: "none" }} to="/identity">
            Switch user or role
          </Link>
        </div>
        <div style={{ padding: SPACE.md }}>
          <button
            onClick={leaveWorkspace}
            style={{ ...BUTTON, color: COLOR.textDim }}
            type="button"
          >
            Sign out
          </button>
          <div style={{ marginTop: SPACE.sm }}>
            <Caption>
              Signing out forgets the choice and asks again; the log and this device&rsquo;s key are
              untouched. This build mints its own grant from a bundled issuer key, so it can act as
              anyone at any role — a real deployment asks an authority instead.
            </Caption>
          </div>
        </div>
      </Section>

      <Section title="Workspace">
        <div style={{ display: "flex", gap: SPACE.sm, padding: SPACE.md }}>
          <Link style={{ ...BUTTON, textDecoration: "none" }} to="/people">
            People ({catalog.members.length})
          </Link>
          <Link style={{ ...BUTTON, textDecoration: "none" }} to="/">
            Issues
          </Link>
        </div>
      </Section>

      <Section title="Sync">
        <Detail
          label="Relay"
          value={reach?.url ?? "none configured — this install is local only"}
        />
        <Detail label="Relay state" value={reach?.state ?? "not reported yet"} />
        <Detail label="Authority" value={AUTHORITY_URL} />
        <Detail label="This device" value={reach?.device ?? "not reported yet"} />
        <Detail label="Storage" value={durable ? "SQLite over OPFS" : "memory — not saved"} />
        <Detail label="This tab" value={shared ? role : `${role}, single-tab mode`} />
      </Section>

      <Section title="This device is holding">
        {scale === undefined ? (
          <Detail label="Events" value="reading the log…" />
        ) : (
          <>
            <Detail label="Events" value={scale.events.toLocaleString()} />
            <Detail label="State rows" value={scale.rows.toLocaleString()} />
            <Detail
              label="Log size"
              value={`${Math.round(scale.bytes / 1024).toLocaleString()} KB`}
            />
          </>
        )}
      </Section>

      <Section title="Danger">
        <Dangerous
          asks="Delete this device's replica and rejoin from scratch? Anything written here that no peer has carried yet is lost."
          label="Reset local replica"
          onConfirm={wipeReplica}
        />
        <div style={{ padding: `0 ${String(SPACE.md)}px ${String(SPACE.md)}px` }}>
          <Caption>
            The log lives on the peers too, so this loses nothing that was acknowledged — it makes
            this device new again, which is the only way to watch a first sync more than once. Every
            window of this origin reloads when it is done.
          </Caption>
        </div>
      </Section>
    </>
  );
}
