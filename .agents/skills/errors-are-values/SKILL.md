---
name: errors-are-values
description: A throw becomes a value at the boundary that knows what it means — use Result.try / Result.tryPromise, never a hand-rolled try/catch that returns Result.ok or Result.err. Use when calling anything that throws (JSON.parse, BigInt, a driver, a native module, a third-party promise), and when reviewing a diff that adds a try block.
---

# Errors are values

Everything in syncmesh returns `Result`. The places that still `throw` are the edges: the
platform (`JSON.parse`, `BigInt`), a database driver, a native module, somebody else's promise.
Turning a throw into a value is a *conversion*, and there is one way to write it.

## The rule

**If the `catch` produces a value, use `Result.try` or `Result.tryPromise`.**

```ts
// wrong — the same conversion, spelled out by hand
async function open(source: ChangeSource, after: Watermark | null) {
  try {
    return Result.ok(await source.start({ after }));
  } catch (cause) {
    return Result.err(new SourceFailed({ source: source.name, message: "…", cause }));
  }
}

// right
const open = (source: ChangeSource, after: Watermark | null) =>
  Result.tryPromise({
    try: () => source.start({ after }),
    catch: (cause) => new SourceFailed({ source: source.name, message: "…", cause }),
  });
```

Four lines shorter, and the shape says what it is: a call that throws, and the error it becomes.
The hand-rolled version hides that behind control flow a reader has to trace.

`Result.try` for a synchronous throw, `Result.tryPromise` for a promise. The `catch` receives the
thrown value as `unknown` — name it `cause` and put it on the error, so the original is not lost.

A fallback instead of an error is the same conversion:

```ts
// a predicate that will not parse simply matches nothing
Result.try({ try: () => JSON.parse(text) as Interest, catch: () => undefined }).unwrapOr(undefined);
```

## When a try block is right

Three cases, and they have nothing in common with the above:

**The catch has a side effect and rethrows.** A transaction that must roll back before the error
continues upward is not producing a value:

```ts
try {
  const result = await fn();
  db.run("COMMIT");
  return result;
} catch (cause) {
  db.run("ROLLBACK");
  throw cause;
}
```

**The catch turns one throw into a different throw**, because the caller's contract is throwing —
an oRPC handler mapping a policy refusal to `FORBIDDEN`, for instance.

**The catch is doing something other than producing a value.** That is the whole test. A `for
await` whose body returns several different `Result`s *looks* like it needs a try block, and does
not: give the loop its own function returning `Result`, and the caller becomes

```ts
const drained = await Result.tryPromise({ try: () => drain(deps), catch: (cause) => new Failed({ cause }) });
stream.stop();
return drained.andThen((report) => report); // the loop's own Result, flattened
```

That refactor is worth doing on its own account, because a `try` around a loop is usually two
jobs in one construct: the `catch` converting a throw, and a `finally` cleaning up. Split, the
cleanup becomes unconditional — a stream is closed because the loop is over, not because
something went wrong — and the conversion is the one expression it always was.

If you are writing one of these, the try block is the honest shape. If you are writing anything
else, you are re-implementing `Result.try`.

## Reviewing

`grep -rn "try {" --include="*.ts" src` and read each one. The tell is a `catch` block containing
`return Result.err(...)` or a bare fallback value — that is `Result.try` written out longhand.
The other tell is `Result.ok(await …)` inside a `try`, which is the conversion with its two
halves separated by ten lines.
