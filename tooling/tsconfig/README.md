# @syncmesh/tsconfig

One config: `base.json` — strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`types: []`, `lib: ES2022`. **No runtime globals.**

Each package's `tsconfig.json` extends it, adds `types: ["bun"]` (so `bun:test` resolves)
and `noEmit`. Building is `vp pack` (tsdown), which follows imports from `src/index.ts`,
so tests never reach `dist/` and there is no second tsconfig.

Runtime-neutrality of `packages/*` is enforced by lint (`vite.config.ts`, the D01-B
override): `bun:*` / `node:*` imports and the `Bun` / `process` / `window` / `document`
globals are errors in `packages/*/src/**`. Adapters are exempt — that is what they are for.
