import type { LinkEventKind } from "@syncmesh/transport";

import { useState } from "react";

import type { DevtoolsLinks, DevtoolsRoute } from "../contract.js";
import type { Column, StatProps } from "../react/primitives/index.js";
import type { DevtoolsTab, DevtoolsTabProps } from "../tabs.js";
import type { LinksSource, MediumView } from "./link-kit.js";

import { useForced } from "../react/forced.js";
import { Icon } from "../react/icons.js";
import { Empty, Meter, Panel, Ring, Row, Table, Tag, Toolbar } from "../react/primitives/index.js";
import { SPACE } from "../tokens.js";
import {
  endingCounts,
  EndingLegend,
  ENDINGS,
  LinkEvents,
  LINK_SEVERITY,
  share,
  shortPeer,
  since,
  Sparkline,
  StatBand,
  useMesh,
  useNowMs,
} from "./link-kit.js";
import { DeviceSwitch, MediumSwitch, NoControls } from "./medium-controls.js";
import { Medium, pressure } from "./medium-row.js";

/**
 * What this client is actually listening on, and how hard each medium is working.
 *
 * A row that says "websocket, ok" answers nothing a developer opened a devtool to ask. The
 * question is the inverse of the Peers panel's — *this medium is up, so who is on the other end of
 * it* — and it is asked by eye: the ring says what proportion of this device's link attempts ended
 * in a proof, the meters say which radio is carrying the mesh and which is at its seat limit, and
 * only then does anybody read a row.
 *
 * **A bar is never drawn on an invented maximum.** A medium with a `maxLinks` gets a meter against
 * it, because that is a real ceiling the mesh enforces. A medium without one gets a meter scaled to
 * the busiest medium here — an observed figure, labelled as a share, never as capacity. And a
 * medium that cannot enumerate its links at all gets no bar of any kind: it keeps its row, its
 * condition and {@link CANNOT_SAY}, because a bar over an unknown is a lie with a colour on it.
 */

/**
 * Is this device's link layer healthy — as a ring, then as the five bars behind it.
 *
 * Proofs over endings is the one number worth reading first: a device whose links mostly end in a
 * handshake is working, and a device at 20% is being refused somewhere and does not know it. The
 * bars beneath break the same window down, so the ring's verdict always has its evidence beside it.
 */
function Mix({ counts }: { readonly counts: ReadonlyMap<LinkEventKind, number> }) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const proven = counts.get("proven") ?? 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: SPACE.xl, minWidth: 0 }}>
      <Ring
        display={total === 0 ? "—" : `${Math.round(share(proven, total))}%`}
        label="proved"
        severity={total === 0 ? "muted" : proven === total ? "ok" : pressure(total - proven, total)}
        value={share(proven, total)}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        {ENDINGS.map((kind) => (
          <Row
            key={kind}
            label={kind}
            severity={LINK_SEVERITY[kind]}
            trailing={counts.get(kind) ?? 0}
          >
            <Meter
              max={Math.max(1, total)}
              severity={LINK_SEVERITY[kind]}
              value={counts.get(kind) ?? 0}
            />
          </Row>
        ))}
      </div>
    </div>
  );
}

const routeColumns = (nowMs: number) =>
  [
    { key: "to", header: "To", width: "minmax(0, 1fr)", render: (r) => shortPeer(r.to) },
    { key: "via", header: "Via", width: "minmax(0, 1fr)", render: (r) => shortPeer(r.via) },
    {
      key: "hops",
      header: "Hops",
      width: "minmax(0, 1fr)",
      render: (route) => (
        <Meter max={4} severity={route.hops > 2 ? "high" : "low"} value={route.hops} />
      ),
    },
    { key: "n", header: "", width: "32px", align: "right", render: (r) => r.hops },
    {
      key: "expires",
      header: "Expires",
      width: "68px",
      align: "right",
      render: (route) =>
        route.expiresAt.epochMilliseconds <= nowMs
          ? "aged out"
          : `in ${since(nowMs, route.expiresAt.epochMilliseconds)}`,
    },
  ] satisfies Column<DevtoolsRoute>[];

const NO_MEDIUMS = (
  <Empty
    hint="This client is running no transport, so it can reach nobody and nobody can reach it — every write stays on this device. A mesh is handed its mediums at boot; if you expected one, it was never added or its start() rejected."
    icon={<Icon name="radio" size={20} />}
    title="No mediums"
  />
);

const NO_ROUTES = (
  <Empty
    hint="Every peer this device talks to is a direct neighbour, or there are none at all. A row appears here when a neighbour advertises that it can reach somebody this device cannot."
    title="No multi-hop routes"
  />
);

const NO_EVENTS = (
  <Empty
    hint="Nothing has been proved, refused, dropped or closed since this panel opened. A medium that declares no onLinkEvent — a transport built out of two functions, or a relay that does not report — never appears here at all, so silence is not proof of a steady link."
    title="No link events yet"
  />
);

/** Counted over the mediums that can answer, so a relay's silence never becomes somebody's zero. */
const tally = (mediums: readonly MediumView[], links: DevtoolsLinks, refused: number) =>
  [
    { label: "Mediums", value: mediums.length, icon: <Icon name="radio" size={15} /> },
    {
      label: "Links held",
      value: mediums.reduce((total, medium) => total + medium.carrying.length, 0),
      severity: mediums.some((medium) => medium.condition === "ok") ? undefined : "critical",
    },
    {
      label: "Cannot say",
      value: links.silent.length,
      delta: links.silent.length === 0 ? undefined : <Tag>not a zero</Tag>,
    },
    {
      label: "Refusals in ring",
      value: refused,
      severity: refused === 0 ? undefined : "critical",
      icon: <Icon name="close" size={15} />,
    },
  ] satisfies StatProps[];

export function Transports({ source, controls }: DevtoolsTabProps<LinksSource>) {
  const forced = useForced(controls);
  // `forced` rather than a channel: holding a medium is a click, and the source has no hook for
  // one — see `useMesh`. It is also what makes a release re-read the medium that just came back.
  const { links, mediums } = useMesh(source, forced);
  const held = new Map(forced.map((one) => [one.name, one.as]));
  const nowMs = useNowMs();
  const [chosen, setChosen] = useState("all");
  const picked = chosen === "all" ? undefined : chosen;
  const feed =
    picked === undefined ? links.recent : links.recent.filter((e) => e.transport === picked);
  const counts = endingCounts(links.tally, picked);
  const busiest = Math.max(1, ...mediums.map((medium) => medium.carrying.length));
  return (
    <div style={{ display: "grid", gap: SPACE.lg, padding: SPACE.lg, minWidth: 0 }}>
      <StatBand stats={tally(mediums, links, endingCounts(links.tally).get("refused") ?? 0)} />

      <Panel
        actions={
          controls === undefined ? (
            <NoControls />
          ) : (
            <DeviceSwitch controls={controls} forced={forced} mediums={mediums} />
          )
        }
        padded={false}
        subtitle="what this client is listening on"
        title="Mediums"
      >
        {mediums.length === 0
          ? NO_MEDIUMS
          : mediums.map((medium) => (
              <Medium
                busiest={busiest}
                control={
                  controls === undefined ? null : (
                    <MediumSwitch
                      controls={controls}
                      held={held.get(medium.name)}
                      medium={medium}
                    />
                  )
                }
                held={held.has(medium.name)}
                key={medium.name}
                medium={medium}
              />
            ))}
      </Panel>

      <Panel subtitle="endings still in the ring — a window, not a total" title="Link health">
        <Mix counts={counts} />
      </Panel>

      <Panel padded={false} subtitle="reached through somebody else" title="Routes">
        <Table
          columns={routeColumns(nowMs)}
          empty={NO_ROUTES}
          rowKey={(route) => `${route.to}:${route.via}`}
          rows={links.routes}
        />
      </Panel>

      <Panel
        actions={
          <Toolbar
            filter={chosen}
            filterOptions={[
              { value: "all", label: "All mediums" },
              ...mediums.map((medium) => ({ value: medium.name, label: medium.name })),
            ]}
            onFilter={setChosen}
          />
        }
        subtitle="the last two minutes, stacked by ending"
        title="Link events"
      >
        <div style={{ display: "grid", gap: SPACE.md, minWidth: 0 }}>
          <Sparkline events={feed} nowMs={nowMs} />
          <EndingLegend counts={counts} />
        </div>
      </Panel>

      <Panel padded={false}>
        <LinkEvents empty={NO_EVENTS} events={feed} nowMs={nowMs} />
      </Panel>
    </div>
  );
}

export const transportsTab = {
  id: "transports",
  label: "Transports",
  icon: <Icon name="radio" size={14} />,
  render: Transports,
} satisfies DevtoolsTab<LinksSource>;
