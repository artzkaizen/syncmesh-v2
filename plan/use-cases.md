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
    treatmentPlan: { columns: fromDrizzle(drizzle.treatmentPlan), partition: "practice", allow: ({ role }) => ({ $default: role("member") }) },

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

mesh.activate(`practice:${activePracticeId}`);   // the org switcher calls this; once. With one practice in the grant it is implied.
await mesh.appointment.insert({ id, patId, dentistId: me.memberId, start, end });
const today = mesh.appointment.where({ day: today });

mesh.procedure.all();                            // global: read on devices, written by the server
```

**What the design buys here**

- The org id is never typed on a write. next-oral's client hand-writes `orgId` into each
  insert and its server-side scoping helper is commented out; here the store *is* the
  practice, so a row cannot land in the wrong tenant.
- Switching practice is `mesh.activate(other)`: every practice-kind collection re-points
  and its live queries re-emit — what kaitosec does today with a full page reload. An
  org-kind collection with nothing active is `Err(NoActivePartition)`, never a guess.
- A member's device with a forged "admin" event: the signature verifies, `role("admin")`
  fails against the grant, every honest receiver quarantines it. The disabled button in the
  UI (`mesh.appointment.can("delete", row)`) is courtesy; the receiver check is the
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
      allow: ({ can, owner, claim, anyOf }) => ({
        read:   claim("entities").has("entityId"),                                   // row.entityId ∈ grant.claims.entities
        insert: can("controls", "create"),
        update: anyOf(can("controls", "update"), owner("ownerMemberId")), // owner = the org-scoped member id, kaitosec's own rule
        delete: can("controls", "delete"),
      }),
    },
    policy: { columns: fromDrizzle(drizzle.policy), partition: "org", allow: ({ can, claim }) => ({ read: claim("entities").has("entityId"), $default: can("policies", "update") }) },

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
mesh.activate(`org:${organizationId}`);
await mesh.control.insert({ id, title, entityId, ownerMemberId: me.memberId });   // Err(PermissionDenied) if claims lack controls:create
mesh.control.where({ status: "open" });     // only rows whose entityId is in claims.entities were ever admitted to this device
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
  grant alone: no lookup, no network, same answer everywhere. `can("controls", "create")` is
  sugar for `claim("permissions.controls").has("create")`; `claim(name).has(column)` is the
  one primitive — the row's column value must be in the list the grant carries.

**Two things decided here**

- `allow` is required on every partitioned table; the manifest throws at load without it.
  `user` and `local` tables need none (only the account or device can reach them) and
  global tables are device-read-only.
- Writes are local-first, not optimistic. `insert` appends to the local log and folds
  before any network; the UI updates from that fold; there is no pending state to roll
  back. The only thing that undoes a write is a signed correction from the authority
  (E16), arriving as one more event.

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

## 4 · A sleep clinic platform — rows shared across tenants (Somnara's shape)

Clinics are organizations; a patient is one person who attends several clinics. The
clinical record — `patient`, `artifact`, `insurance`, `sleep_diary_entry` — belongs to the
patient, carries no org column, and every clinic they attend may read and write it. A report
becomes visible to the patient only once `status = "signed"`; a video-consult token exists
only in a time window and only after the pre-consult questionnaire row exists.

This is the case a partition cannot carry. A partition is the unit of replication: a row is
in exactly one, and a device holds whole partitions. The patient record is not "in the
clinic" (three clinics share it) and not "in the user" (clinic staff need it); and
"visible once signed" is a predicate over the row's own state that changes with time.

The model has a third tier for exactly this, and the manifest names it per table:

```ts
export const schema = defineSchema({
  partitions: { clinic: {} },
  roles: { clinic: ["owner", "admin", "doctor", "staff"] },

  tables: {
    icdCode:      { columns: fromDrizzle(drizzle.icdCode) },                                           // global
    booking:      { columns: fromDrizzle(drizzle.booking), partition: "clinic", allow: ({ role, owner, anyOf }) => ({ $default: role("staff"), update: anyOf(owner("userId"), role("admin")) }) },
    schedule:     { columns: fromDrizzle(drizzle.schedule), partition: "clinic", allow: ({ role }) => ({ $default: role("staff") }) },

    patient:      { columns: fromDrizzle(drizzle.patient),   visibility: "authority" },   // the relay decides who receives which rows
    artifact:     { columns: fromDrizzle(drizzle.artifact),  visibility: "authority" },
    sleepDiary:   { columns: fromDrizzle(drizzle.sleepDiaryEntry), visibility: "authority" },
  },
});
```

`visibility: "authority"` (RFC-0020, E16): the relay evaluates, against the app's own
database, which rows reach which device — clinic membership, `status = "signed"`, the
consult window — and validates writes there. Devices receive a *subset*, then hold it
offline like any other rows.

The three tiers, side by side:

| Tier | Decided by | May read | Offline | Carries |
|---|---|---|---|---|
| Partition | structure: the table's kind, the row's instance, the grant | nothing | fully | tenant data — kaitosec's 174 tables, the practice's tables |
| Row rule (`allow`) | every device, from row + patch + grant claims | the grant | fully | roles, ownership, entity access as claims |
| Authority visibility | the relay | the app's database | after the authority has spoken once | shared-across-tenants rows, state- and time-dependent visibility |

**What the design does not do, said plainly**

- An authority-visibility row cannot be obtained peer-to-peer (over BLE, say) from a
  device that has it unless the authority admitted the receiver first. That is correct: a
  clinic phone must not be able to pull a patient's record from another clinic's phone
  because the two happened to meet.
- Somnara's `key_org_id` — which org's AES key sealed a row — is application encryption, a
  column like any other. Somnara also has no offline layer today; it tests the model, it is
  not a customer of it.

---

## The choices, and which case defends each

| Choice | Defended by |
|---|---|
| `partition` is per table, never per write; instances come from the grant | 2, 3 — the per-call org id is the bug both codebases have |
| `mesh.activate("org:x")` once; collections use the active instance | 2 — the switcher *is* the context; replaces the full-page reload |
| No `partitions` key needed; `user` and `local` built in | 1 |
| No `partition` → `global`, device-read-only | 2, 3 — catalogs; the read-only rule makes the default safe |
| `partitions` is a tree of kinds, no `isolation`, no `parent` strings | 2, 3 — top-level means own store; nesting is structural |
| `roles` ladder is optional; grants carry claims; `claim(name).has(column)` with `can` as sugar | 3 — roles are data there, a ladder cannot express a matrix |
| Conflict rules on the column, `fromDrizzle(t, { onConflict })` typed | all — one home, no untyped map |
| One entry shape `{ columns, partition?, allow? }` | all — `fromDrizzle` returns columns |
| `Err(...)` at the call site, quarantine at every receiver | all — the UI check is courtesy, the receiver check is security |
| `visibility: "authority"` as a third tier, not a partition | 4 — rows shared across tenants, state- and time-dependent visibility |
| `allow` required on every partitioned table | 2, 3 — no silent "any member" |
| Writes local-first, never optimistic | 1 — the local log is the truth on the device |

---

## 5 · Onboarding through the mesh — a grant is bytes, any peer can carry them

The scenario with teeth: a new staff member's phone has **no internet**, but a colleague's
device in BLE range does. The new device still ends up with a verified grant, because nothing
about a grant requires the receiving device to talk to the issuer:

1. N mints its identity locally (`createIdentity` — offline, the key never leaves the device).
2. N hands its `peerId` to M over the local link. That is the whole request.
3. M has internet and calls the grant route **with N's peerId** — the §1 route already takes
   `devicePeerId` in the body, so this is not a new endpoint.
4. The signed grant rides back M → N. N verifies it offline against the issuer's public key
   from its config, and registers it. Writes and `can` light up.

The carrier is a pipe, provably: flip one byte and registration fails on the signature; register
someone else's grant and it answers for *their* device key, not yours (`grantFor` is by device).
The same shape covers the serverless org — the issuer keypair on the owner's phone instead of a
server, grants minted in the room — and device linking, where an already-granted phone requests
a grant *for* the laptop's peerId under the same account.

Ordering is the part the transport must own (E11): events from an author you hold no grant for
quarantine on `NoGrant` and are never stored; when the grant frame arrives — sessions send
grants before any event — a resync converges. All four scenarios are pinned by
`packages/client/src/__tests__/onboarding.test.ts` today, with function calls standing in for
the radio; E11 replaces the function calls with frames and changes nothing above them.

What stays impossible by design: instant revocation without ever reaching the issuer. Expiry is
the staleness bound (D08) — renewal is one more grant frame, relayed exactly like onboarding.
