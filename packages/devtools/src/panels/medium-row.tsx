import type { ReactNode } from "react";

import type { MediumView } from "./link-kit.js";

import { Meter, Row, Tag } from "../react/primitives/index.js";
import { COLOR, SPACE, TEXT } from "../tokens.js";
import { CANNOT_SAY, CONDITION_SEVERITY, FAINT, shortPeer } from "./link-kit.js";

/**
 * One medium as a row: what it says about itself, how hard it is working, who it is holding.
 *
 * **A bar is never drawn on an invented maximum.** A medium with a `maxLinks` gets a meter against
 * it, because that is a real ceiling the mesh enforces. A medium without one gets a meter scaled to
 * the busiest medium here — an observed figure, labelled as a share, never as capacity. And a
 * medium that cannot enumerate its links at all gets no bar of any kind: it keeps its row, its
 * condition and {@link CANNOT_SAY}, because a bar over an unknown is a lie with a colour on it.
 *
 * Its own file because the Transports panel is now two subjects — the mediums, and the endings
 * their links came to — and a row that has grown a control belongs with the row.
 */

/** How close a medium is to the seat limit its own radio declares. */
export const pressure = (held: number, max: number) =>
  held >= max ? "critical" : held / max > 0.7 ? "high" : "ok";

function Load({ medium, busiest }: { readonly medium: MediumView; readonly busiest: number }) {
  const held = medium.carrying.length;
  if (!medium.enumerates)
    return <span style={{ ...FAINT, width: 150, flex: "none" }}>links not countable</span>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: SPACE.sm, width: 150, flex: "none" }}>
      <Meter
        height={4}
        max={medium.maxLinks ?? busiest}
        severity={medium.maxLinks === undefined ? undefined : pressure(held, medium.maxLinks)}
        value={held}
      />
      <span style={{ ...TEXT.xs, color: COLOR.textDim, fontVariantNumeric: "tabular-nums" }}>
        {medium.maxLinks === undefined ? `${held} held` : `${held}/${medium.maxLinks}`}
      </span>
    </div>
  );
}

/** The inverse view, and the one place `silent` must not be allowed to look like zero. */
function Carrying({ medium }: { readonly medium: MediumView }) {
  if (medium.carrying.length === 0)
    return (
      <span style={FAINT}>
        {medium.enumerates
          ? "carrying nobody — it can name its links and is holding none"
          : `carrying: ${CANNOT_SAY}, so a peer appears here only once a session names it`}
      </span>
    );
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: SPACE.xs, minWidth: 0 }}>
      {medium.carrying.map((peer) => (
        <Tag key={peer} mono>
          {shortPeer(peer)}
        </Tag>
      ))}
      {medium.enumerates ? null : <span style={FAINT}>…and possibly more</span>}
    </span>
  );
}

/**
 * What the medium's own `onStatus` last said, kept apart from its condition.
 *
 * `undefined` is a medium that has never spoken — not one that is down — and flattening the two
 * was the case being lost: a radio whose condition still reads `ok` while its status went false is
 * exactly the contradiction a green dot hides, and it is the one worth colouring.
 */
const heard = (online: boolean | undefined) =>
  online === undefined ? "has not said if it is up" : online ? "up" : "offline";

export interface MediumProps {
  readonly medium: MediumView;
  readonly busiest: number;
  /** Whether a person is holding this medium here, which is not what the medium says about itself. */
  readonly held: boolean;
  readonly control: ReactNode;
}

export function Medium({ medium, busiest, held, control }: MediumProps) {
  const contradicted = medium.online === false && medium.condition === "ok";
  const severity = contradicted ? "high" : CONDITION_SEVERITY[medium.condition];
  return (
    <Row
      label={
        <span style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
          {medium.name}
          <Tag>{medium.kind}</Tag>
          {severity === "ok" ? null : (
            <Tag severity={severity} variant="solid">
              {contradicted ? "offline" : medium.condition}
            </Tag>
          )}
          {/* the condition beside it is now true of this device; only this says a person made it so */}
          {held ? (
            <Tag severity="high" variant="solid">
              held here
            </Tag>
          ) : null}
        </span>
      }
      meta={`priority ${medium.priority} · ${heard(medium.online)}`}
      severity={severity}
      trailing={
        <span style={{ display: "flex", alignItems: "center", gap: SPACE.md, flex: "none" }}>
          <Load busiest={busiest} medium={medium} />
          {control}
        </span>
      }
    >
      <Carrying medium={medium} />
    </Row>
  );
}
