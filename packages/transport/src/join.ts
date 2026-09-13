import type { Cursors, Engine, Interest, Snapshot } from "@syncmesh/engine";
import type { KeyedRecord, PeerId } from "@syncmesh/kernel";

import {
  decodeSnapshotRows,
  encodeRecord,
  encodeSnapshotRows,
  verifyCheckpoint,
} from "@syncmesh/wire";

import type { SnapshotFrame } from "./snap-frame.js";

import { snapAckFrame, snapChunkFrame, snapManifestFrame, snapRequestFrame } from "./snap-frame.js";

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
}

/** A join in progress: what was promised, and the pages that have arrived so far. */
interface Incoming {
  readonly chunks: number;
  readonly at: Cursors;
  readonly scope?: Interest;
  readonly pages: Map<number, readonly KeyedRecord[]>;
  /** The sender's relayed certificate, verified against the rows once they are all here. */
  readonly certificate?: Uint8Array;
}

export interface JoinExchange {
  /** Asks the far side for state instead of history, narrowed to what this device wants. */
  readonly request: (interest?: Interest) => void;
  /** One arriving frame of the exchange; anything else is not ours. */
  readonly dispatch: (frame: SnapshotFrame) => Promise<void>;
}

export function createJoinExchange(deps: JoinDeps): JoinExchange {
  const { engine, send, onSnapshot, idPrefix, certificate, trust } = deps;
  const rowsPerChunk = deps.rowsPerChunk ?? 500;
  const incoming = new Map<string, Incoming>();
  /** The rows each exchange sent, kept so a page named as missing can be sent again. */
  const outgoing = new Map<string, readonly (readonly KeyedRecord[])[]>();
  let exchanges = 0;

  /** Answers a request with a manifest and then the pages, which is the whole of the sending side. */
  const serve = (interest: Interest | undefined): void => {
    const snapshot = interest === undefined ? engine.snapshot() : engine.snapshot({ interest });
    const pages: (readonly KeyedRecord[])[] = [];
    for (let i = 0; i < snapshot.rows.length; i += rowsPerChunk)
      pages.push(snapshot.rows.slice(i, i + rowsPerChunk));
    const id = `${idPrefix}:${(exchanges += 1)}`;
    outgoing.set(id, pages);
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
    pages.forEach((page, index) =>
      send("snap-chunk", snapChunkFrame(id, index, encodeSnapshotRows(page))),
    );
  };

  const onManifest = (frame: Extract<SnapshotFrame, { kind: "snap-manifest" }>): void => {
    const base = { chunks: frame.chunks, at: frame.at, pages: new Map() };
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
    const rows = decodeSnapshotRows(frame.bytes);
    // an unreadable page is a missing page — the ack names it and the sender sends it again
    if (rows.isOk()) held.pages.set(frame.index, rows.value);
    if (held.pages.size === held.chunks) return complete(frame.id, held);
    // the last page the manifest named has come and something is still short: ask for the gaps
    if (frame.index === held.chunks - 1) {
      const missing = [...Array(held.chunks).keys()].filter((i) => !held.pages.has(i));
      send("snap-ack", snapAckFrame(frame.id, missing));
    }
  };

  /** Every page is here: install as one, adopt the coverage last, and close the exchange. */
  const complete = async (id: string, held: Incoming): Promise<void> => {
    const rows = [...Array(held.chunks).keys()].flatMap((i) => [...(held.pages.get(i) ?? [])]);
    // `local` stays empty: a device's own local-only events never travel, so a snapshot has
    // nothing to say about them and adopting a floor for them would be a claim it cannot make
    const base = { rows, coverage: { synced: held.at, local: new Map() } };
    const snapshot: Snapshot = held.scope === undefined ? base : { ...base, scope: held.scope };
    const installed = await engine.installSnapshot(snapshot);
    incoming.delete(id);
    send("snap-ack", snapAckFrame(id, []));
    const report = { rows: installed.rows, provisional: !vouchedFor(held, rows) };
    onSnapshot?.(held.scope === undefined ? report : { ...report, scope: held.scope });
  };

  /**
   * Whether the authority signed exactly this state. Both halves have to hold: the signature is
   * the issuer's, and the rows hash to what it covers — a relayed certificate over altered rows
   * fails the second even though it passes the first.
   */
  const vouchedFor = (held: Incoming, rows: readonly KeyedRecord[]): boolean => {
    if (held.certificate === undefined || trust === undefined) return false;
    const hashed = rows.map((row) => ({
      table: String(row.table),
      key: String(row.key),
      record: encodeRecord(row.record),
    }));
    return verifyCheckpoint(held.certificate, trust, hashed).isOk();
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
      if (page !== undefined)
        send("snap-chunk", snapChunkFrame(frame.id, index, encodeSnapshotRows(page)));
    }
  };

  return {
    request: (interest) => send("snap-req", snapRequestFrame(interest)),
    dispatch: async (frame) => {
      switch (frame.kind) {
        case "snap-req":
          return serve(frame.interest);
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
