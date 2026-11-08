import { useMemo } from "react";

import type { OperationRecord, OperationRef, OperationRefusal } from "./use-operation.js";

import { useOperation } from "./use-operation.js";

/**
 * What one refusal says about the write, read the way D32 says to read it:
 *
 * - `refused` — the refuser's ladder said no (`NoGrant`, `GrantStale`, `PolicyDenied`, …).
 * - `older-build` — `unknown-table` or `unknown-kind`: the refuser cannot read the write *yet*.
 *   Never shown as a refusal: nothing is wrong with the write, somebody has not upgraded.
 * - `newer-build` — `refused` with `TableDropped` (D31): the refuser's build dropped the table,
 *   and upgrading *this* device is the remedy.
 */
export type RefusedByKind = "refused" | "older-build" | "newer-build";

/** One refuser's verdict on one write, as a line the author's screen can show (D32, G12). */
export interface RefusedBy {
  /** The refuser's peer id. One line per refuser: three older builds are one fact, not three. */
  readonly by: string;
  readonly kind: RefusedByKind;
  /** The tag the refuser signed; with more than one from the same refuser, the first. */
  readonly verdict: string;
  /** Whether the refuser is the authority the app named — the one whose no becomes a correction. */
  readonly authority: boolean;
  /** A sentence this build wrote from the tag. A refusal carries no prose, and none is shown. */
  readonly text: string;
}

export interface RefusedByOptions {
  /** The authority's peer id, as the app configured it; its refusal is put first and named. */
  readonly authority?: string;
  /** How a refuser is named on screen. Default its first eight hex digits and an ellipsis. */
  readonly name?: (peer: string) => string;
}

const shortName = (peer: string): string => `${peer.slice(0, 8)}…`;

const refusalKind = ({ reason, verdict }: OperationRefusal): RefusedByKind => {
  if (reason === "unknown-table" || reason === "unknown-kind") return "older-build";
  return verdict === "TableDropped" ? "newer-build" : "refused";
};

const sentence = (who: string, kind: RefusedByKind, verdict: string): string => {
  if (kind === "older-build") return `${who} is on an older build and cannot read this yet`;
  if (kind === "newer-build") return `${who} is on a newer build that dropped this table`;
  return `${who} refused this (${verdict})`;
};

/**
 * A write's refusals as lines to render: one per refuser, the authority first, each with a
 * sentence this build wrote from the signed tag (D32 §6). Information only — a line here never
 * means the write is undone, and nothing should gate on it.
 *
 * Pure: the same refusals give the same lines, so it runs in a render or anywhere else.
 *
 * @example
 * for (const line of refusedBy(record, { authority: OFFICE })) console.log(line.text);
 * // "the authority refused this (PolicyDenied)", "3f2a19c0… is on an older build and cannot read this yet"
 */
export function refusedBy(
  record: Pick<OperationRecord, "refusals"> | undefined,
  options: RefusedByOptions = {},
): readonly RefusedBy[] {
  const name = options.name ?? shortName;
  const seen = new Map<string, RefusedBy>();
  for (const refusal of record?.refusals ?? []) {
    if (seen.has(refusal.by)) continue;
    const authority = refusal.by === options.authority;
    const kind = refusalKind(refusal);
    const who = authority ? "the authority" : name(refusal.by);
    seen.set(refusal.by, {
      by: refusal.by,
      kind,
      verdict: refusal.verdict,
      authority,
      text: sentence(who, kind, refusal.verdict),
    });
  }
  // the authority's no first: it is a different fact from a laptop's, and the screen says which
  return [...seen.values()].sort((a, b) => Number(b.authority) - Number(a.authority));
}

const NONE: readonly RefusedBy[] = [];

/**
 * {@link refusedBy} over one operation's ref, as React state: the lines change when a refusal
 * lands or a refuser's later custody retires one, and keep their identity otherwise.
 *
 * ```tsx
 * const refusals = useRefusedBy(client.$operations.get(operationId), { authority: OFFICE });
 * {refusals.map((line) => <p key={line.by} data-kind={line.kind}>{line.text}</p>)}
 * ```
 */
export function useRefusedBy<O extends OperationRecord>(
  ref: OperationRef<O> | undefined,
  options: RefusedByOptions = {},
): readonly RefusedBy[] {
  const record = useOperation(ref);
  const { authority, name } = options;
  return useMemo(() => {
    if (record?.refusals === undefined) return NONE;
    const named = name === undefined ? {} : { name };
    return refusedBy(record, authority === undefined ? named : { ...named, authority });
  }, [record, authority, name]);
}
