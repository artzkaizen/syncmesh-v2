# Prior art — LiveStore

Two pages from the LiveStore docs (https://docs.livestore.dev), saved as plain text:

- `events.md` — event definitions (`synced` vs `clientOnly`), commit, materializers into SQLite state, event sourcing model.
- `sqlite-state-schema.md` — the SQLite state schema DSL, client documents for local-only state, auto-migration of state tables.

Relevant to E04 (persisted state as a cache of the log, RFC-0004), E05 (schema DSL) and E09 (client-only tables ≈ our `local` partition).
