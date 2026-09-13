import type { OperationRecord, SyncState } from "@syncmesh/react";

/**
 * **What the header says about a write, which is usually nothing.**
 *
 * The detail panel used to print the row's reach and the write's outcome side by side, always:
 * `local`, then `delivered · applied` a moment later. Both facts are real and the badge was never
 * lying — but it was answering a question nobody in the product had asked, in two words only
 * somebody who had read the engine could parse, and it changed on **every open**, because opening
 * an issue was itself a write. The first person to look at it read the flicker as a bug.
 *
 * So it is an exception report now. `delivered · applied` is the ordinary end of every write and
 * is worth no pixels; what is worth pixels is a write that has **not left this device**, which is
 * the one state where what a person does next matters, and a write an authority **overruled**,
 * which is the one state where what they believe is wrong. Everything else — the whole trace, per
 * write, with the operation record behind it — is in the inspector's Writes panel, which is where
 * a fact that needs the engine's vocabulary belongs.
 *
 * `undefined` in, `undefined` out: a reach not read yet and an operation not read yet are both
 * *not knowing*, and a badge that guessed would be the one thing on this screen that is not a
 * fact.
 */

export interface SyncNote {
  readonly label: string;
  /** The sentence behind the label, on hover — the same fact, for somebody who wants the detail. */
  readonly detail: string;
  readonly severity: "pending" | "critical";
}

const NOT_SENT = {
  label: "On this device only",
  detail:
    "This write is in this device's log and no peer has acknowledged it yet. Nothing is lost — it " +
    "goes out by itself when a peer is reachable — but nobody else can see it until then.",
  severity: "pending",
} satisfies SyncNote;

/**
 * The row's reach and the write's outcome, reduced to the one thing worth saying — or nothing.
 *
 * The outcome is checked first. A write an authority overruled is the more important of the two
 * facts even while it is still local, because "not sent yet" invites waiting and this one is not
 * going to resolve by waiting.
 */
export function syncNote(
  state: SyncState | undefined,
  record: OperationRecord | undefined,
): SyncNote | undefined {
  if (record?.status === "blocked" || record?.status === "superseded") {
    const because = record.correction?.reason;
    return {
      label: record.status === "blocked" ? "Refused" : "Overruled",
      detail:
        because === undefined
          ? `The mesh recorded this write as ${record.status}: what this device asked for is not what was kept.`
          : `An authority overruled this write: ${because}`,
      severity: "critical",
    };
  }
  return state === "local" ? NOT_SENT : undefined;
}
