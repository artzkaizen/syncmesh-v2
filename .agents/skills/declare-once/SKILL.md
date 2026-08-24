---
name: declare-once
description: Reuse over repetition in syncmesh — before writing a constant, regex, type shape, helper, or test fixture, find the existing one; declare each thing once at the lowest package that needs it. Use when adding any new symbol, when a second copy of something is about to appear, and when reviewing a diff for duplication.
---

# Declare once

A library accumulates copies fast: a regex here, a `-1 | 0 | 1` there, the same test fixture
in every file. Each copy is a place for two definitions to drift apart. The rule: **a fact
about the domain is declared once**, and everything else imports it.

## Before writing anything new

1. `grep` for it. A literal (`/^[0-9a-f]{64}$/`), a shape (`& { readonly __brand`), a
   name (`compare…`). If it exists, import it. If it exists but is not exported, export it
   from where it lives rather than copying it.
2. Ask what it *is*. A regex that validates a peer id is `PEER_ID_HEX`, not "the hex
   regex"; name it by the domain fact it encodes, and it will be found next time.
3. Ask who else will need it. If the answer is "another package", it goes to the lowest
   package in the dependency graph they share — never copied across packages.

## When to extract

- **Types and constants: on the second use.** Two comparators returning `-1 | 0 | 1` means
  an `Ordering` type. Two branded primitives means a `Brand<T, Tag>` helper. Two files
  building an `Hlc` from milliseconds means one fixture.
- **Behaviour: on the third use, or on the second if the two copies must agree.** Two
  functions that must produce identical bytes (an encoder and a hasher) share code on the
  second; two loops that happen to look alike wait for a third.
- **Test fixtures: always.** Each package has `src/__tests__/fixtures.ts`; test files
  import from it and define nothing shared themselves.

## Where things live

| Kind | Home |
|---|---|
| A domain type, brand, constant used by one package | that package, in the module that owns the concept |
| Used by two packages | the lowest shared dependency (`@syncmesh/result`, `@syncmesh/temporal`, `@syncmesh/kernel`, …) |
| Test fixtures | `src/__tests__/fixtures.ts` of that package |
| Build/lint/task policy | `@syncmesh/config` — a package's config file is two lines |
| Package layout | the generator (`tooling/create-package`), not copied from a sibling |

There is no `utils/` package and no `helpers.ts`. A thing without a domain name has not
been understood yet.

## When not to extract

- One call site. A helper used once is indirection, not reuse.
- Coincidental similarity. Two things that look alike but change for different reasons
  (a wire size limit and a UI page size) stay separate even if both are `100`.
- Premature generality. Extract the shape you have, not the shape you imagine; widen when
  the second real user arrives.

## Checklist for a diff

1. Does it introduce a literal, regex, type shape, or fixture that already exists?
2. Does it introduce a second copy of anything? Then this diff is where the shared
   declaration is created and both sites import it.
3. Is every new shared thing named by what it means, exported from where it lives, and
   documented per `doc-comments`?
4. Would a third package need it soon? Then it is already in the wrong place if it is
   package-private.
