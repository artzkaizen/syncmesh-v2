# @syncmesh/result

`better-result`, re-exported — the one place syncmesh imports `Result`, `TaggedError` and
`panic` from (decision D02, option A). Every package imports from here, never from
`better-result` directly, so there is exactly one nominal `Result` type and one place to
change if the library ever does.

Rules (README rule 4):

- A runtime failure is a value: `Result.err(new SomeTaggedError({ ... }))`.
- A definition mistake throws: `panic("table `x` declared twice")`.
- `unreachable(x)` in the `default` of a `switch` over `_tag` makes the compiler prove
  every member is handled.
