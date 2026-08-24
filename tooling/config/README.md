# @syncmesh/config

Shared config, composed — never copied — by every package.

- `tsconfig.base.json` — strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `types: []`, `lib: ES2022`. A package's `tsconfig.json` extends it, adds `types: ["bun"]`
  (so `bun:test` resolves) and `noEmit`.
- `vite` — `library()` for `packages/*` (pack with tsdown, platform neutral, dts) and
  `adapter("node" | "browser")` for `adapters/*`, each carrying the `build` / `typecheck` /
  `test` tasks. A package's `vite.config.ts` is `export default library()`.

Runtime-neutrality of `packages/*` is enforced by lint (root `vite.config.ts`, the D01-B
override): `bun:*` / `node:*` imports and the `Bun` / `process` / `window` / `document`
globals are errors in `packages/*/src/**`. Adapters are exempt — that is what they are for.
