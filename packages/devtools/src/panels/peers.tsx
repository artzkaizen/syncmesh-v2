import { useState } from "react";

import type { Column, StatProps } from "../react/primitives/index.js";
import type { DevtoolsTab, DevtoolsTabProps } from "../tabs.js";
import type { LinksSource, MediumView } from "./link-kit.js";
import type { PeerRow } from "./peer-view.js";

import { Icon } from "../react/icons.js";
import {
  Empty,
  Meter,
  Panel,
  Ring,
  Row,
  StatusDot,
  Table,
  Tag,
} from "../react/primitives/index.js";
import { SPACE } from "../tokens.js";
import {
  CANNOT_SAY,
  endingCounts,
  FAINT,
  FONT_MONO,
  share,
  shortPeer,
  since,
  StatBand,
  useMesh,
  useNowMs,
  useSync,
} from "./link-kit.js";
import { Carriers, Detail, Lag, rowsOf } from "./peer-view.js";

/**
 * Who this device is talking to, and — the whole point — over what.
 *
 * A peer row that does not name the mediums carrying it is a row nobody can act on. The id alone
 * cannot tell you whether that phone is on the far side of a relay, next to you on BLE, or held
 * open by both at once, and those three have three different answers to *why is it slow*.
 *
 * **The list is drawn, not written.** The ring says how much of what this device knows about it
 * can actually reach, the bars beside it say which medium is carrying the mesh, and each row's lag
 * is a bar scaled to the worst peer and coloured by the age of its acknowledgement. A reader finds
 * the one bad peer among twelve by looking, which is the only way that scales; the numerals are
 * there for when they have found it.
 *
 * **A carrier is the proof.** The source has no separate `proven` flag and needs none: a session
 * is only built after the handshake signed for the id, so a peer with a medium under it has been
 * proved, and a peer with none has been *seen* — named by a route, or by an event it authored —
 * which is a weaker claim and is drawn as one.
 */

/**
 * What an empty Peers panel is for.
 *
 * "No peers" alone is indistinguishable from a broken devtool, and the reason is always sitting
 * one panel away in the mediums' conditions — so it is quoted here rather than pointed at.
 */
const whyNoPeers = (mediums: readonly MediumView[]) => {
  if (mediums.length === 0)
    return "This client is running no transport at all, so there is nothing for a peer to arrive over. Every write stays on this device until a medium is added.";
  const down = mediums.filter((medium) => medium.condition !== "ok");
  if (down.length === mediums.length)
    return `Every medium is down: ${down.map((m) => `${m.name} (${m.condition})`).join(", ")}. A permission or a switched-off radio is a fact about this device, not about the mesh — clear the condition and peers appear here as sessions prove them.`;
  if (mediums.every((medium) => !medium.enumerates))
    return "The mediums that are up cannot enumerate their links, so a peer appears here only once a session names one as its carrier. If you expected somebody, read the link event feed on Transports: a refusal is the usual answer.";
  return "The mediums are up and nobody has answered. A radio reads ok while every dial to it is being refused, so the link event feed on Transports — not this panel — is where that shows.";
};

const peerColumns = (nowMs: number, worst: number) =>
  [
    {
      key: "peer",
      header: "Peer",
      width: "minmax(0, 1fr)",
      render: (row) => (
        <span
          style={{ display: "flex", alignItems: "center", gap: SPACE.sm, fontFamily: FONT_MONO }}
        >
          <StatusDot severity={row.peer.over.length === 0 ? "muted" : "ok"} />
          {shortPeer(row.peer.peer)}
        </span>
      ),
    },
    {
      key: "over",
      header: "Carried by",
      width: "minmax(0, 1.3fr)",
      render: (row) => <Carriers row={row} />,
    },
    {
      key: "lag",
      header: "Behind",
      width: "minmax(0, 1.3fr)",
      render: (row) => <Lag nowMs={nowMs} row={row} worst={worst} />,
    },
    {
      key: "said",
      header: "Said so",
      width: "68px",
      align: "right",
      render: (row) =>
        row.atMs === undefined ? <span style={FAINT}>never</span> : since(row.atMs, nowMs),
    },
  ] satisfies Column<PeerRow>[];

interface ReachProps {
  readonly rows: readonly PeerRow[];
  readonly mediums: readonly MediumView[];
}

/**
 * The headline, as a ring: how much of what this device knows about, it can actually reach.
 *
 * The bars beside it are the same proportion broken down by medium, so the ring's verdict always
 * has its evidence next to it — 40% reachable with the relay bar full and the radio bar empty is a
 * different morning from 40% with both half full. A medium that cannot enumerate gets no bar at
 * all: {@link CANNOT_SAY} sits where the meter would, because a bar over an unknown is a lie with
 * a colour on it.
 */
function Reach({ rows, mediums }: ReachProps) {
  const proved = rows.filter((row) => row.peer.over.length > 0).length;
  const severity =
    rows.length === 0
      ? "muted"
      : proved === 0
        ? "critical"
        : proved === rows.length
          ? "ok"
          : "high";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: SPACE.xl, minWidth: 0 }}>
      <Ring
        display={rows.length === 0 ? "—" : `${Math.round(share(proved, rows.length))}%`}
        label="reachable"
        severity={severity}
        value={share(proved, rows.length)}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        {mediums.map((medium) => (
          <Row
            key={medium.name}
            label={medium.name}
            severity={medium.enumerates ? "ok" : "muted"}
            trailing={
              medium.enumerates ? medium.carrying.length : <span style={FAINT}>{CANNOT_SAY}</span>
            }
          >
            {medium.enumerates ? (
              <Meter max={Math.max(1, rows.length)} value={medium.carrying.length} />
            ) : null}
          </Row>
        ))}
      </div>
    </div>
  );
}

const tally = (rows: readonly PeerRow[], mediums: readonly MediumView[], refused: number) =>
  [
    { label: "Peers known", value: rows.length, icon: <Icon name="mesh" size={15} /> },
    {
      label: "Sessions proved",
      value: rows.filter((row) => row.peer.over.length > 0).length,
      severity: rows.length > 0 && rows.every((row) => row.peer.over.length === 0) ? "high" : "ok",
    },
    {
      label: "Mediums carrying",
      value: mediums.filter((medium) => medium.carrying.length > 0).length,
      delta: mediums.length === 0 ? undefined : <Tag>of {mediums.length}</Tag>,
    },
    {
      label: "Refusals in ring",
      value: refused,
      severity: refused === 0 ? undefined : "critical",
      icon: <Icon name="close" size={15} />,
    },
  ] satisfies StatProps[];

const NO_PEERS = (mediums: readonly MediumView[]) => (
  <Empty hint={whyNoPeers(mediums)} icon={<Icon name="mesh" size={20} />} title="No peers" />
);

/** The worst gap in the list, so every lag bar in the table is read against one ruler. */
const worstOf = (rows: readonly PeerRow[]) => Math.max(1, ...rows.map((row) => row.behind ?? 0));

export function Peers({ source }: DevtoolsTabProps<LinksSource>) {
  const { links, mediums } = useMesh(source);
  const sync = useSync(source);
  const nowMs = useNowMs();
  const [chosen, setChosen] = useState<string | undefined>();
  const rows = rowsOf(links, sync);
  const row = rows.find((entry) => entry.peer.peer === chosen);
  return (
    <div style={{ display: "grid", gap: SPACE.lg, padding: SPACE.lg, minWidth: 0 }}>
      <StatBand stats={tally(rows, mediums, endingCounts(links.tally).get("refused") ?? 0)} />

      <Panel subtitle="proved sessions over peers this device knows of" title="Reachability">
        <Reach mediums={mediums} rows={rows} />
      </Panel>

      <Panel padded={false} subtitle="and the mediums carrying each one" title="Peers">
        <Table
          action={(entry) => (
            <button
              aria-label={`Inspect ${shortPeer(entry.peer.peer)}`}
              onClick={() => setChosen(entry.peer.peer === chosen ? undefined : entry.peer.peer)}
              type="button"
            >
              <Icon name="open" size={13} />
            </button>
          )}
          columns={peerColumns(nowMs, worstOf(rows))}
          empty={NO_PEERS(mediums)}
          rowKey={(entry) => entry.peer.peer}
          rows={rows}
        />
      </Panel>

      {row === undefined ? null : (
        <Detail links={links} mediums={mediums} nowMs={nowMs} row={row} />
      )}
    </div>
  );
}

export const peersTab = {
  id: "peers",
  label: "Peers",
  icon: <Icon name="mesh" size={14} />,
  render: Peers,
} satisfies DevtoolsTab<LinksSource>;
