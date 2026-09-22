# What building a real app on this API actually cost

Found by writing `apps/issues` — a Linear-style tracker with 120 seeded issues, fractional ranking,
a concurrent counter, six `allow` rules and an authority call — against the API as it stands. Every
item below is something the app had to work around, with the workaround named.

Ranked by how many apps will hit it.

## 1. A schema `.default()` becomes a caller *obligation*

`packages/orpc/src/procedures.ts:145-157` types both the handler and the call site with
`Output<S>`. Zod's `Output` is post-defaults, so `z.object({ limit: z.number().default(20) })`
makes `limit` **required** at the call site — the exact inversion of what the author wrote.

The app converted every `.default(x)` to `.optional()` and applied the default by hand in the
handler. *Fix:* `Input<S>` at the call site, `Output<S>` in the handler. It is a two-token change
and it is wrong for every app that writes an input schema naturally.

## 2. A handler cannot see who is calling

`mesh` is a `Handle`; there is no `mesh.caller` or `mesh.principal`. So every mutation recording
attribution takes `actorId` **in its input**, and an `allow` rule is what makes it true rather than
the call itself. For owner-guarded tables that is sound. For `issue.creatorId` it means the field
is attribution and not authority — a caller can name anyone the rules do not forbid.

The session principal already exists (`sessionPrincipal` reaches `openHandles` as a `HandleExtras`
member). Surfacing it on the handle deletes a parameter from most mutations in the app.

## 3. Declared error names are not in the type

`.errors({ NO_SUCH_ISSUE: … })` types `AuthorityContext.errors` as
`Readonly<Record<string, …>>`, so under `noUncheckedIndexedAccess` every `errors.NO_SUCH_ISSUE()`
is possibly-undefined. The app wrote a `refuse(name)` helper with a fallback that can never fire.
*Fix:* `Record<keyof E, …>`.

## 4. No Temporal bridge at the Drizzle boundary

`t.timestamp()` is a `Temporal.Instant` to the manifest, epoch-ms on the wire and a `Date` through
Drizzle. `fromDrizzle` warns about this on every timestamp column and offers nothing to do about
it, so the app wrote `src/time.ts` — four converters every app will otherwise rewrite. A
`syncmeshTimestamp()` column helper in `@syncmesh/drizzle` deletes the file and the warning
together.

## 5. `t.boolean()` is a trap on SQLite

Capture logs the raw SQLite value, so a Drizzle `integer({ mode: "boolean" })` column arrives at
`checkValue` as the integer `1`, which `accepts.boolean` rejects. The app dodged it by modelling
every flag as a nullable timestamp — better modelling anyway, since the tombstone then carries
*when* — but that is luck, not design. *Fix:* coerce per declared kind in the capture decode, or
have `fromDrizzle` refuse `boolean` on SQLite with a message that says why.

## 6. An idempotent mutation cannot report success

`onConflictDoNothing` stages nothing on the second tap, and the call returns
`Err("mutation wrote nothing: no event to report")`. Honest, and it makes idempotence
unexpressible: a caller cannot tell "already done" from "failed". *Fix:* a distinguishable
outcome — `Ok` with no event id, or a `NothingWritten` tag.

**Closed 2026-09-22.** A mutation that stages nothing returns `Err(NothingWritten { path })`,
a `TaggedError` in `packages/orpc/src/errors.ts`, so *already done* and *failed* are two
values. Test: "NothingWritten: an idempotent mutation can finally report 'already done'" in
`packages/orpc/src/__tests__/api.test.ts`.

## 7. Two declared errors collapse in `openapi()`

`createServer`'s OpenAPI builder keys every declared error under `"422"`, so a procedure with two
declared errors emits one response. Cosmetic, and it silently loses information.

## 8. A sealed partition is unreachable from an app bound to another instance

Correct behaviour, but it means the tracker's procedures cannot touch its `disclosure` table at
all — reading an embargo needs a second `createApp` bound to `embargo:<id>`. The shape of the app
follows from it, so the manifest docs should say so.

## What the app got right, and is worth keeping as the worked example

**One partition kind, `workspace`.** Teams and projects are rows inside it. Making a team a
partition would make "everything assigned to me" a query no handler can write, and moving someone
between teams a resync.

**`embargo` is sealed and the workspace is not.** Sealing the tracker would cost the gapless
number, the staleness sweep, folding into Postgres and corrections. For "fix the footer padding"
that is a bad trade; for an embargoed vulnerability report the operator is in the threat model and
nobody wanted a sweep over it anyway.

**Reactions are rows, not a counter.** The test is whether the thing being counted has an
identity. A reaction has a name attached and can be taken back, so it is a row keyed
`(actor, subject, emoji)` — idempotent for free, and it merges as a set. A view has no identity,
so it is a counter; a row per view is unbounded rubbish in a log that replays forever.

**Ordering is a fractional index, sorted `(rank, id)` and never `rank` alone.** An integer position
renumbers every row below on one drag and loses one of two concurrent drags to LWW. A linked list
is one cycle away from a repair no offline device can perform. A fractional index writes exactly
one cell — the moved row's own — so nothing else can be clobbered.
