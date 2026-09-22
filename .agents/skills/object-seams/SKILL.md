---
name: object-seams
description: Where a class belongs in syncmesh and where it silently breaks a seam — a factory typed against a seam interface (Transport, SqlDriver, OperationStore, …) returns an object literal, never a class instance, because wrappers spread it; a class is for a TaggedError or for module-private state behind that literal. Use when writing a createX/openX factory, when a closure's state has grown past what can be read in one place, and when reviewing a diff that adds a class or an `implements`.
---

# Object seams

Four places in production build a seam value by spreading another one and replacing the members
they mean to change: `client/src/telemetry.ts` (`{ ...transport, start }`),
`client/src/operations.ts` (`{ ...store, record }`), `client/src/inspect.ts`, and
`ble/src/transport.ts`, which *is* `{ ...createFrameTransport(…), reaches, maxLinks, drop, wake }`.
`{ ...instance }` copies own enumerable properties and nothing else — a prototype method is not
one. A factory that returns a class instance leaves every one of those wrappers with the members
they overrode and none of the rest, with the type still saying `Transport`. D29 records it.

## The rule

**A value typed as a seam interface has every member as an own enumerable property.** Factories
return object literals. A class is never exported and never appears in a `.d.ts`.

```ts
// wrong — types as Transport, and a wrapper that spreads it keeps only what it overrode
export class RelayTransport implements Transport { … }
export const relayTransport = (options: RelayTransportOptions) => new RelayTransport(options);

// right — the state lives in a private class; the seam is the literal
class RelayLink { /* fields declared once, methods over `this` */ }

export function relayTransport(options: RelayTransportOptions): Transport {
  const link = new RelayLink(options);
  return {
    name: link.name,
    start: (ctx) => link.start(ctx),
    delivers: () => link.delivers(),
    …
  };
}
```

The shipped suites assert it: `transportTests` runs `spreadable` over every transport a
`Connect` builds, `driverTests` over every driver it opens. A new adapter inherits the check by
running the suite it already has to run.

## When a class is the right tool

- **Nominal identity.** A `TaggedError("Tag")` that must revive across a wire by its tag,
  `instanceof`, and a stack. Every error in the tree is one; nothing else needs `new`.
- **Module-private state.** A factory whose `let` bindings can no longer be read in one place, or
  where a forward reference needs a wrapper to exist (`createBlobChannel((f) => sendSafe(f))`
  because `sendSafe` was a `const` thirty lines down). `wire/src/cbor.ts`'s `Writer` and
  `relay/src/transport.ts`'s `RelayLink` are the shape: not exported, fields declared once, and
  the exported factory returns the literal that delegates to it.

Two or four fields do not earn one. The threshold is the reader's — can the object's state be
seen in one place? — not a number.

## What not to do in the delegation

- Not `start: link.start.bind(link)` for every member: it passes the check, but it is the same
  per-instance allocation the closure made, with `this` threaded through. The arrow reads as what
  it is, a table of which method answers which member.
- Not `return link` with an inferred return type. Inference widens it to the class, and from there
  it is one refactor from the `.d.ts`. Annotate the factory's return as the seam interface.
- Not a base class for adapters. The adapters implement `Transport` and `SqlDriver` without
  importing anything from the package that declares them; a base class would put that dependency
  arrow backwards (D12 considered it, D29 rejects it).

## Optional members stay absent

`withBlobs()` reads `putBlob !== undefined`; settling reads `caughtUp !== undefined`. A capability a
transport does not have is a member it does not declare — not a method that returns nothing. A
class either declares a method or does not, which is the other reason the seam is a literal.
