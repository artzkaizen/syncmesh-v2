# @syncmesh/tsconfig

Two configs, one rule.

- `base.json` — strict, `types: []`, `lib: ES2022`. **No runtime globals.** A package
  that compiles against this cannot see `Bun`, `process`, `window` or `document`.
- `library.json` — `base` + emit to `dist/` with declarations.

Every package has two tsconfigs:

- `tsconfig.build.json` — extends `library.json`, includes `src` minus tests, `types: []`.
  This is what `build` runs. If `src` reaches for a runtime global, the build fails —
  that is the D01-B guard.
- `tsconfig.json` — extends `library.json`, includes tests too, `types: ["bun"]` so
  `bun:test` resolves. `typecheck` runs this one; editors read it.

Adapters (`adapters/*`) opt into their runtime's types in _both_ files. That is the
only place they are allowed.
