# `syncmesh` oxlint plugin

Repository-specific lint rules, written the same way as the vendored `anti-slop` plugin next door
(`defineRule` + `eslintCompatPlugin`) but kept in their own plugin so re-vendoring `anti-slop` from
its skill cannot clobber them.

## `syncmesh/no-floating-result`

Reports a `Result` whose value is thrown away — in an expression statement, in a non-final operand
of a comma expression, or under the `void` operator — because a discarded `Result` turns a failure
the type system made you carry into silence.

### What it can and cannot see

Oxlint's JS plugin API is untyped: `@oxlint/plugins` states plainly that "Oxlint does not offer any
parser services", so a rule sees an ESTree AST and nothing else. `typescript/no-floating-promises`
is type-aware because it is a built-in Rust rule; a JS plugin cannot ask the same questions.

So the rule proves a value is a `Result` from evidence in the file it is linting:

- a call to `ok` / `err` / `Ok` / `Err` imported from `@syncmesh/result` or `better-result`, under
  whatever local name;
- a `Result.<static>` call, for the statics that return a `Result` rather than fold one;
- a chain of `Result`-preserving methods (`map`, `andThen`, `tap`, …) on top of either — a chain
  ending in `unwrap`, `match` or `isErr` is consumed, not floating;
- a call to a function declared in the same file whose return annotation is `Result<…>`,
  `Promise<Result<…>>`, `AsyncResult<…>`, or a union containing one.

That evidence stops at the module boundary. `await store.append(entry)` — the shape this rule exists
for — is a call through an imported interface, and its type lives in another package.

### The `callees` option

`callees` closes that gap by naming calls known to return a `Result`, either as `receiver.method`
(matched against the last two segments, so `a.engine.mutate` matches `engine.mutate`) or as a bare
function name. It is a hand-maintained list and it is matched by name, so add an entry only when no
unrelated `receiver.method` in the repo shares it: `store.delete` is deliberately absent because the
blob store's `delete` does not return a `Result`.

Two cheaper heuristics were measured against the whole repository and rejected. Flagging every call
name that some file declares with a `Result` return annotation scored 11 true positives against 160
false ones — `Map.delete` and `Set.clear` collide with real port methods. Flagging every bare
`await` statement would have scored 30 out of 597.

### Checking the rule

`fixture/cases.ts` holds one statement per shape the rule accepts and rejects. Nothing under
`tools/oxlint` is linted by `vp check`, so run it directly:

```
cd tools/oxlint/syncmesh/fixture
../../../../node_modules/.bin/oxlint --config .oxlintrc.json cases.ts     # 11 diagnostics
../../../../node_modules/.bin/oxlint --config .oxlintrc.json shadowing.ts # 0 diagnostics
```

Eleven is correct for `cases.ts`: ten "should report" statements, with the comma expression counted
twice because both of its operands are discarded. `shadowing.ts` is the other half of the contract —
a name the rule matches on is redeclared in a nested scope, so it forgets that name for the whole
file and stays quiet rather than reporting the local one.
