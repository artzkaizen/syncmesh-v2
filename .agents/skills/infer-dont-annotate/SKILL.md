---
name: infer-dont-annotate
description: Let inference carry the type in syncmesh — const x = f() not const x T = f(); check literals with `satisfies`, never widen a binding with an annotation. Use when declaring any const, options object, or return value, and when reviewing a diff for annotations that inference already provides.
---

# Infer, don't annotate

An annotation on a binding **replaces** what TypeScript knows with what you typed. Inference
keeps the precise type; `satisfies` checks a literal against a contract *without* replacing
it. So the default is: **no annotation**. Every annotation must earn its place, and there are
only three ways it can (below).

Every example here is real code from this repo — the wrong form on the left was actually
written and reviewed away.

## The three forms

```ts
// 1 · A call — the return type is the function's contract. Never annotate.
const validate: Validator = createValidator(validatorOptions);   // ✗ noise
const validate = createValidator(validatorOptions);              // ✓ packages/client/src/mesh.ts

// 2 · A literal that must fit a contract — satisfies checks it and keeps the narrow type.
const engineOptions: EngineOptions = { peerId, clock, store, merge, validate };  // ✗ widens
const engineOptions = { peerId, clock, store, merge, validate } satisfies EngineOptions;  // ✓

// 3 · A primitive/constant — the initializer says it all.
const ZERO: Logical = logical(0);   // ✗ (the review that started the rule)
const ZERO = logical(0);            // ✓ packages/kernel/src/hlc.ts
```

Why 2 matters and isn't taste: with the annotation, `engineOptions` *becomes* the loose
`EngineOptions` — TS forgets `validate` is present, that `store` is exactly this store.
With `satisfies` the binding stays the inferred literal type, the contract is still enforced
(wrong/extra/missing properties are errors), and `exactOptionalPropertyTypes` mistakes
surface at the literal, not at the far-away use.

The pattern composes with conditional properties (anti-slop forbids the
`...(x === undefined ? {} : { x })` spread):

```ts
const validatorOptions = { schema, grantFor, isAuthority } satisfies ValidatorOptions;
if (authority !== undefined) Object.assign(validatorOptions, { authority });
createValidator(validatorOptions);          // packages/client/src/mesh.ts
```

## The three annotations that earn their place

```ts
// A · An empty draft that is written after — satisfies {} would infer {} and refuse the writes.
const spec: SpecDraft<T> = {};
if (filter !== undefined) spec.where = filter;        // packages/client/src/collection.ts

// B · An accumulator whose element type inference cannot see from [].
const decoded: Change[] = [];                          // packages/wire/src/event-codec.ts
const errors: EngineError[] = [];                      // test collectors, same reason

// C · A deliberate widening the domain requires — the union is the point.
let last: Hlc = [EPOCH, ZERO];                         // packages/kernel/src/hlc.ts
let max: SeqNum | undefined;                           // packages/engine/src/store.ts
```

A is the *only* reason to annotate an object literal. If the literal is fully built in one
expression, it is case 2 — `satisfies`.

## Function signatures are different

Exported function parameters and return types are the API — annotate them (doc-comments
skill owns how they're documented). This skill is about **bindings**: `const`, `let`,
accumulators. An implementation lambda assigned to a typed slot needs nothing:

```ts
const cursors: Engine["cursors"] = () => …   // ✓ the slot type IS the contract — this is case 2's
                                             //    spirit: one annotation, contextual types inside
```

## Review checklist

1. `: SomeType = {` on a fully-built literal → `satisfies SomeType`.
2. `: SomeType = someCall(` → delete the annotation.
3. `: SomeType = {}` followed by writes → keep (case A). No writes → why is it empty?
4. After deleting an annotation, if an import becomes type-unused, remove it — lint
   (`consistent-type-imports`) will tell you.
