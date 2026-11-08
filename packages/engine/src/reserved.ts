import type { Change, PeerId } from "@syncmesh/kernel";

import { Result } from "@syncmesh/result";
import { type Table } from "@syncmesh/schema";

import type { ProbeEvent } from "./validate.js";

import { checkLink } from "./accounts.js";
import { RESERVED_AUTHOR_CLASS, UNPINNED_RESERVED } from "./authority.js";
import { checkColumns } from "./columns.js";
import { refuseReservedDoc } from "./doc-rules.js";
import { ReadOnlyPartition, UnknownTable, WrongPartition, type ValidationError } from "./errors.js";

/**
 * The manifest's own tables, held to whichever signature their **author class** names — a lookup
 * on the table, never a check of its name, so a new reserved table has to choose deliberately
 * rather than inherit whatever rule happened to be written here. Their columns are checked
 * either way; their partition is whatever instance they govern, which is the point of them.
 */
export function checkReserved(
  table: string,
  change: Change,
  event: ProbeEvent,
  reserved: ReadonlyMap<string, Table>,
  authority: PeerId | undefined,
): Result<void, ValidationError> {
  const definition = reserved.get(table);
  if (definition === undefined)
    return Result.err(new UnknownTable({ table, message: "not in the schema" }));
  if (UNPINNED_RESERVED.has(table) && event.partition !== undefined) {
    return Result.err(
      new WrongPartition({ table, expected: "", message: `${table} is about no instance` }),
    );
  }
  const authored =
    RESERVED_AUTHOR_CLASS.get(table) === "subject"
      ? checkLink(change, event)
      : checkAuthored(table, event, authority);
  if (authored.isErr()) return authored;
  if (change.kind === "doc") return refuseReservedDoc(table, change);
  return checkColumns(definition, change);
}

/**
 * The authority's class: rules and corrections, which a device that could write them could use
 * to grant itself anything or to forge the authority's verdict. Checked by authorship, so a
 * forged row is refused at its own author and again at every peer that receives it.
 */
function checkAuthored(
  table: string,
  event: ProbeEvent,
  authority: PeerId | undefined,
): Result<void, ValidationError> {
  if (authority === undefined || event.peerId !== authority) {
    return Result.err(
      new ReadOnlyPartition({ table, message: `${table} is written by the authority` }),
    );
  }
  return Result.ok(undefined);
}
