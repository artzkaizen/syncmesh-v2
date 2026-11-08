import type { PeerId, State } from "@syncmesh/kernel";
import type { DocColumns } from "@syncmesh/kernel";

import { getRecord } from "@syncmesh/kernel";
import { Result } from "@syncmesh/result";

import type { DocAddress } from "./doc-log.js";
import type { StateLookup, Validator } from "./validate.js";

import { docEditProbe } from "./doc-rules.js";
import { DocChangeRefused, type ValidationError } from "./errors.js";

/** Who may edit a document, as an engine answers it. */
export interface DocEditorApi {
  /**
   * Whether `author` may edit the document at `doc` as this device holds its row, by the
   * validator this engine folds with: the row's `update` rule, the author's grant, its partitions
   * and revocations, exactly as a doc change from it would be judged (RFC-0023 §11). The authority
   * the validator names always may. Ok on an engine that validates nothing, which folds any
   * author's doc changes too.
   */
  readonly mayEditDoc: (author: PeerId, doc: DocAddress) => Result<void, ValidationError>;
}

export interface DocEditorDeps {
  readonly validate: Validator | undefined;
  readonly docs: DocColumns | undefined;
  readonly getState: () => State;
  readonly before: StateLookup;
}

export function createDocEditor(deps: DocEditorDeps): DocEditorApi {
  const { validate, docs, getState, before } = deps;
  return {
    mayEditDoc: (author, doc) => {
      if (validate === undefined || author === validate.authority) return Result.ok(undefined);
      const adapter = docs?.get(doc.table)?.get(doc.column);
      if (adapter === undefined)
        return Result.err(
          new DocChangeRefused({
            ...doc,
            rung: "column",
            message: `${doc.table}.${doc.column} is not a document column`,
          }),
        );
      const partition = getRecord(getState(), doc.table, doc.key)?.partition;
      return validate.validate(docEditProbe(author, doc, adapter, partition), before);
    },
  };
}
