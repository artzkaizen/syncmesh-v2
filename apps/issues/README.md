# Issues

An issue tracker, as the worked domain a local-first app is actually judged on.

## Running it

```sh
vp dev                              # the app
bun run --cwd apps/issues relay     # optional: what two installs meet on
bun run --cwd apps/issues authority # optional: the one call a device cannot make for itself
```

**All three are separate processes on purpose, and the app works with the last two switched
off.** That is the claim the tracker exists to make, so it has to be the default rather than a
mode: file an issue, edit it, comment, drag it across the board — none of it waits for anything.

What each one adds, and what its absence looks like:

| Process     | Adds                                              | Without it                                                                              |
| ----------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `vp dev`    | the app; one replica per browser profile, in OPFS | —                                                                                       |
| `relay`     | convergence between installs                      | `Relay unreachable` in the header; the app keeps working and catches up when it returns |
| `authority` | gapless issue numbers (`issues.claimNumber`)      | issues read `ENG-•`; they are filed, usable, and unnumbered                             |

`ENG-•` is the honest reading, not a bug. A number is `max + 1` over rows **only the authority
holds** — no device has every team's issues — and it is idempotent, so a client that retried
after a timeout cannot burn an identifier. Opening an unnumbered issue asks for one; filing does
not, because filing must work with nobody listening.

## Ports

| Port  | What                                           |
| ----- | ---------------------------------------------- |
| 5173+ | the app (`vp dev` picks the first free one)    |
| 5241  | the relay's room, `ws://localhost:5241/issues` |
| 5252  | the authority's HTTP door                      |

Override with `VITE_RELAY_URL`, `VITE_AUTHORITY_URL` and `AUTHORITY_PORT`.

## Two installs

A second browser profile is a second **device**, not a second window: its own OPFS file, its own
device key minted on first run, its own place in the room. Two _tabs_ of one profile are one
device with two windows — one identity, one log, one allocation of `(author, seq)` — which is
what the elected worker in `app/host.ts` is for.
