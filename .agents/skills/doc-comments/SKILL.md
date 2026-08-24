---
name: doc-comments
description: How syncmesh documents its public API — JSDoc conventions modelled on Zod, better-result and Effect. Use whenever writing or reviewing exported types, functions, classes, or package entry points, and when a comment is about to explain "why" instead of "what".
---

# Doc comments

syncmesh is a library. Its comments are read by consumers in editor hovers and in
generated `.d.ts` files, not by us. Write them the way Zod, better-result and Effect do.

## The one test

**A comment exists only when it says something the name and the type do not.**

`ColumnName`, `RowRecord.writeStamp`, `HlcClockOptions.now`, `Stamp { hlc, peer }` — the
name is the documentation. A comment there is noise a reader has to skip, and it trains
readers to skip the ones that matter. Most exports need nothing. Zod does not document
`ZodString`; better-result does not document `Ok.value`.

Write one when there is a contract the signature cannot carry:

- an invariant or guarantee: *"stamps never go backwards, even when `now()` does"*
- a rule with a source: *"visible iff no delete or `writeStamp > deleteStamp` — RFC-0014 §1"*
- a non-obvious meaning: *"the counter half of an Hlc; tie-breaker within one instant"*
- a surprising choice a consumer must know: *"always the polyfill, never the runtime's"*
- an example, when the call shape is not obvious from the types

## The shape, when one is warranted

```ts
/** Total order on stamps: instant first, then logical counter. */
export function compareHlc(a: Hlc, b: Hlc): Ordering;
```

One sentence, third person, ends with a period. Expand only when a consumer needs more:

```ts
/**
 * Transforms the success value.
 *
 * @param fn Transformation function.
 * @returns Ok with the transformed value.
 * @throws {Panic} If `fn` throws.
 *
 * @example
 * Result.ok(2).map((x) => x * 2); // Ok(4)
 */
```

Order inside a block: summary · blank line · `@template` · `@param` · `@returns` ·
`@throws` · blank line · `@example`. An example is one or two lines with the result in a
trailing comment. Do not add `@param` lines that restate the parameter name.

## What does not go in a code comment

- **Why we chose this.** Decisions live in `plan/decisions/`; the plan and RFCs in
  `research/`. Link to them by id (`D04`, `RFC-0003`) if it helps; do not restate them.
- **Narrative about the project.** "Every device must compute time identically" is a
  README or decision sentence, not a comment on an export.
- **Usage manuals at the top of a file.** If a file needs a paragraph to be understood,
  the API is unclear; fix the names or split the module.
- **Restating the name or signature.** `/** A column identifier. */ ColumnName`,
  `/** Options for createX. */ XOptions`, `/** Source of wall-clock time. */ now` — delete.
- **Comments on non-exported code**, unless the code is genuinely non-obvious — then a
  short `//` line, and prefer a better name first.

## Required comments

- `// SAFETY: <the checked invariant>` immediately before any type assertion
  (enforced by anti-slop).
- `// oxlint-disable-next-line <rule> -- <reason>` for a scoped disable; the reason is
  mandatory and must say why the rule cannot be satisfied, not that it is inconvenient.
- A `@deprecated` tag with the replacement on anything kept for compatibility.

## Checklist before committing an export

1. Delete the comment. Is anything lost that the name and type do not carry? If not, it stays deleted.
2. If it stays: does its first line stand alone as the hover text, and does it say *what*, not *why*?
3. Would it still be correct if the internals were rewritten?
4. Is every `@param` name real and every `@example` runnable as written?
5. Could a reader mistake a `number`/`string` parameter for something else? If so the
   type is wrong, not the comment (see `strict-types`: Temporal or a brand).

## Examples from our own code

Good:

```ts
/** Total order on stamps: physical instant first, then logical counter. */
export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1;
```

Not good — an essay where a sentence belongs:

```ts
/**
 * Hybrid logical clock. `[physical, logical]`: a wall-clock instant plus a counter that
 * only matters when two stamps share the same millisecond. Strictly monotonic on one
 * device even when the wall clock jumps backwards; receiving a remote stamp ratchets ...
 */
```

The second is RFC-0003 material. The type gets: `/** A hybrid logical clock stamp: wall-clock instant, then a per-millisecond counter. See RFC-0003. */`
