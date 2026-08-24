import type { PeerId } from "./peer-id.js";

import { compareHlc, type Hlc } from "./hlc.js";

/** What every write carries: an {@link Hlc} and the peer that issued it. */
export interface Stamp {
  readonly hlc: Hlc;
  readonly peer: PeerId;
}

/** Total order on stamps: by {@link Hlc}, then by peer id. Equal stamps compare 0. */
export function compareStamp(a: Stamp, b: Stamp): -1 | 0 | 1 {
  const byHlc = compareHlc(a.hlc, b.hlc);
  if (byHlc !== 0) return byHlc;
  return a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0;
}
