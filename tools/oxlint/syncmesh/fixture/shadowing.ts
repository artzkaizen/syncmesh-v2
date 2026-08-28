// A file where a nested scope redeclares an imported name. The rule matches callees by name, so it
// forgets `ok` for this whole file rather than report the local one: no diagnostics here at all.

import { ok } from "@syncmesh/result";

export function shadowed(): void {
  const ok = (n: number): number => n;
  ok(1);
}

export const kept = ok;
