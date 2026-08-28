// Cases for `syncmesh/no-floating-result`. The repository lints nothing under tools/oxlint, so run
// this by hand from this directory and read the output:
//
//   ../../../../node_modules/.bin/oxlint --config .oxlintrc.json cases.ts
//
// Every statement under "should report" must produce one diagnostic (the comma expression two),
// and nothing under "should NOT report" may produce any.

import { Result, ok, err as fail } from "@syncmesh/result";

declare const engine: { mutate(n: number): Promise<unknown> };
declare const other: { mutate(n: number): void };

function decode(raw: string): Result<number, Error> {
  return ok(raw.length);
}

export async function cases(): Promise<void> {
  // should report
  decode("a");
  await decode("a");
  Result.ok(1);
  ok(1);
  fail(new Error("x"));
  Result.ok(1).map((n) => n + 1);
  void decode("a");
  await engine.mutate(1);
  decode("a"), decode("b");
  later();

  // should NOT report
  const kept = decode("a");
  if (kept.isErr()) return;
  decode("a").unwrap();
  Result.ok(1).map((n) => n + 1).unwrap();
  Result.isOk(kept);
  console.log(decode("b"));
  other.mutate(1);
  [1].map((n) => n);
  new Map<string, number>().delete("a");
}

function later(): Result<void, Error> {
  return ok(undefined);
}
