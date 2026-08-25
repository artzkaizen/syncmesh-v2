# Use cases — the API, end to end

Three apps, in order of difficulty. Every choice in the schema, grants and client surface
is defended by one of them. This is the target for E05–E09; anything here that an epic
cannot deliver is a plan bug, not an app bug.

The shape of every app is the same five steps:

1. Declare the data model once (`defineSchema`).
2. Your server, inside the login you already have, issues a **grant** per device.
3. The client creates one mesh and registers the grant.
4. Reads and writes go through collections; the partition is never named per call.
5. Every device converges; refusals are values.

---

## 1 · Notes — one person, several devices

No teams, no roles. A phone and a laptop that must agree.

```ts
// shared/schema.ts
import { defineSchema, t } from "@syncmesh/schema";

export const schema = defineSchema({
  tables: {
    notes:  { columns: { id: t.uuid().primaryKey(), body: t.text(), pinned: t.boolean().default(false), updatedAt: t.timestamp() }, partition: "user" },
    drafts: { columns: { id: t.uuid().primaryKey(), body: t.text() }, partition: "local" },
  },
});
```

No `partitions` key: the only kinds are the built-in ones. `user` syncs across every device of
the account; `local` never leaves the device.

```ts
// server — one route added to the auth you already run
app.post("/mesh/grant", async (req) => {
  const session = await auth.getSession(req);
  if (!session) return new Response(null, { status: 401 });
  const grant = issueGrant(issuer, {
    account: session.userId,
    device: (await req.json()).devicePeerId,
    validFor: Temporal.Duration.from({ days: 30 }),
  });
  return Response.json({ grant: bytesToHex(grant) });
});
```

No partitions listed: the `user` partition is implied by `account`.

```ts
// client
const identity = createIdentity(await loadOrMintSeed()).unwrap();
const mesh = createMesh({ schema, identity, issuer: ISSUER_PUBLIC_KEY, transports: [relay(RELAY_URL)] });
mesh.grants.register(await fetchGrant(identity.peerId));

await mesh.notes.insert({ id: uuid(), body: "milk", updatedAt: Temporal.Now.instant() });
const pinned = mesh.notes.where({ pinned: true });       // live; re-emits once per fold batch
await mesh.drafts.insert({ id: uuid(), body: "wip" });   // never on the wire
```

**What the design buys here**

- Offline on the phone, edit `body`; offline on the laptop, edit `pinned` of the same note.
  Reconnect: both survive — field-level LWW (D04). Same field on both: the later stamp wins,
  nothing is corrupted, both devices show the same value.
- `mesh.notes.insert({ … body: 3 })` is `Err(ColumnCheckFailed)` at the call site, and a
  forged event with the same payload is quarantined at every receiver — the same
  `checkRow` runs before the fold everywhere.
- Lose the phone: its grant expires; the server never issues another for that device key.

**What a developer must not have to do:** name a partition, write an org id, install
anything server-side beyond one route.

---

## 2 · A dental practice — teams with fixed roles (next-oral's shape)

An `organization` is a practice; members are `owner | admin | member`; patients and
appointments belong to the practice; the dental code catalogues are shared by everyone.

```ts
export const schema = defineSchema({
  partitions: { practice: {} },
  roles: { practice: ["owner", "admin", "member"] },

  tables: {
    // shared reference data — no partition: global, server-written, read everywhere
    procedure: { columns: fromDrizzle(drizzle.procedure) },
    diagnosis: { columns: fromDrizzle(drizzle.diagnosis) },

    patient: {
      columns: fromDrizzle(drizzle.patient),
      partition: "practice",
      allow: ({ role }) => ({ $default: role("member"), delete: role("admin") }),
    },
    appointment: {
      columns: fromDrizzle(drizzle.appointment),
      partition: "practice",
      allow: ({ role, owner, anyOf }) => ({
        $default: role("member"),
        update: anyOf(owner("dentistId"), role("admin")),
      }),
    },
    treatmentPlan: { columns: fromDrizzle(drizzle.treatmentPlan), partition: "practice" },   // allow omitted → the partition's default: any member

    preference: { columns: { id: t.text().primaryKey(), locale: t.text() }, partition: "user" },
  },
});
```

Notes on the choices, against the real codebase:

- next-oral's `treatment_plan`, `clinical_note`, `form_response` carry no `org_id`; they reach
  the practice through `patId`. Here they need no column either: every row carries its
  partition on the event. The transitive-scoping problem that the app has today disappears.
- The catalogues (`procedure`, `diagnosis`) stop being "rows in a tenant table that happen to
  be shared" and are simply global.
- `roles` is a fixed ladder, which matches `member.role` in better-auth's organization plugin.

```ts
// server — the grant comes from the active organization, exactly where next-oral resolves it today
app.post("/mesh/grant", async (req) => {
  const session = await auth.api.getSession({ headers: req.headers });
  const practiceId = session?.session.activeOrganizationId;
  if (!session || !practiceId) return new Response(null, { status: 401 });
  const member = await auth.api.getActiveMember({ headers: req.headers });
  return Response.json({
    grant: bytesToHex(issueGrant(issuer, {
      account: session.user.id,
      device: (await req.json()).devicePeerId,
      role: member.role,                                  // "owner" | "admin" | "member"
      partitions: [`practice:${practiceId}`],
      validFor: Temporal.Duration.from({ hours: 12 }),
    })),
  });
});
```

```ts
// client
const mesh = createMesh({ schema, identity, issuer, transports: [relay(url)] });
mesh.grants.register(grant);                    // opens practice:<id>; global and user are always open

const practice = mesh.in(`practice:${activePracticeId}`);   // typed: only practice-kind tables exist on it
await practice.appointment.insert({ id, patId, dentistId: me.memberId, start, end });
const today = practice.appointment.where({ day: today });

mesh.procedure.all();                            // global: read on devices, written by the server
```

**What the design buys here**

- The org id is never typed on a write. next-oral's client hand-writes `orgId` into each
  insert and its server-side scoping helper is commented out; here the store *is* the
  practice, so a row cannot land in the wrong tenant.
- Switching practice is `mesh.in(other)` — no page reload, and both can be open at once.
- A member's device with a forged "admin" event: the signature verifies, `role("admin")`
  fails against the grant, every honest receiver quarantines it. The disabled button in the
  UI (`practice.appointment.can("delete", row)`) is courtesy; the receiver check is the
  security.
- Conflicts: two receptionists move the same appointment offline → later stamp wins for
  `start`; different fields → both kept. `rating: t.float().onConflict("max")`-style rules
  are declared on the column, once.

**What a developer must not have to do:** add `orgId` columns to child tables, remember an
`eq(orgId, …)` predicate in every query, pass a partition on writes.

---

## 3 · A compliance platform — dynamic roles, shared catalogs, entity trees (kaitosec's shape)

An organization has editable roles with a per-module permission matrix (`org_role`), shared
framework catalogs with per-org overlays, and a tree of legal entities that narrows what each
member may see.

```ts
export const schema = defineSchema({
  partitions: { org: {} },     // entities are not partitions: see below

  tables: {
    // global catalogs: replicated to every org, written by the platform
    catalog:        { columns: fromDrizzle(drizzle.catalog) },
    catalogControl: { columns: fromDrizzle(drizzle.catalogControl) },
    threatCatalog:  { columns: fromDrizzle(drizzle.threatCatalog) },

    // per-org overlays on the global catalogs
    catalogSelection: { columns: fromDrizzle(drizzle.orgCatalogSelection), partition: "org", allow: ({ can }) => ({ $default: can("catalogs", "update") }) },

    control: {
      columns: fromDrizzle(drizzle.control, { onConflict: { score: "max" } }),
      partition: "org",
      allow: ({ can, owner, entityOf, anyOf }) => ({
        read:   entityOf("entityId"),                                   // row.entityId ∈ grant.claims.entities
        insert: can("controls", "create"),
        update: anyOf(can("controls", "update"), owner("ownerMemberId")), // owner = the org-scoped member id, kaitosec's own rule
        delete: can("controls", "delete"),
      }),
    },
    policy: { columns: fromDrizzle(drizzle.policy), partition: "org", allow: ({ can, entityOf }) => ({ read: entityOf("entityId"), $default: can("policies", "update") }) },

    notificationPreference: { columns: fromDrizzle(drizzle.notificationPreference), partition: "user" },
  },
});
```

No `roles` list: roles are rows in this app, so they are not in the manifest. The grant
carries **claims** instead.

```ts
// server — the same organizationProcedure context kaitosec already has
app.post("/mesh/grant", async (req) => {
  const { session, organizationId } = await apiContext(req.headers);
  if (!session || !organizationId) return new Response(null, { status: 401 });
  const member = await getActiveMember(session, organizationId);
  const permissions = await modulePermissions(member.orgRoleId);        // { controls: ["read","update"], policies: ["read"], … }
  const entities = await getAccessibleEntityIds(session.user.id, organizationId);   // the recursive CTE / SpiceDB answer, as ids

  return Response.json({
    grant: bytesToHex(issueGrant(issuer, {
      account: session.user.id,
      device: (await req.json()).devicePeerId,
      partitions: [`org:${organizationId}`],
      claims: { member: member.id, role: member.role, permissions, entities },
      validFor: Temporal.Duration.from({ hours: 4 }),
    })),
  });
});
```

```ts
// client
const org = mesh.in(`org:${organizationId}`);
await org.control.insert({ id, title, entityId, ownerMemberId: me.memberId });   // Err(PermissionDenied) if claims lack controls:create
org.control.where({ status: "open" });     // only rows whose entityId is in claims.entities were ever admitted to this device
mesh.catalog.all();                        // global
```

**What the design buys here**

- kaitosec's audit found the hand-written `eq(t.organizationId, ctx.organizationId)`
  predicate missing in ~20 places. Here there is no predicate to forget: an `org` store holds
  one org.
- Its 13 "nullable organizationId means global" tables split into a global table and an
  org overlay — the split its own schema already half-makes with `org_catalog_selection`.
- The 121 child tables without an org column need none.
- The permission matrix and entity access are evaluated on every device from the signed
  grant alone: no lookup, no network, same answer everywhere.

**What the design does not do, said plainly**

- **Entity access is a snapshot.** A member removed from an entity keeps seeing its rows
  until their grant is replaced or expires. That is why `validFor` is hours here. Live
  revocation is E21.
- **Entities are not partitions.** A partition is the unit of *replication*; an entity is a
  *visibility* filter inside one. Making every entity a store would be hundreds of stores
  per org and would not model "descendants" anyway.
- **Global tables are read-only on devices.** The platform writes them through the authority
  (E16). A device that inserts into `catalog` gets `Err(ReadOnlyPartition)` — which is also
  how a forgotten `partition:` on a tenant table shows up on the first write in development,
  rather than as a silent leak.

---

## The choices, and which case defends each

| Choice | Defended by |
|---|---|
| `partition` is per table, never per write; instances come from the grant | 2, 3 — the per-call org id is the bug both codebases have |
| `mesh.in("org:x")` handle, typed by kind | 2 — replaces the full-page reload on org switch |
| No `partitions` key needed; `user` and `local` built in | 1 |
| No `partition` → `global`, device-read-only | 2, 3 — catalogs; the read-only rule makes the default safe |
| `partitions` is a tree of kinds, no `isolation`, no `parent` strings | 2, 3 — top-level means own store; nesting is structural |
| `roles` ladder is optional; grants carry claims; `can` / `entityOf` combinators | 3 — roles are data there, a ladder cannot express a matrix |
| Conflict rules on the column, `fromDrizzle(t, { onConflict })` typed | all — one home, no untyped map |
| One entry shape `{ columns, partition?, allow? }` | all — `fromDrizzle` returns columns |
| `Err(...)` at the call site, quarantine at every receiver | all — the UI check is courtesy, the receiver check is security |
