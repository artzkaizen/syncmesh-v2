---
rfc: 0013
title: Schema Evolution & Version Skew
package: syncmesh (src/schema · src/protocol) — design
layer: contract
status: proposed
standalone: false
deps: ["0002", "0003", "0004"]
---

# RFC-0013 — Schema Evolution & Version Skew

## Purpose

A mesh never upgrades atomically. Two devices on different app versions WILL
sync — the only question is whether the rules for that are designed or
accidental. This RFC fixes them: what an old peer does with events from the
future, what a new peer does with events from the past, and how the app
schema is allowed to change so both stay cheap.

## Two version axes, never conflated

| Axis | Field | Owner | Bumps when | Today |
|---|---|---|---|---|
| event format | `v` (on every core) | protocol (RFC-0002) | the wire shape itself changes — rare, last resort | pinned to 1; decoder rejects anything else |
| app schema | `schemaVersion` | the app | every `syncmesh migrate` | **absent from the wire** |

(Third, smaller axis: the policy AST interpreter — unknown AST nodes already
quarantine per RFC-0008; nothing new here.)

Conformance vectors are pinned **per `v`**: `conformance/vectors.json` is the
v=1 set, frozen forever. A future v=2 adds a second vector set beside it —
never edits the first — and a port (RFC-0002's Swift targets) claims support
per version by reproducing that version's bytes. A peer speaking v=n MUST
still decode every v ≤ n.

## The two skew directions

**1 · Older peer receives newer events.** You cannot ask the future to stop
sending. Response ladder, ordered by whether the unknown thing could mutate
state:

| Unknown thing | Can mutate state? | Response |
|---|---|---|
| map key in event/grant core | no | skip (built — `codec.ts`) |
| message kind | no | skip + log (RFC-0002 invariant 4) |
| `meta` content | no — never applied | carry opaquely |
| column on a known table | yes | apply known columns; park unknown ones in the row's `_smx` overflow blob; materialize after upgrade (taxonomy B4) |
| whole table | yes | append the event un-materialized; replay after upgrade (B5) |
| change kind, or event-format `v` | yes | **quarantine** — park signed bytes verbatim, never materialize, retry on app upgrade |

The last row is load-bearing. The `do.md` critique of the early spec stands:
skip-and-ack of a change kind that would MUTATE state is permanent divergence
— the receiver's cursors advertise an event it holds no effect of, so no sync
round ever offers it again. Quarantine keeps the bytes; the cursor may then
safely advance (the sender is not asked to resend forever) because upgrade
replays the parked event. Skipping is only ever for things that cannot touch
rows; everything else is retained whole or refused whole, never half-applied.

**2 · Newer peer receives older events.** Always applicable, by construction:
additive-first migrations (below) make every old event a valid statement
about a subset of today's columns, and upcasters translate the shapes that
genuinely changed. Translation happens **at apply time** — the log keeps the
original signed bytes untouched (rewriting would break signatures and
byte-identical store-and-forward, RFC-0002). Native events pass through with
zero translation cost.

## `schemaVersion` + the upcaster registry

Add `schemaVersion: uint` to the event core under a fresh integer key, absent
= 1 — every frozen v=1 vector stays byte-valid, old peers skip the key, no
`v` bump. This is the ignore-unknown machinery paying for itself.

```ts
defineSync(tables, {
  schemaVersion: 3,
  upcast: {
    2: (changes, header) => changes.map(renameDueAtToDeadline), // 1 → 2
    3: (changes) => changes,                                    // 2 → 3 additive: identity
  },
})
```

- Chained single steps: a schemaVersion-1 event applies through 2, then 3.
- Runs inside the fold, before LWW — the kernel (RFC-0003) only ever sees
  current-shape changes.
- **Upcasters must be pure**: `(changes, header) → changes`, nothing else.
  They execute in the fold on every peer, possibly years apart; a leaked
  `Date.now()`, `Math.random()`, locale, or read of live tables is per-peer
  divergence — the exact fold non-determinism class the command/materialize
  split exists to kill. Same regime as policy (RFC-0008): no closures over
  app state, determinism property-tested.

## App-schema migrations

`table()`/`t.*` (built — `src/schema/table.ts`) is dialect-neutral: one
definition, SQLite derived on device, Postgres on the server. `syncmesh
migrate` (proposed; lands in RFC-0011's CLI) diffs `shared/schema.ts`, bumps
`schemaVersion`, and emits Drizzle artifacts for drizzle-kit — the device
migration auto-applies on app update, the server one is a normal SQL file;
both inspectable, never hand-edited. The diff tool enforces the discipline:

| Change | Verdict |
|---|---|
| add table | fine |
| add column, nullable or defaulted | fine — old events lack it, rows get null/default |
| add NOT NULL column, no default | refused — old events could never materialize |
| rename column | only with an upcaster (old key → new key) |
| repurpose a column (same name, new meaning) | **refused, always** — mixed-version rows go silently wrong; no upcaster can tell them apart |
| drop column/table | park: stop writing, keep materializing history; physical drop only above the compaction floor |

## The type set, and why it is the intersection `[built]`

`t.*` carries exactly what maps **totally** onto both SQLite and Postgres:
`text · integer · float · boolean · timestamp · json · blob · uuid`. Being the
intersection is what lets one definition serve a phone and a server, and it is
also what makes the set portable: the Rust and Swift ports read a description
made of plain data, not a TypeScript ORM schema.

### `t.uuid()` — a kind, not a `text` convention

A synced primary key must be client-generatable (a `serial` sequence cannot be
coordinated by two offline devices), so in practice most of them are uuids.
That makes uuid the default key type of this system, and it earns a kind for one
reason that `text` cannot cover:

**The kernel keys rows by the primary-key STRING.** As `text`, `"A1B2…"` and
`"a1b2…"` are two rows for one entity, and two devices whose generators differ
in case never converge. As `uuid`, non-canonical input is refused at write time.

Canonical means RFC 9562 §4 form: lowercase hex, 8-4-4-4-12. **Shape only** — v4
and v7 both pass, as do the nil and max uuids, which are real sentinels. And the
refusal is a refusal, not a normalization: silently lowercasing would hide the
fact that two of your code paths disagree, and it would need a transform seam in
`checkRow` that deliberately does not exist (it validates, it never rewrites).
The `KindMismatch` message names the shape, because an uppercase uuid reads as
perfectly valid to a human staring at "got string".

### Why it is a validated string and not 16 wire bytes

A uuid is 37 bytes as a CBOR text string and would be 17 as a `bstr` — real
money against RFC-0002's 30 B/event budget on a 24 kbps radio. We do not take it.

`codec.ts`'s `value()` dispatches on the **runtime JS type**, not on the schema;
the codec never sees a `Table` or a `ColumnKind`. So a uuid column that holds a
string encodes exactly as text does: no new wire kind, no new conformance
vectors, nothing for the Rust or Swift ports to learn. Storing 16 bytes instead
would mean the *decoder* has to know the column kind to hand the app back a
string — which means threading the schema through a deliberately schema-free
codec. That schema-free wire is a large part of why non-JS ports are tractable,
and it is worth more than 20 bytes a key.

The general rule this sets: **a new column kind is free when it narrows an
existing runtime representation, and architectural when it introduces a new
one.** Prefer the first.

## Importing a Drizzle schema `[proposed]`

Defining tables twice — once for the server's Postgres, once for the mesh — is a
real adoption tax on any app that already has a Drizzle schema. Two directions,
and they are not symmetric:

- **`toDrizzle(sync)` — total.** Our set is the intersection, so every column has
  an exact `pgTable`/`sqliteTable` equivalent. No failure cases. This is the
  blessed path, and it is what `syncmesh migrate` already emits (above).
- **`fromDrizzle(schema)` — an import tool.** Drizzle's set is the union, so this
  narrows. Most of it is deterministic and should never bother the user:

| Drizzle / pg | Ours |
|---|---|
| `text`, `varchar`, `char` | `text` |
| `integer`, `smallint` | `integer` |
| `real`, `doublePrecision` | `float` |
| `numeric(p,s)`, `p ≤ 15` | `float` |
| `bigint` | by mode: `number` → `integer`, `bigint` → `text` |
| `boolean` | `boolean` |
| `timestamp`, `timestamptz` | `timestamp` (truncates pg microseconds) |
| `date`, `time`, `interval` | `text` (ISO forms) |
| `uuid` | `uuid` |
| `json`, `jsonb` | `json` |
| `bytea` | `blob` |
| `pgEnum` | `text` (variant list retained) |
| arrays | `json` |

Refused, and none of them are types — they are behaviours needing a server:

- `serial` / `bigserial` / `identity`: there is no value to convert. Two offline
  devices cannot both be given the next number.
- generated / computed columns: evaluated by a database that is not on the phone.
- `numeric` with no precision, or `p > 15`: a double cannot hold it. Choose
  `t.text()` for exactness or a scaled integer for arithmetic.

Warned, because the column maps but the constraint does not: `references()` (no
cross-partition referential integrity) and `unique()` (two offline devices can
both insert the same value — a pre-existing honesty gap, not a new one).

**The mapping is a frozen artifact.** It determines wire bytes: once
`numeric → float` ships and a log exists, changing it invalidates every event in
that log, exactly like the conformance vectors. Pin it, test it, version it.

## Current state

| Piece | State |
|---|---|
| ignore-unknown map keys (event + grant decode) | built — `codec.ts`, fuzz-pinned (RFC-0002 inv. 4) |
| event-format `v` | built — on every core, pinned to 1, decoder rejects ≠1 |
| conformance vectors, v=1 frozen | built — `conformance/vectors.json` |
| dialect-neutral `table()`/`t.*` | built — `src/schema/table.ts` |
| `t.uuid()` — canonical-form kind, refuses non-canonical, no wire change | built — `src/schema/column.ts`, `tests/schema.test.ts` |
| `fromDrizzle` / `toDrizzle` | none exist — mapping table above is the spec |
| unknown change kind | today: decode **throws** → whole event dropped as `malformed`; MAX-cursors then hide the hole forever — the drop-flavored version of the divergence above |
| unknown column on known table | today: admission denied (`checkRow` → `UnknownColumn`), event refused — not parked (no B4 overflow) |
| quarantine store | not built — "denied" is a typed error + refusal; nothing is parked or retried |
| `schemaVersion` on the wire · upcasters · `syncmesh migrate` | none exist |

## Remaining work

1. `schemaVersion` core field + upcaster registry (pure, chained) — smallest step, unlocks the rest.
2. Quarantine store (park verbatim + retry on upgrade) replacing drop-as-malformed for unknown change kinds / unknown `v`.
3. Contiguous cursors — prerequisite: with MAX cursors a dropped event is an invisible hole.
4. B4 overflow blob and B5 un-materialized replay in the fold path.
5. `syncmesh migrate` diff + verdict table above; frozen vector set for schemaVersion-bearing events (still v=1).
6. `fromDrizzle` against the pinned mapping table, with `toDrizzle ∘ fromDrizzle` round-trip tests over the intersection.

## Open questions

- G18: state digests / dev-mode fold hashes across mixed versions — a peer that upcast an event and one that applied it natively (or holds columns the other parked in `_smx`) can hold legitimately different rows, so digest mismatch ≠ divergence; compare per-version, or digest a common-subset projection?
- Is `schemaVersion` one global uint per event, or per-table — apps evolve tables independently.
- Version-stranded bound: how large may quarantine grow before the honest answer is forced upgrade or snapshot re-bootstrap?
- How long must an upcaster chain be supported before snapshot re-bootstrap replaces replay?
- Does the policy AST interpreter version ride `v`, or bump independently?
