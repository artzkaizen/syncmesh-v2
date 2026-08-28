import { Result, TaggedError } from "@syncmesh/result";

/**
 * A whole frame across a radio that carries a couple of hundred bytes at a time.
 *
 * A `FrameLink` promises whole frames in and whole frames out; BLE offers characteristic writes
 * bounded by whatever MTU the two devices negotiated. Everything between those two facts lives
 * here, and nowhere else — the transport above deals in frames and never sees a fragment.
 *
 * **Every fragment carries a header, including the only one of a short frame.** The alternative
 * is sending short frames bare and sniffing for a magic prefix on arrival, which is how a frame
 * whose first bytes happen to look like a header gets read as something it is not. Eight bytes on
 * a message that already costs a radio round trip is not worth an ambiguity.
 */

/** `[u32 message][u16 index][u16 total]`, big-endian. */
export const HEADER_BYTES = 8;

/** One message's fragments must fit `u16`, which at any real MTU is far more than a frame needs. */
const MAX_FRAGMENTS = 0xffff;

/** What a receiver will hold part of before it decides the sender is not worth the memory. */
export const DEFAULT_MAX_MESSAGE_BYTES = 128 * 1024;

/** Partial messages kept at once, per link. Oldest goes first, and says so. */
export const DEFAULT_MAX_ASSEMBLIES = 32;

export class FrameTooLarge extends TaggedError("FrameTooLarge")<{
  bytes: number;
  limit: number;
  message: string;
}> {}

/** The negotiated write size left no room for a header — a link this narrow cannot carry anything. */
export class LimitTooSmall extends TaggedError("LimitTooSmall")<{
  limit: number;
  message: string;
}> {}

export type FragmentError = FrameTooLarge | LimitTooSmall;

/**
 * One frame as the fragments that will carry it, sized to what *this direction* can write.
 *
 * The limit is a parameter rather than a constant because the two directions do not share one:
 * a central writes up to `maximumWriteValueLength`, and a peripheral notifies up to the smallest
 * `maximumUpdateValueLength` among its subscribers, which is typically the smaller of the two and
 * cannot be split across packets the way a long write can.
 */
export function fragment(
  frame: Uint8Array,
  limit: number,
  message: number,
): Result<readonly Uint8Array[], FragmentError> {
  const room = limit - HEADER_BYTES;
  if (room <= 0)
    return Result.err(
      new LimitTooSmall({ limit, message: `${limit} bytes leaves no room for a header` }),
    );
  const total = Math.max(1, Math.ceil(frame.length / room));
  if (total > MAX_FRAGMENTS)
    return Result.err(
      new FrameTooLarge({
        bytes: frame.length,
        limit: MAX_FRAGMENTS * room,
        message: `${frame.length} bytes needs ${total} fragments`,
      }),
    );
  const out: Uint8Array[] = [];
  for (let index = 0; index < total; index += 1) {
    const slice = frame.subarray(index * room, (index + 1) * room);
    const packet = new Uint8Array(HEADER_BYTES + slice.length);
    const header = new DataView(packet.buffer, packet.byteOffset, HEADER_BYTES);
    header.setUint32(0, message >>> 0, false);
    header.setUint16(4, index, false);
    header.setUint16(6, total, false);
    packet.set(slice, HEADER_BYTES);
    out.push(packet);
  }
  return Result.ok(out);
}

export interface ReassemblyOptions {
  readonly maxMessageBytes?: number;
  readonly maxAssemblies?: number;
  /** Told when a partial message is given up on, so a link can say so rather than lose it quietly. */
  readonly onAbandoned?: (message: number, held: number, why: "evicted" | "too-large") => void;
}

interface Partial {
  readonly total: number;
  readonly parts: Map<number, Uint8Array>;
  bytes: number;
  /**
   * Given up on, and kept as a marker so the rest of its fragments cost nothing.
   *
   * Without this a sender past the cap re-opens a fresh partial on its very next fragment and
   * blows the cap again, reporting once per fragment and re-allocating each time. The marker
   * lives in the same table, so it is bounded and evicted by the same rule as everything else.
   */
  dead?: boolean;
}

/**
 * Fragments back into frames. A frame is emitted the moment its last fragment lands, in whatever
 * order they arrived.
 *
 * **A message that never completes is dropped, and dropping it is safe.** The frame is simply
 * never delivered, so the engine above never folds it, its cursor does not move, and ordinary
 * anti-entropy asks for the event again. That is a gap which heals — as against delivering half
 * a frame, which would be a value two peers could disagree about for good.
 */
export function reassembler(options: ReassemblyOptions = {}) {
  const maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const maxHeld = options.maxAssemblies ?? DEFAULT_MAX_ASSEMBLIES;
  const held = new Map<number, Partial>();

  const abandon = (message: number, partial: Partial, why: "evicted" | "too-large"): void => {
    if (why === "evicted") held.delete(message);
    else held.set(message, { total: partial.total, parts: new Map(), bytes: 0, dead: true });
    // a marker being evicted is bookkeeping, not a loss: whatever it stood for was already
    // reported when it was given up on, and saying so twice would make the count meaningless
    if (partial.dead !== true) options.onAbandoned?.(message, partial.bytes, why);
  };

  /** Room for one more, oldest first — `Map` iterates in insertion order, so the first is it. */
  const makeRoom = (keep: number): void => {
    if (held.size <= maxHeld) return;
    for (const [message, partial] of held) {
      if (message === keep) continue;
      abandon(message, partial, "evicted");
      return;
    }
  };

  return {
    /** A fragment in; the whole frame out once the last one has landed, `undefined` before that. */
    accept: (packet: Uint8Array): Uint8Array | undefined => {
      const head = readHeader(packet);
      if (head === undefined) return undefined;
      const { message, index, total } = head;

      const existing = held.get(message);
      if (existing?.dead === true) return undefined;
      // an id reused with a different length is a sender whose counter wrapped onto a partial we
      // still hold; the newer message is the live one and the older is already unrecoverable
      const partial =
        existing !== undefined && existing.total === total
          ? existing
          : { total, parts: new Map<number, Uint8Array>(), bytes: 0 };
      if (partial !== existing) held.set(message, partial);
      if (partial.parts.has(index)) return undefined;

      const body = packet.subarray(HEADER_BYTES);
      partial.parts.set(index, body);
      partial.bytes += body.length;
      if (partial.bytes > maxBytes) {
        abandon(message, partial, "too-large");
        return undefined;
      }
      makeRoom(message);
      if (partial.parts.size !== partial.total) return undefined;
      held.delete(message);
      return join(partial);
    },
    /** Partial messages currently held — what a link reports rather than guesses about. */
    pending: () => [...held.values()].filter((p) => p.dead !== true).length,
  };
}

/** The three numbers, or `undefined` for a packet too short or claiming a fragment of nothing. */
function readHeader(
  packet: Uint8Array,
): { message: number; index: number; total: number } | undefined {
  if (packet.length < HEADER_BYTES) return undefined;
  const header = new DataView(packet.buffer, packet.byteOffset, HEADER_BYTES);
  const total = header.getUint16(6, false);
  const index = header.getUint16(4, false);
  if (total === 0 || index >= total) return undefined;
  return { message: header.getUint32(0, false), index, total };
}

/** The parts in order. `undefined` only if a part is missing, which the caller has ruled out. */
function join(partial: Partial): Uint8Array | undefined {
  const frame = new Uint8Array(partial.bytes);
  let at = 0;
  for (let i = 0; i < partial.total; i += 1) {
    const part = partial.parts.get(i);
    if (part === undefined) return undefined;
    frame.set(part, at);
    at += part.length;
  }
  return frame;
}
