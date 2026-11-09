import type { Coverage, Cursors, Engine, Interest, Snapshot } from "@syncmesh/engine";
import type { KeyedRecord, LineageCellRefused, PeerId, SeqNum } from "@syncmesh/kernel";

import { narrows, scopeFrom } from "@syncmesh/engine";
import {
  decodeSnapshotPage,
  encodeRecord,
  encodeSnapshotPage,
  verifyCheckpoint,
  type SnapshotPage,
} from "@syncmesh/wire";

import type { SnapshotDocs } from "./join-docs.js";
import type { SnapshotFrame } from "./snap-frame.js";
import type { Withheld } from "./withheld.js";

import { adoptAfterDocs, carriedDocs, fittedPage } from "./join-docs.js";
import { snapAckFrame, snapChunkFrame, snapManifestFrame, snapRequestFrame } from "./snap-frame.js";
import { servable } from "./withheld.js";

/**
 * The join exchange, both sides of it (RFC-0019). A device asks for state rather than history,
 * gets a manifest saying what is coming, takes the rows a page at a time, and adopts the coverage
 * **only** once every page the manifest named has arrived.
 *
 * That ordering is the whole safety of the design. Adopting the coverage is what stops the device
 * ever asking for those events again, so a snapshot that is incomplete for its scope and adopted
 * anyway loses the missing rows forever. Nothing is installed until the set is whole, and the ack
 * that closes the exchange either says "installed" or names the pages that never came.
 *
 * **A lost page.** The receiver notices at the last page it was told to expect and asks for the
 * gaps by index; the sender re-sends exactly those. If the *last* page is what went missing there
 * is nothing left to notice it with, and the recovery is the one every other frame already has —
 * the link dropped, and the next session re-requests.
 *
 * **Only an answer is taken.** Every request queues the policy its install runs under, and each
 * manifest takes the oldest one (D46). A manifest that arrives with nothing queued was not asked
 * for: it is dropped, and its pages with it, so no peer can install state, or adopt coverage, on
 * a device that never asked. The queue is sound because every frame on this exchange comes from
 * the one far side the requests went to, which answers them in order over an ordered link; a
 * lost frame drops the link, and the queue goes with the session.
 *
 * **A snapshot is unsigned.** The rows arrive without the per-event signatures the log carries,
 * so a device that joined this way holds state it cannot itself prove. The install is reported as
 * provisional, which is the honest state of it until the events behind it are seen (RFC-0019
 * "Who vouches for a snapshot?").
 */

/** What a completed join installed, and whether anything vouched for it. */
export interface SnapshotInstalled {
  readonly rows: number;
  /** The slice the rows were complete for; absent means the sender's whole state. */
  readonly scope?: Interest;
  /**
   * The rows arrived with nothing to check them against: no per-event signatures, and either no
   * checkpoint certificate or one this device could not verify. A verified certificate (book
   * ch. 4) is what makes this `false` — the authority signed *which state* this is, and the
   * hash over the installed rows matched.
   */
  readonly provisional: boolean;
}

export interface JoinDeps {
  readonly engine: Engine;
  readonly send: (what: string, bytes: Uint8Array) => void;
  /** Rows per page. Small enough that one page is a reasonable write on a slow radio. */
  readonly rowsPerChunk?: number;
  readonly onSnapshot?: (installed: SnapshotInstalled) => void;
  /**
   * A snapshot every page of which arrived, refused whole by the engine — it holds a lineage cell
   * of a rule this build does not run (RFC-0023 §16.1). Nothing was installed or adopted.
   */
  readonly onRefused?: (refused: LineageCellRefused) => void;
  /** Distinguishes one exchange from another; the sender picks it. */
  readonly idPrefix: string;
  /**
   * This device's own checkpoint certificate, to relay with the state it sends. A peer holds the
   * authority's unchanged and cannot re-sign it, which is the point: it may forward a checkpoint
   * it could never have minted.
   */
  readonly certificate?: () => Uint8Array | undefined;
  /**
   * Whose certificate this device will believe — the issuer pinned in config, exactly as grants
   * are. Absent, no certificate is checked and every install stays provisional, which is the
   * honest state of an ungranted mesh.
   */
  readonly trust?: PeerId;
  /**
   * What a request is served under: what it asked for, cut to what the asker may read (D40).
   * Absent, it is served what it asked for — an ungranted mesh.
   */
  readonly serves?: (asked: Interest | undefined) => Interest | undefined;
  /**
   * The documents behind the rows: served as checkpoints in each page, and installed after the
   * rows of a snapshot taken here. Absent, pages carry rows alone (version 1), and a schema with
   * document columns adopts no coverage below a peer's floor (D46).
   */
  readonly docs?: SnapshotDocs;
  /**
   * The gated tables (D24): a snapshot served from here carries none of their rows and claims none
   * of the authority's run — a certificate over the whole state no longer covers it, so the install
   * stays provisional, which is the honest state of a slice nobody signed.
   */
  readonly withheld?: Withheld;
}

/**
 * What an install answering one request may adopt, decided by whoever asked (D46).
 *
 * `adoptUnvouched` is the one choice the two original callers make. A request prompted by a
 * peer's compaction floor adds `floor`: the authors this device is below and the floor the peer
 * claimed for each. Then an unvouched install, where allowed at all, adopts per author at most
 * that floor, for those authors only; a vouched one adopts what the certificate signs, as any
 * vouched install does; and on a schema with document columns nothing is adopted unless every page
 * carried a checkpoint for each of its documents and each installed (E30 P5): rows alone do not
 * stand for the doc updates the floor removed.
 */
export interface JoinPolicy {
  readonly adoptUnvouched: boolean;
  readonly floor?: Cursors;
  /** Told what the install came to; never called for an exchange still open when the session ends. */
  readonly settled?: (outcome: JoinOutcome) => void;
}

/** How one requested install ended. */
export type JoinOutcome =
  | {
      readonly kind: "installed";
      readonly installed: SnapshotInstalled;
      /** Whether a certificate from `trust` matched the rows. */
      readonly vouched: boolean;
    }
  | { readonly kind: "refused"; readonly refused: LineageCellRefused };

/** A join in progress: what was promised, and the pages that have arrived so far. */
interface Incoming {
  readonly chunks: number;
  readonly at: Cursors;
  readonly scope?: Interest;
  readonly pages: Map<number, SnapshotPage>;
  /** The sender's relayed certificate, verified against the rows once they are all here. */
  readonly certificate?: Uint8Array;
  /** The asker's policy for this exchange, taken from the queue when the manifest arrived. */
  readonly policy: JoinPolicy;
}

/** The pages of a join that has all of them, in the order the manifest numbered them. */
const inOrder = (held: Incoming) =>
  [...Array(held.chunks).keys()].flatMap((i) => {
    const page = held.pages.get(i);
    return page === undefined ? [] : [page];
  });

export interface JoinExchange {
  /**
   * Asks the far side for state instead of history, narrowed to what this device wants.
   *
   * `adoptUnvouched` decides what happens when the state arrives with nothing to check it
   * against, and it belongs to whoever asked rather than to this file, because the two callers
   * want opposite things. A rebuild is the last resort for a replica whose fold will not
   * converge: replaying is the broken thing, so it takes the coverage and stops asking for
   * history — that is the point of it. A device joining because it happens to be empty has no
   * such problem, and buying its way out of verification with state nobody signed for would
   * retire the signatures that were going to check it.
   */
  readonly request: (interest?: Interest, adoptUnvouched?: boolean) => void;
  /** The same ask under a whole {@link JoinPolicy}: what a device below a peer's floor sends (D46). */
  readonly requestUnder: (interest: Interest | undefined, policy: JoinPolicy) => void;
  /** One arriving frame of the exchange; anything else is not ours. */
  readonly dispatch: (frame: SnapshotFrame) => Promise<void>;
}

export function createJoinExchange(deps: JoinDeps): JoinExchange {
  const { engine, send, onSnapshot, idPrefix, certificate, trust } = deps;
  const rowsPerChunk = deps.rowsPerChunk ?? 500;
  const incoming = new Map<string, Incoming>();
  /** The pages each exchange sent, kept so a page named as missing can be sent again. */
  const outgoing = new Map<string, readonly Uint8Array[]>();
  let exchanges = 0;
  /**
   * One policy per request still unanswered, oldest first. There is no default: an empty queue
   * means nobody asked, and never "adopt".
   */
  const asked: JoinPolicy[] = [];

  /** Answers a request with a manifest and then the pages, which is the whole of the sending side. */
  const serve = (interest: Interest | undefined): Promise<void> | undefined => {
    const snapshot = heldScope(
      engine.coverage(),
      interest,
      servable(
        deps.withheld,
        interest === undefined ? engine.snapshot() : engine.snapshot({ interest }),
      ),
    );
    const pages: (readonly KeyedRecord[])[] = [];
    for (let i = 0; i < snapshot.rows.length; i += rowsPerChunk)
      pages.push(snapshot.rows.slice(i, i + rowsPerChunk));
    const id = `${idPrefix}:${(exchanges += 1)}`;
    // the manifest goes out now, in the order requests came; the pages follow once built
    send(
      "snap-manifest",
      snapManifestFrame(
        id,
        pages.length,
        snapshot.rows.length,
        snapshot.coverage.synced,
        snapshot.scope,
        certificate?.(),
      ),
    );
    const sendPages = (encoded: readonly Uint8Array[]) => {
      outgoing.set(id, encoded);
      encoded.forEach((bytes, index) => send("snap-chunk", snapChunkFrame(id, index, bytes)));
    };
    const { docs } = deps;
    if (docs === undefined) {
      sendPages(pages.map((rows) => encodeSnapshotPage({ rows })));
      return undefined;
    }
    return Promise.all(pages.map(async (rows) => fittedPage(rows, await docs.serve(rows)))).then(
      sendPages,
    );
  };

  const onManifest = (frame: Extract<SnapshotFrame, { kind: "snap-manifest" }>): void => {
    const policy = asked.shift();
    // nobody asked: nothing installs and nothing is adopted, and the pages that follow find no
    // exchange to land in (gaps U20)
    if (policy === undefined) return;
    const base = { chunks: frame.chunks, at: frame.at, pages: new Map(), policy };
    const started =
      frame.certificate === undefined ? base : { ...base, certificate: frame.certificate };
    const held: Incoming = frame.scope === undefined ? started : { ...started, scope: frame.scope };
    incoming.set(frame.id, held);
    // an empty snapshot has no pages to wait for, so it is already complete
    if (frame.chunks === 0) void complete(frame.id, held);
  };

  const onChunk = async (frame: Extract<SnapshotFrame, { kind: "snap-chunk" }>): Promise<void> => {
    const held = incoming.get(frame.id);
    // a page for an exchange we were never told about: the manifest is what says it is coming
    if (held === undefined) return;
    // a page past the manifest's count is no page of it: counted, it would complete the set
    // with a real page still missing (gaps U35)
    if (frame.index >= held.chunks) return;
    const page = decodeSnapshotPage(frame.bytes);
    // an unreadable page is a missing page — the ack names it and the sender sends it again
    if (page.isOk()) held.pages.set(frame.index, page.value);
    if (held.pages.size === held.chunks) return complete(frame.id, held);
    // the last page the manifest named has come and something is still short: ask for the gaps
    if (frame.index === held.chunks - 1) {
      const missing = [...Array(held.chunks).keys()].filter((i) => !held.pages.has(i));
      send("snap-ack", snapAckFrame(frame.id, missing));
    }
  };

  /**
   * Every page is here: install as one, adopt the coverage last, and close the exchange.
   *
   * **The rows and the coverage are two different claims, and only one of them needs vouching.**
   * The rows merge through the same field-level merge every other source goes through, so an
   * unvouched snapshot cannot corrupt anything a verified event later contradicts — a newer
   * stamp still wins. Adopting the *coverage* is the irreversible half: it is the statement "I
   * hold every event up to N from this author", and it is what stops this device ever asking for
   * those events as history. Bought with state nobody signed for, it would retire the very
   * signatures that would have checked it.
   *
   * So an unvouched install offers this device's own coverage back — `adopt` only ever raises a
   * cursor, so that advances nothing — and the rows become a head start rather than a substitute
   * for verification. The history still arrives, still verifies, and merges over the top.
   */
  const complete = async (id: string, held: Incoming): Promise<void> => {
    const pages = inOrder(held);
    const rows = pages.flatMap((page) => [...page.rows]);
    const carried = carriedDocs(pages, deps.docs !== undefined);
    const signed = certified(held, rows);
    const vouched = signed !== undefined;
    // every page said it holds a checkpoint for each of its documents: those, installed, stand
    // for the doc updates a floor removed, and the coverage may be adopted after them (E30 P5)
    const wanted = adopted(held, signed, engine.hasDocColumns() && !carried.complete);
    // below a floor, documents gate the adoption: it waits on their checkpoints
    const gated = wanted !== undefined && held.policy.floor !== undefined && engine.hasDocColumns();
    const installed = await installRows(held, gated ? undefined : wanted, rows);
    incoming.delete(id);
    // every page came, so the exchange is closed either way: a refused one is not sent again
    send("snap-ack", snapAckFrame(id, []));
    if (installed.isErr()) {
      held.policy.settled?.({ kind: "refused", refused: installed.error });
      return deps.onRefused?.(installed.error);
    }
    const adoption = await adoptAfterDocs(deps.docs, rows, carried, gated, () =>
      installRows(held, wanted, []),
    );
    if (adoption.isErr()) deps.onRefused?.(adoption.error);
    const plain = { rows: installed.value.rows, provisional: !vouched };
    const report = held.scope === undefined ? plain : { ...plain, scope: held.scope };
    onSnapshot?.(report);
    held.policy.settled?.({ kind: "installed", installed: report, vouched });
  };

  /** Installs `rows`, adopting `synced` after them when given and this device's own coverage when not. */
  const installRows = (
    held: Incoming,
    synced: Cursors | undefined,
    rows: readonly KeyedRecord[],
  ) => {
    // `local` stays empty: a device's own local-only events never travel, so a snapshot has
    // nothing to say about them and adopting a floor for them would be a claim it cannot make
    const coverage = synced === undefined ? engine.coverage() : { synced, local: new Map() };
    const base = { rows, coverage };
    // the scope travels with the coverage it qualifies, so an install that adopts nothing keeps
    // neither
    const snapshot: Snapshot =
      synced !== undefined && held.scope !== undefined ? { ...base, scope: held.scope } : base;
    return engine.installSnapshot(snapshot);
  };

  /**
   * The coverage the authority signed for exactly this state, or `undefined` when nothing vouches
   * for it. Both halves have to hold: the signature is the issuer's, and the rows hash to what it
   * covers — a relayed certificate over altered rows fails the second even though it passes the
   * first.
   */
  const certified = (
    held: Incoming,
    rows: readonly KeyedRecord[],
  ): ReadonlyMap<PeerId, number> | undefined => {
    if (held.certificate === undefined || trust === undefined) return undefined;
    const hashed = rows.map((row) => ({
      table: String(row.table),
      key: String(row.key),
      record: encodeRecord(row.record),
    }));
    const verified = verifyCheckpoint(held.certificate, trust, hashed);
    return verified.isOk() ? verified.value.coverage : undefined;
  };

  const onAck = (frame: Extract<SnapshotFrame, { kind: "snap-ack" }>): void => {
    const pages = outgoing.get(frame.id);
    if (pages === undefined) return;
    if (frame.missing.length === 0) {
      outgoing.delete(frame.id);
      return;
    }
    for (const index of frame.missing) {
      const page = pages[index];
      if (page !== undefined) send("snap-chunk", snapChunkFrame(frame.id, index, page));
    }
  };

  return {
    request: (interest, adoptUnvouched = true) => {
      // queued until the manifest it triggers arrives: the exchange id is the sender's, so this
      // side cannot tie one to its own ask — order is what ties them
      asked.push({ adoptUnvouched });
      send("snap-req", snapRequestFrame(interest));
    },
    requestUnder: (interest, policy) => {
      asked.push(policy);
      send("snap-req", snapRequestFrame(interest));
    },
    dispatch: async (frame) => {
      switch (frame.kind) {
        case "snap-req":
          return serve(deps.serves === undefined ? frame.interest : deps.serves(frame.interest));
        case "snap-manifest":
          return onManifest(frame);
        case "snap-chunk":
          return onChunk(frame);
        case "snap-ack":
          return onAck(frame);
      }
    },
  };
}

/**
 * The synced coverage an install adopts, or `undefined` for none (D46's table). A vouched install
 * adopts per author the lower of what the manifest claimed and what the certificate signs: the
 * manifest's `at` is unsigned, so only the signed coverage can retire history. Without a floor an
 * unvouched install adopts everything the sender claimed when the asker took unvouched state.
 * With a floor, unvouched state adopts per author at most the claimed floor, and a schema with
 * document columns adopts nothing at all when `docs` says the pages did not carry its documents.
 */
const adopted = (
  held: Incoming,
  signed: ReadonlyMap<PeerId, number> | undefined,
  docs: boolean,
): Cursors | undefined => {
  const { policy, at } = held;
  if (policy.floor !== undefined && docs) return undefined;
  if (signed !== undefined) return lower(at, signed);
  if (!policy.adoptUnvouched) return undefined;
  return policy.floor === undefined ? at : lower(at, policy.floor);
};

/** Per author named by `cap`, the lower of `at` and `cap`; an author either leaves out is dropped. */
const lower = (at: Cursors, cap: ReadonlyMap<PeerId, number>): Cursors => {
  const bounded = new Map<PeerId, SeqNum>();
  for (const [author, limit] of cap) {
    const claimed = at.get(author) ?? 0;
    // SAFETY: the lower of two sequence numbers is one of them
    const capped = (claimed < limit ? claimed : limit) as SeqNum;
    if (capped > 0) bounded.set(author, capped);
  }
  return bounded;
};

/**
 * What the sender may claim for a request: its coverage only where it holds the asked slice. A
 * sender whose own cursors are scoped (D23) to a slice the asked interest is not inside claims
 * nothing, so a receiver never adopts an `at` for rows the sender never held (D46).
 *
 * A sender whose own cursors were adopted under a window claims nothing for any request: events
 * are never windowed, so an update to a row it never held folds into a row it holds in part, and
 * that row then ranks among its newest. Its window is not a window of whole rows (D23).
 */
const heldScope = (own: Coverage, asked: Interest | undefined, snapshot: Snapshot): Snapshot => {
  if (own.scope === undefined) return snapshot;
  const held = scopeFrom(own.scope).interest;
  if (held?.window === undefined && narrows(asked, held)) return snapshot;
  return { ...snapshot, coverage: { synced: new Map(), local: new Map() } };
};
