import type { Watermark } from "@syncmesh/cdc";
import type { Brand } from "@syncmesh/kernel";

import { parseWatermark } from "@syncmesh/cdc";
import { Result, TaggedError } from "@syncmesh/result";

/** A position in Postgres's write-ahead log: an unsigned 64-bit byte offset. */
export type Lsn = Brand<bigint, "Lsn">;

export class InvalidLsn extends TaggedError("InvalidLsn")<{
  input: string;
  message: string;
}> {}

const MAX = (1n << 64n) - 1n;
const TEXT = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/;
const WATERMARK = /^[0-9A-F]{16}$/;

/** An LSN from a 64-bit integer; the one place a bigint becomes one. */
export function lsnFrom(value: bigint): Result<Lsn, InvalidLsn> {
  if (value < 0n || value > MAX) {
    return Result.err(
      new InvalidLsn({ input: value.toString(), message: "an LSN is an unsigned 64-bit offset" }),
    );
  }
  // SAFETY: range-checked to the unsigned 64 bits an LSN is
  return Result.ok(value as Lsn);
}

/** An LSN from Postgres's own `X/Y` text, as `pg_lsn` prints it. */
export function parseLsn(input: string): Result<Lsn, InvalidLsn> {
  const parts = TEXT.exec(input);
  if (parts === null) {
    return Result.err(new InvalidLsn({ input, message: `"${input}" is not an X/Y LSN` }));
  }
  return lsnFrom((BigInt(`0x${parts[1]}`) << 32n) | BigInt(`0x${parts[2]}`));
}

/** The `X/Y` text Postgres reads in `START_REPLICATION` and prints in `pg_replication_slots`. */
export const lsnText = (lsn: Lsn): string =>
  `${(lsn >> 32n).toString(16).toUpperCase()}/${(lsn & 0xffffffffn).toString(16).toUpperCase()}`;

/**
 * The watermark an LSN is filed under: sixteen upper-case hex digits, zero-padded, so that
 * lexicographic order is LSN order — the port's one assumption. `X/Y` text does not have that
 * property (`9/0` sorts after `10/0`), which is why it is never the watermark.
 */
export const lsnWatermark = (lsn: Lsn): Watermark =>
  parseWatermark(lsn.toString(16).toUpperCase().padStart(16, "0")).unwrap();

/** The LSN a watermark this source wrote stands for; anything else is refused. */
export function parseLsnWatermark(watermark: Watermark): Result<Lsn, InvalidLsn> {
  if (!WATERMARK.test(watermark)) {
    return Result.err(
      new InvalidLsn({ input: watermark, message: `"${watermark}" is not a Postgres watermark` }),
    );
  }
  return lsnFrom(BigInt(`0x${watermark}`));
}
