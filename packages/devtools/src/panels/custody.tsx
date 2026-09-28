import type { StoreFailure } from "@syncmesh/engine";
import type { PeerId } from "@syncmesh/kernel";
import type { Result } from "@syncmesh/result";
import type { Temporal } from "@syncmesh/temporal";

import { useEffect, useState } from "react";

import type { DevtoolsSource, DevtoolsWrite } from "../contract.js";

import { Panel, Ring, Row } from "../react/primitives/index.js";
import { SPACE } from "../tokens.js";
import { note } from "./format.js";
import { FONT_MONO, shortPeer, since } from "./link-kit.js";

/**
 * Who holds a write, and since when.
 *
 * Not on {@link DevtoolsSource} yet: `$operations.receiptsOf(peer, seq)` is the read behind it and
 * the contract carries no member for it, so the panel takes it as an optional extra and says so
 * where the table would have been rather than drawing an empty one.
 */
export interface DevtoolsReceipt {
  readonly holder: PeerId;
  readonly at: Temporal.Instant;
}

const CANNOT_ASK = note(
  "Custody cannot be read here",
  "This source carries no reader for receipts, so who holds a write cannot be shown. The read behind it is $operations.receiptsOf(peer, seq); a host that wires it in gets this table.",
);

export interface CustodyProps {
  readonly source: Pick<DevtoolsSource, "links"> & {
    readonly receiptsOf?:
      | ((write: DevtoolsWrite) => Promise<Result<readonly DevtoolsReceipt[], StoreFailure>>)
      | undefined;
  };
  readonly chosen: DevtoolsWrite | undefined;
  readonly nowMs: number;
}

/** Who holds the selected write, as a share of the peers this device knows about. */
export function Custody({ source, chosen, nowMs }: CustodyProps) {
  const ask = source.receiptsOf;
  const [held, setHeld] = useState<readonly DevtoolsReceipt[]>([]);
  useEffect(() => {
    setHeld([]);
    if (ask === undefined || chosen === undefined) return;
    let live = true;
    void ask(chosen).then((answer) => {
      if (live && answer.isOk()) setHeld(answer.value);
    });
    return () => {
      live = false;
    };
  }, [ask, chosen]);

  const known = Math.max(source.links().peers.length, held.length, 1);
  const empty = note(
    chosen === undefined ? "No write selected" : "Nobody holds this yet",
    chosen === undefined
      ? "Choose a write above to see which peers have acknowledged holding it."
      : "No peer has acknowledged holding this write yet, which is exactly what unsettled means. A receipt appears when a cursor exchange covers the event; until then the write exists only on this device.",
  );

  if (ask === undefined)
    return (
      <Panel padded={false} subtitle="delivery, never approval" title="Custody">
        {CANNOT_ASK}
      </Panel>
    );
  return (
    <Panel subtitle="delivery, never approval" title="Custody">
      <div style={{ display: "flex", alignItems: "center", gap: SPACE.xl, minWidth: 0 }}>
        <Ring
          display={`${held.length}/${known}`}
          label="holders"
          max={known}
          severity={held.length === 0 ? "muted" : "ok"}
          value={held.length}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {held.length === 0 ? empty : null}
          {held.map((receipt) => (
            <Row
              key={receipt.holder}
              label={<span style={{ fontFamily: FONT_MONO }}>{shortPeer(receipt.holder)}</span>}
              severity="ok"
              trailing={`held ${since(receipt.at.epochMilliseconds, nowMs)}`}
            />
          ))}
        </div>
      </div>
    </Panel>
  );
}
