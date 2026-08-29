# syncmesh

A local-first sync engine: every device is a full replica; devices converge with
each other over any transport (BLE, Wi-Fi, a relay) with or without a server; a
server is a peer with better uptime that can hold the rows in your database.

**This repository is built by hand.** No generated code. The AI's job here is
research — options, tradeoffs, prior art, and the plan — never the code.

## Where things are

|                   |                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan/`           | the whole project as epics, tasks and decisions. Open with `bun plan/tool/serve.ts`                                                         |
| `plan/decisions/` | every design decision, one file each. `status: open` until **you** decide                                                                   |
| `plan/epics/`     | one file per epic: goal, dependencies, tasks (`- [ ]`), what to watch out for, tests, done-when                                             |
| `research/`       | reference from the exploration: the API as it was designed, 21 RFCs, wire vectors, learnings, competitor reads. **Reference, not the plan** |

## Layout — what exists (✓) and which epic adds the rest

```
syncmesh/
├── packages/            pure TypeScript, runtime-neutral (D01-B): no bun:/node:/DOM imports, lint-enforced
│   ├── result/          ✓ E00   better-result re-exported — the one Result / TaggedError import
│   ├── kernel/            E01   HLC, stamps, row records, merge
│   ├── engine/            E02   engine, events, in-process sync, telemetry seam
│   ├── wire/              E03   canonical CBOR, Ed25519, envelope, hex ↔ bytes
│   ├── storage/           E04   SqliteDriver port, event store, state store
│   ├── schema/            E05   table definitions, contract
│   ├── policy/            E06   policy AST (data; syncs as a `_policy` row)
│   ├── identity/          E07   grants, bring-your-own-auth
│   ├── partitions/        E08
│   ├── client/            E09   createMesh, collections, tx
│   ├── react/             E10   LiveQuery, useLiveQuery
│   ├── transport/         E11   Transport port, framed links, routing
│   ├── relay/             E12–E19
│   │                      E26   counter · set · text column kinds — CRDTs inside a cell, added to kernel/
│   └── testing/           E04   runDriverTests · E11 runTransportTests — shipped acceptance suites
├── adapters/            one runtime binding each — the only place runtime imports are allowed
│   ├── sqlite-bun/ sqlite-node/ cloudflare-do/            E04   bindings a runtime ships; closed at three
│   │                      an installed binding — expo-sqlite, better-sqlite3 — is ~8 lines of your own over SqliteBinding
│   ├── transport-ws/      E12
│   ├── drizzle/           E17
│   └── ble-channel/ wifi-aware-channel/                    E22 · E23
├── native/              Swift / Kotlin modules; package.json scripts wrap xcodebuild / gradle   E22 · E23
├── apps/                relay-do · relay-rivet · relay-embedded · example-expo   E25 · E09
├── conformance/         frozen wire vectors + the byte-for-byte harness   E03
├── bench/               E04
├── tooling/
│   ├── config/          ✓ E00   tsconfig base + Vite+ presets (`library()`, `adapter()`) every package composes
│   ├── create-package/  ✓ E00   `vp create package` — every package gets the same shape
│   └── verify-node-consumer/   E09   pack each package, import it from real Node
├── plan/                epics, decisions, the plan page
└── research/            reference, not the plan
```

## Rules

1. A task is done when its test exists and passes. Not before.
2. A decision is decided when its file says `status: decided` and names the option. Not before — and not by the tool.
3. Nothing about the wire changes without a new frozen vector.
4. Runtime failures are values. Definition mistakes throw.
5. No function takes the engine as its first argument. No magic strings.

## Running the code

```
bun install
bun run ci                 # vp check (fmt · lint · types) then build · typecheck · test — what CI runs
vp check --fix             # format + lint, fixing what it can
bun run test               # every package's tests, two at a time — see below
vp run -r test             # the same, at vp's default width of four
bun run gen --name kernel --description "…"   # new package; --group adapters for a runtime binding
```

`bun run test` caps the runner at two packages at a time. At vp's default of four, the heavy
suites — PGlite's in-process Postgres, happy-dom for the React hooks, several `bun test` heaps —
can land together and the OS kills one (exit 137), which reads as a failure and is not. Two costs
about a second on the whole suite, because the wall time is a few slow tasks rather than the
width, so the cap is nearly free and `ci` uses it too.

## Running the plan

```
bun plan/tool/serve.ts        # http://localhost:4400
bun run explore               # http://localhost:4500 — the codebase as a map: districts, blocks, flows
```

The page reads the markdown; ticking a box rewrites the `- [ ]` in the file, so
progress lives in git. Edit the markdown directly whenever you prefer.
