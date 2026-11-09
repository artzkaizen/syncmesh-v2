# @syncmesh/schema

The one definition of an app's synced tables: their columns, the partition kind their rows live
in, and who may do what to them. `syncSchema({ tables })` builds it; every peer, the authority and
the Postgres row-level security compile from the same value.

## Rules are bound to the table

A table's `allow` is a function of the combinators, typed to that table's columns, so a typo is a
compile error rather than a rule that never matches:

```ts
import { ladder, partition, syncSchema, t } from "@syncmesh/schema";

const org = partition("org", { roles: ladder("owner", "admin", "member") });

export const schema = syncSchema({
  tables: {
    books: {
      columns: { id: t.uuid().primaryKey(), title: t.text(), createdBy: t.text() },
      partition: org,
      allow: ({ role, owner, any }) => ({
        $default: role("member"),
        update: any(owner("createdBy"), role("admin")),
      }),
    },
  },
});
```

## Named rules (E06)

A rule used by more than one table is a plain function of the combinators it reads. There is no
`bind` feature: rules are values, and `Combinators<Columns, Roles>` says which columns and roles a
named rule needs. Any table that has them can pass its own combinators in; one that lacks them
does not compile.

```ts
import type { AnyColumn, Combinators } from "@syncmesh/schema";

/** The row's `createdBy` names the writer's account. */
const isOwner = ({ owner }: Combinators<{ createdBy: AnyColumn }, never>) => owner("createdBy");

/** An admin of the row's partition, or anyone more senior. */
const isAdmin = ({ role }: Combinators<Record<never, AnyColumn>, "admin">) => role("admin");

/** Named rules compose like inline ones. */
const canEdit = (c: Combinators<{ createdBy: AnyColumn }, "admin">) =>
  c.any(isOwner(c), isAdmin(c));

export const schema = syncSchema({
  tables: {
    books: {
      columns: { id: t.uuid().primaryKey(), title: t.text(), createdBy: t.text() },
      partition: org,
      allow: (c) => ({ $default: c.role("member"), update: canEdit(c), delete: isOwner(c) }),
    },
    reviews: {
      columns: { id: t.uuid().primaryKey(), stars: t.integer(), createdBy: t.text() },
      partition: org,
      allow: (c) => ({ $default: c.all(isOwner(c), c.not(c.rowIs({ stars: 0 }))) }),
    },
  },
});
```

- **Columns** go in the first type argument: the ones the rule reads, nothing else. A rule that
  reads none takes `Record<never, AnyColumn>`.
- **Roles** go in the second: the ones the rule names. A rule that names none takes `never`.
  `syncSchema` hands every table `role(name: string)`, so a role is checked only where the table's
  roles are known: a `drizzleTable`, or combinators typed by hand.
- The result is the same AST an inline rule builds (`{ kind: "owner", column: "createdBy" }`), so
  it serialises into the `_policy` row and compiles to RLS like any other.

A rule built from `@syncmesh/policy`'s free functions (`owner("createdBy")` at module level) is
also a value and composes the same way, but nothing checks its column against the table. Prefer
the typed function.
