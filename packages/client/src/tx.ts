import type { ColumnsMap, TablesOf } from "@syncmesh/schema";

import type { Writes } from "./collection.js";

/** The recorder a `tx` callback writes through: the same verbs, but nothing lands until the whole callback has. */
export type TxCollections<C extends ColumnsMap> = {
  readonly [K in keyof C]: Writes<TablesOf<C>[K]>;
};
