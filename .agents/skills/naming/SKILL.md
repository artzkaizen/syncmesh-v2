---
name: naming
description: Name syncmesh functions by product, not by source — methods for views, verbs for logic, no new exported *Of/*For helpers. Use when naming any new function, reviewing a diff for naming, or renaming a helper. Pairs with the no-of-for-suffix lint rule.
---

# Naming

266 functions end in `Of`/`For`. The pattern reads inside-out at call sites (`hintOf(peer)`
parses as "the hint — of what? — peer") and collides across packages (`bodyOf` ×3,
`scopeOf` with two meanings, `epochOf` with two meanings). The rule: **name by product,
not by source.**

## The decision table

| Case | Do | Never |
|---|---|---|
| View of one object | Method/property on the owner: `table.columns` | `columnsOf(table)` |
| Lookup in a collection | The collection's own API: `entries.get(name)` | `entryOf` Map wrappers |
| Logic that can fail | Verb: `resolve*` (Result), `parse*` (validation) | `partitionOf`, `scopeOf` |
| Construction | `create*`, always | `custodyFor`, `mintFor` |
| Pure total projection | Noun first: `peerHint(peer)`, `storeName(scope)` | `hintOf`, `storeNameFor` |

`resolve` means it can fail (returns `Result`). `parse` means it validates untrusted
input. `create` means it constructs. A bare noun means total and pure. If none fits,
the abstraction is wrong — split it until one does.

## Before/after, from this repo

```
hintOf(peer)                 -> peerHint(peer)
storeNameFor(scope)          -> storeName(scope)            # For adds nothing: delete it
partitionOf(row)             -> resolvePartition(row)       # fails -> Result
scopeOf(rows) [storage/sql]  -> parseScope(rows)            # validates wire rows
custodyFor(opts)             -> createCustody(opts)          # factory
mintFor(device, account)     -> mintIdentity(device, account)
entryOf (Map wrapper)        -> entries.get(name)           # delete the function
columnsOf(table)             -> table.columns               # view -> owner
bodyOf [3 modules]           -> eventBody / frameBody / peerBody  # qualify: collisions are bugs
epochOf [relay, DDL epoch]   -> relayEpoch(driver)          # product first; wire keeps epochOf
identityOf [drizzle/tree]    -> queryIdentity(query)        # devtools keeps identityOf
scopeOf [orpc] vs [storage]  -> callScope(input) / rowScope(rows)  # two meanings must differ
```

## Collision registry (fix on sight, never add to it)

`bodyOf` (relay fixtures, transport peers/tests), `epochOf` (wire sealing — kept;
relay renamed to `relayEpoch`), `identityOf` (devtools health, drizzle tree),
`mintFor` (relay fixtures, transport fixtures), `scopeOf` (orpc scope, storage sql),
`syncOf` (devtools sync, drizzle sync-of), `windowOf` (devtools dom, drizzle window).
Test fixtures collide freely — fixtures are local by design and excluded from the rule.

## Recipes

- **Map/object wrapper**: inline `.get`/property access at the call site, delete the helper.
- **Factory**: `create<Noun>(deps)`. If it takes an owner plus options, it is still a factory.
- **Validation of one value**: `parse<Noun>(raw)` returning `Result`, check beside the kind check.
- **Derivation that cannot fail**: noun-first pure function, no `Of`: `peerHint`, `lockPath`.
- **Genuinely mathematical projection** (coordinate flip, unit conversion): `Of` is allowed
  with a doc comment saying what it projects. This is the only exception.

## Enforcement

- New exported `*Of`/`*For` helpers fail `syncmesh/no-of-for-suffix` unless grandfathered
  in the rule's allowlist. The allowlist shrinks; it never grows — rename instead.
- Collisions fail review on sight, lint or no lint.
- Everything else: boy-scout. Rename when the module is touched anyway; never a rename-only
  campaign across the tree.
