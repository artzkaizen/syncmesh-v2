# @syncmesh/config

Shared config, composed — never copied — by every package.

- `tsconfig.base.json` — strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `types: []`, `lib: ES2022`. A package's `tsconfig.json` extends it, adds `types: ["bun"]`
  (so `bun:test` resolves) and `noEmit`.
- `vite` — `library()` for `packages/*` (pack with tsdown, platform neutral, dts) and
  `adapter("node" | "browser")` for `adapters/*`, each carrying the `build` / `typecheck` /
  `test` tasks. A package's `vite.config.ts` is `export default library()`.

The `build` task runs `vp pack`, so build a package with `vp run build` — or the whole
workspace with `vp run -r build`. `vp build` is Vite's _application_ build; in a package it
finds no `index.html` and fails with `[UNRESOLVED_ENTRY]`. A `build` script in `package.json`
would not change that: `vp build` always runs the built-in Vite build.

Runtime-neutrality of `packages/*` is enforced by lint (root `vite.config.ts`, the D01-B
override): `bun:*` / `node:*` imports and the `Bun` / `process` / `window` / `document`
globals are errors in `packages/*/src/**`. Adapters are exempt — that is what they are for.

## Cross-package imports before a build

Each package's `exports` starts with a `@syncmesh/source` condition → `./src/index.ts`, and
its `tsconfig.json` sets `customConditions: ["@syncmesh/source"]`. Editors, `vp check` and
`typecheck` therefore resolve `@syncmesh/*` to source without `dist/`. `vp pack` does not
use that condition, so emitted output — and any real consumer — resolves to `dist/`.
