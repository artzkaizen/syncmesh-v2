# syncmesh

A local-first sync engine: every device is a full replica; devices converge with
each other over any transport (BLE, Wi-Fi, a relay) with or without a server; a
server is a peer with better uptime that can hold the rows in your database.

**This repository is built by hand.** No generated code. The AI's job here is
research — options, tradeoffs, prior art, and the plan — never the code.

## Where things are

| | |
|---|---|
| `plan/` | the whole project as epics, tasks and decisions. Open with `bun plan/tool/serve.ts` |
| `plan/decisions/` | every design decision, one file each. `status: open` until **you** decide |
| `plan/epics/` | one file per epic: goal, dependencies, tasks (`- [ ]`), what to watch out for, tests, done-when |
| `research/` | reference from the exploration: the API as it was designed, 21 RFCs, wire vectors, learnings, competitor reads. **Reference, not the plan** |

## Rules

1. A task is done when its test exists and passes. Not before.
2. A decision is decided when its file says `status: decided` and names the option. Not before — and not by the tool.
3. Nothing about the wire changes without a new frozen vector.
4. Runtime failures are values. Definition mistakes throw.
5. No function takes the engine as its first argument. No magic strings.

## Running the plan

```
bun plan/tool/serve.ts        # http://localhost:4400
```

The page reads the markdown; ticking a box rewrites the `- [ ]` in the file, so
progress lives in git. Edit the markdown directly whenever you prefer.
