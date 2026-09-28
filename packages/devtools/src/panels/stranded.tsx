import type { StoreFailure } from "@syncmesh/engine";
import type { Result } from "@syncmesh/result";

import { useEffect, useState } from "react";

import type { DevtoolsSource, DevtoolsStranded } from "../contract.js";

import { Icon } from "../react/icons.js";
import { Panel, Row } from "../react/primitives/index.js";
import { COLOR, SPACE, TEXT } from "../tokens.js";
import { note } from "./format.js";
import { FONT_MONO, shortPeer } from "./link-kit.js";

/**
 * Writes this device holds and will never hand to anybody.
 *
 * Beside the ledger rather than in the quarantine, because the two are opposites and get confused
 * for each other constantly. A quarantined event is one this build **refused to fold**: it is not
 * in the state, somebody may yet be waiting for it, and a grant or a newer build can still move
 * it. A stranded one **folded**: its rows are on the screen, this is the only copy of them there
 * will ever be, and nothing will move it, ever.
 *
 * What puts a run here is a key rotation over a log that was kept. The device wrote under one
 * identity, took another, and the writes it had not yet handed to a peer became writes it is no
 * longer the author of — no signature on them, and no key here that may make one. Everything
 * about that is invisible from the state: every last-writer-wins column reads identically on a
 * device missing a whole author, because the surviving writes carry the same values. It takes a
 * PN-counter to see it at all, which is why it needs a panel and not a log line.
 *
 * Nothing here offers to fix it, and that is the finding rather than a gap — see
 * `StrandedWrites` for why re-signing would be re-authoring, and would double the divergence it
 * looks like it repairs.
 */

/** What the panel reads: one required member, so a source cannot be quiet about this one. */
export type StrandedSource = Pick<DevtoolsSource, "stranded">;

/**
 * Asked once, never subscribed.
 *
 * A rotation over a kept log happens between processes and never during one, so this set is
 * fixed before the first frame is drawn and cannot grow while a panel is open. A channel for it
 * would be a subscription that never fires, on a seam whose whole design is that a panel holds
 * exactly one.
 */
export function useStranded(source: StrandedSource) {
  const read = source.stranded;
  const [held, setHeld] = useState<Result<readonly DevtoolsStranded[], StoreFailure> | undefined>(
    undefined,
  );
  useEffect(() => {
    let live = true;
    void read().then((answer) => {
      if (live) setHeld(answer);
    });
    return () => {
      live = false;
    };
  }, [read]);
  return held;
}

const NOTHING_STRANDED = note(
  "Nothing stranded",
  "Every write in this log is one a key on this device can still sign for. This is the ordinary answer, and the only way out of it is rotating a device key over a log that was kept.",
);

const CANNOT_READ = (why: string) =>
  note(
    "The log could not be audited",
    `${why} — this read walks the log for entries nobody here can sign, so a refusal means the database went away rather than that the writes did.`,
    <Icon name="close" size={20} />,
  );

const NOTE = { ...TEXT.xs, color: COLOR.textFaint, margin: 0, padding: SPACE.md };

const EXPLAIN =
  "These writes folded: their rows are in this device's state and are the only copy of them there will ever be. They carry no signature and no key here can make one, so no peer will ever be offered them and no retry changes that. Nothing repairs this — re-signing them under the current key would mint a second identity for a write that already landed, and a per-author counter would add both up. What is left is the choice: accept the divergence, or rebuild this replica from a peer that has the rest.";

export interface StrandedProps {
  /** What {@link useStranded} answered; taken as a prop so the count above it reads the same audit. */
  readonly held: Result<readonly DevtoolsStranded[], StoreFailure> | undefined;
}

/** One row per retired author: which identity went quiet, and how much went with it. */
export function Stranded({ held }: StrandedProps) {
  const runs = held === undefined || held.isErr() ? [] : held.value;

  return (
    <Panel padded={false} subtitle="held here, deliverable nowhere" title="Stranded writes">
      {held?.isErr() === true ? CANNOT_READ(held.error.message) : null}
      {held?.isOk() === true && runs.length === 0 ? NOTHING_STRANDED : null}
      {runs.map((run) => (
        <Row
          key={run.author}
          label={<span style={{ fontFamily: FONT_MONO }}>{shortPeer(run.author)}</span>}
          meta={`seq ${run.from}–${run.to} · retired identity`}
          severity="critical"
          trailing={`${run.count} event${run.count === 1 ? "" : "s"}`}
        />
      ))}
      {runs.length > 0 ? <p style={NOTE}>{EXPLAIN}</p> : null}
    </Panel>
  );
}
