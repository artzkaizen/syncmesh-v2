import type { PeerId } from "@syncmesh/kernel";

import type {
  DevtoolsAck,
  DevtoolsLinkEvent,
  DevtoolsLinks,
  DevtoolsPeer,
  DevtoolsSync,
} from "../contract.js";
import type { MediumView } from "./link-kit.js";

import { Empty, Meter, Panel, Row, Tag } from "../react/primitives/index.js";
import { COLOR, SPACE, TEXT } from "../tokens.js";
import {
  ageSeverity,
  CANNOT_SAY,
  endingCounts,
  EndingLegend,
  FAINT,
  LinkEvents,
  shortPeer,
  since,
  Sparkline,
} from "./link-kit.js";

/**
 * One peer as a row and as a drill-down — the model the Peers panel lists, and the three questions
 * it answers once you pick one.
 *
 * Separate from the panel because the two are read at different distances. The list is scanned:
 * bars, tags and colour, nothing to parse. The detail is read: every medium's verdict about this
 * one peer, the path a frame takes to it, and the endings its links have had. Keeping them apart
 * keeps the list from growing prose and the detail from being squeezed into a cell.
 */

/** One peer with the two figures that only make sense together: the gap, and its age. */
export interface PeerRow {
  readonly peer: DevtoolsPeer;
  readonly behind: number | undefined;
  readonly atMs: number | undefined;
}

/** Where a peer's cursor stands against this device's own run; `undefined` where either is unknown. */
const behindBy = (sync: DevtoolsSync, self: PeerId, ack: DevtoolsAck | undefined) => {
  const ours = sync.authors.find((author) => author.peer === self)?.cursor;
  if (ack?.ours === undefined || ours === undefined) return undefined;
  return Math.max(0, ours - ack.ours);
};

export const rowsOf = (links: DevtoolsLinks, sync: DevtoolsSync) =>
  links.peers.map((peer) => {
    const ack = sync.acks.find((entry) => entry.peer === peer.peer);
    return {
      peer,
      behind: behindBy(sync, links.self, ack),
      atMs: (ack?.at ?? peer.ackedAt)?.epochMilliseconds,
    } satisfies PeerRow;
  });

/** One tag per medium — never a joined string, which is a list a reader has to parse. */
export function Carriers({ row }: { readonly row: PeerRow }) {
  if (row.peer.over.length === 0) return <span style={FAINT}>seen only — no live session</span>;
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: SPACE.xs }}>
      {row.peer.over.map((name) => (
        <Tag key={name}>{name}</Tag>
      ))}
    </span>
  );
}

export interface LagProps {
  readonly row: PeerRow;
  /** The worst gap in the list, so every bar is read against the same ruler. */
  readonly worst: number;
  readonly nowMs: number;
}

/**
 * Length is the gap; colour is how long ago the peer vouched for it.
 *
 * Two facts in one mark, because they are only meaningful together: a long bar in green is a
 * device catching up and a long bar in red is a device that stopped answering, and a reader
 * sorting twelve peers by eye should never have to do that subtraction themselves.
 */
export function Lag({ row, worst, nowMs }: LagProps) {
  if (row.behind === undefined) return <span style={FAINT}>never acknowledged</span>;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: SPACE.sm, minWidth: 0 }}>
      <Meter height={4} max={worst} severity={ageSeverity(row.atMs, nowMs)} value={row.behind} />
      <span style={{ ...TEXT.xs, color: COLOR.textDim, fontVariantNumeric: "tabular-nums" }}>
        {row.behind}
      </span>
    </span>
  );
}

/** What one medium has to say about one peer. The third answer is the one a lesser panel omits. */
const verdictOf = (medium: MediumView, peer: PeerId) =>
  medium.carrying.includes(peer) ? "carrying" : medium.enumerates ? "not carrying" : CANNOT_SAY;

export interface DetailProps {
  readonly links: DevtoolsLinks;
  readonly mediums: readonly MediumView[];
  readonly row: PeerRow;
  readonly nowMs: number;
}

function Path({ links, row, nowMs }: Omit<DetailProps, "mediums">) {
  const route = links.routes.find((entry) => entry.to === row.peer.peer);
  const style = { ...TEXT.xs, color: COLOR.textDim, padding: SPACE.md };
  if (row.peer.over.length > 0)
    return (
      <div style={{ ...style, display: "flex", alignItems: "center", gap: SPACE.sm }}>
        Direct neighbour, carried by <Carriers row={row} /> — no route table entry is needed.
      </div>
    );
  if (route === undefined)
    return (
      <div style={{ ...style, color: COLOR.textFaint }}>
        No live session and no route. This peer is known — seen on a medium, or named by something
        it authored — and nothing here can reach it right now.
      </div>
    );
  return (
    <div style={style}>
      Reached through <strong>{shortPeer(route.via)}</strong>, {route.hops} hops from here.{" "}
      {route.expiresAt.epochMilliseconds <= nowMs
        ? "The advertisement has aged out; the next one re-learns it."
        : `Believed for another ${since(nowMs, route.expiresAt.epochMilliseconds)}.`}
    </div>
  );
}

/** One peer's slice of the ring: the source tallies endings by medium, and this asks by peer. */
const tallyOf = (history: readonly DevtoolsLinkEvent[]) =>
  history.map((event) => ({ transport: event.transport, kind: event.kind, count: 1 }));

const NO_HISTORY = (
  <Empty
    hint="Nothing has been proved, refused or closed for this peer since the panel opened. A medium that declares no onLinkEvent never reports here, so silence is not proof of a steady link."
    title="Nothing recorded for this peer"
  />
);

export function Detail({ links, mediums, row, nowMs }: DetailProps) {
  const history = links.recent.filter((event) => event.peer === row.peer.peer);
  return (
    <div style={{ display: "grid", gap: SPACE.lg, minWidth: 0 }}>
      <Panel padded={false} subtitle="every medium's answer about this one peer" title="Reached by">
        {mediums.map((medium) => {
          const verdict = verdictOf(medium, row.peer.peer);
          return (
            <Row
              key={medium.name}
              label={medium.name}
              meta={`${medium.kind} · ${medium.condition}`}
              severity={verdict === "carrying" ? "ok" : "muted"}
              trailing={
                verdict === "carrying" ? (
                  <Tag severity="ok" variant="solid">
                    carrying
                  </Tag>
                ) : (
                  <span style={FAINT}>{verdict}</span>
                )
              }
            />
          );
        })}
      </Panel>
      <Panel padded={false} subtitle="how a frame gets there" title="Path">
        <Path links={links} nowMs={nowMs} row={row} />
      </Panel>
      <Panel subtitle="proved, refused, dropped, closed" title="Link history">
        <div style={{ display: "grid", gap: SPACE.md, minWidth: 0 }}>
          <Sparkline events={history} nowMs={nowMs} />
          <EndingLegend counts={endingCounts(tallyOf(history))} />
        </div>
      </Panel>
      <Panel padded={false}>
        <LinkEvents empty={NO_HISTORY} events={history} nowMs={nowMs} />
      </Panel>
    </div>
  );
}
