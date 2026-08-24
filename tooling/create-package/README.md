# create-package

The generator behind `bun run gen`. Produces one workspace package with the house layout:

```
<group>/<name>/
  package.json      exports → dist (plus the @syncmesh/source condition), depends on @syncmesh/result
  vite.config.ts    export default library()
  tsconfig.json     extends @syncmesh/config, bun types for bun:test
  src/index.ts
  src/index.test.ts one todo — red until the first real test
```

```
bun run gen --name kernel --description "HLC, stamps, merge"
bun run gen --name sqlite-bun --group adapters --description "bun:sqlite driver"
```

`--group` defaults to `packages`. Runs offline, formats the output and runs `bun install`.
`vp create package` also works but then asks about workspace dependencies the template
already wrote; prefer `bun run gen`. Template: `src/template.ts` (bingo + zod 3).
