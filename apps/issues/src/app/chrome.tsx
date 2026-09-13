import type { DevtoolsControls } from "@syncmesh/devtools";

import { ForcedBadge } from "@syncmesh/devtools/react";
import { useLiveQuery } from "@syncmesh/react";

import type { Replica } from "./replica.js";

import { WORKSPACE_ID } from "../domain.js";
import { useReplica } from "./context.js";
import {
  BUTTON,
  COLOR,
  HAIRLINE,
  INPUT,
  RADIUS,
  SEVERITY_COLOR,
  SEVERITY_TINT,
  SPACE,
  TEXT,
} from "./ui.js";

/**
 * The strip across the top: who this is, what is in it, where it is stored, which tab is holding
 * it, and one search box.
 */

/**
 * **Where the bytes went and which tab has them, on screen, always.**
 *
 * These are the one piece of chrome in the app that is not there to help someone work. A database
 * that fell back to `"memory"` looks and behaves exactly like one that did not — writes commit,
 * queries return, the board scrolls — right up until the reload, at which point the workspace is
 * empty and nothing ever said it would be. The same is true one level up: a tab that cannot reach
 * the origin's engine and quietly opened a second database would look identical to one that did
 * not, and would be losing writes into a log nobody else reads. So both facts are displayed rather
 * than logged, and the degraded cases are coloured like the problems they are.
 */
interface Mode {
  readonly label: string;
  readonly detail: string;
  readonly severity: "ok" | "high" | "critical";
}

const DURABLE = {
  label: "OPFS",
  detail:
    "SQLite over the origin private file system, on the access-handle pool, inside the dedicated worker this origin elected — this is saved",
  severity: "ok",
} satisfies Mode;

const MEMORY = {
  label: "Memory — not saved",
  detail:
    "SQLite's OPFS backends need synchronous file handles, which this browser exposes to no thread at all — so the origin's worker opened a memory database and everything here is gone at the next reload",
  severity: "critical",
} satisfies Mode;

/**
 * **Which tab holds the engine, and the two answers are equally good.**
 *
 * One engine per origin is the whole of `research/browser-durability.md` §4: one identity, one log,
 * one allocation of `(author, seq)`. A follower is not a degraded leader and this badge does not
 * colour it like one — it is a window onto the same database, which is why a change made in one
 * tab is on screen in the other without a reload.
 */
const ROLE = {
  leader: {
    label: "Leader",
    detail:
      "This tab's own worker holds the origin's engine and its database; every other tab of this app reads and writes through it over a port. Close this tab and the lock passes to one of them, which is a reconnect rather than a restart.",
    severity: "ok",
  },
  follower: {
    label: "Follower",
    detail:
      "Another tab of this app holds the origin's engine and its database; this tab reads and writes across a port to it. One database and one log, not a copy — which is why a write here appears there, and there appears here, with nothing to reconcile.",
    severity: "ok",
  },
} satisfies Record<Replica["role"], Mode>;

/**
 * **No rendezvous, so one tab is live and the rest will say so.**
 *
 * A `SharedWorker` is the only singleton a browser gives an origin, and a follower needs one: it
 * cannot address another tab's dedicated worker and nothing else in the platform will introduce
 * them. Where there is none — Chrome on Android — the elected tab works and every other tab is
 * told, which is the same rule the storage badge follows: name the mode rather than degrade into
 * a tab that looks live and is not.
 */
const SINGLE = {
  label: "Single-tab mode",
  detail:
    "This browser has no SharedWorker, so there is nothing to introduce a second tab of this origin to this one. This tab holds the engine; another tab will say it cannot reach one rather than quietly opening a second database. Chrome on Android is the case this covers.",
  severity: "high",
} satisfies Mode;

function Badge({ label, detail, severity }: Mode) {
  const color = SEVERITY_COLOR[severity];
  return (
    <span
      style={{
        alignItems: "center",
        background: SEVERITY_TINT[severity],
        border: `1px solid ${color}33`,
        borderRadius: RADIUS.pill,
        color,
        display: "inline-flex",
        gap: SPACE.xs,
        padding: `2px ${String(SPACE.sm)}px`,
        ...TEXT.xs,
      }}
      title={detail}
    >
      <span style={{ background: color, borderRadius: RADIUS.pill, height: 5, width: 5 }} />
      {label}
    </span>
  );
}

export const StorageBadge = ({ durable }: { readonly durable: boolean }) => (
  <Badge {...(durable ? DURABLE : MEMORY)} />
);

export const ModeBadge = ({
  role,
  shared,
}: {
  readonly role: Replica["role"];
  readonly shared: boolean;
}) => <Badge {...(shared ? ROLE[role] : SINGLE)} />;

/** One number and its caption, at the density the inspector's stat band uses. */
function Count({
  label,
  value,
  dim,
}: {
  readonly label: string;
  readonly value: number;
  readonly dim?: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: 1 }}>
      <span style={{ ...TEXT.micro, color: COLOR.textFaint }}>{label}</span>
      <span
        style={{
          color: dim === true ? COLOR.textDim : COLOR.text,
          fontVariantNumeric: "tabular-nums",
          ...TEXT.md,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The workspace's own heartbeat, live.
 *
 * `unnumbered` is the number worth having up here: it is the only one on this screen that a
 * network outage can move, because a number is the one fact in this tracker a device cannot
 * decide for itself. Watch it stay put with the tab offline and the claim the app is making
 * becomes something you can see rather than something you have to be told.
 */
function Summary() {
  const { api } = useReplica();
  const [totals] = useLiveQuery(api.issues.summary({ workspaceId: WORKSPACE_ID })).data;
  return (
    <div style={{ display: "flex", gap: SPACE.xl }}>
      <Count label="Issues" value={totals?.total ?? 0} />
      <Count label="Open" value={totals?.open ?? 0} />
      <Count dim label="Unnumbered" value={totals?.unnumbered ?? 0} />
    </div>
  );
}

/**
 * The third pill, and the only one that is usually not there.
 *
 * Storage and role are facts about every session; a held medium is a thing somebody did, so
 * {@link ForcedBadge} draws nothing at all until something is held — a header that always has
 * three pills teaches a reader to stop looking at the third. What it costs while nothing is held
 * is one subscription on a hub that only a click moves.
 *
 * **It lights up when any tab of this origin holds a medium, not just this one**, because there is
 * one device here and one set of radios. That is the whole reason it earns a seat beside the two
 * badges that say which database and which tab.
 */
export function Chrome({
  text,
  onText,
  controls,
}: {
  readonly text: string;
  readonly onText: (next: string) => void;
  readonly controls: DevtoolsControls;
}) {
  const { durable, role, shared } = useReplica();
  return (
    <header
      style={{
        alignItems: "center",
        borderBottom: HAIRLINE,
        display: "flex",
        flex: "none",
        gap: SPACE.xl,
        padding: `${String(SPACE.md)}px ${String(SPACE.lg)}px`,
      }}
    >
      <div style={{ display: "grid", gap: 1 }}>
        <span style={{ ...TEXT.micro, color: COLOR.textFaint }}>Acme</span>
        <span style={{ ...TEXT.md, color: COLOR.text, fontWeight: 500 }}>Issues</span>
      </div>
      <StorageBadge durable={durable} />
      <ModeBadge role={role} shared={shared} />
      <ForcedBadge controls={controls} />
      <input
        aria-label="Search issues"
        onChange={(event) => onText(event.target.value)}
        placeholder="Search titles and descriptions…"
        style={{
          ...INPUT,
          ...BUTTON,
          background: COLOR.sunken,
          color: COLOR.text,
          marginLeft: "auto",
          maxWidth: 320,
        }}
        value={text}
      />
      <Summary />
    </header>
  );
}
