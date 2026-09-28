# Use cases — the API, end to end

Five apps, in order of difficulty. Every choice in the schema, in grants and in the surface an app
calls is defended by one of them. This is the target for E05–E09; anything here that an epic
cannot deliver is a plan bug, not an app bug.

The shape of every app is the same five steps:

1. Declare the data model once (`defineSchema`), over the Drizzle tables the app already has.
2. Your server, inside the login you already run, issues a **grant** per device.
3. The client creates one mesh, registers the grant, and binds one `api` to it.
4. Every read and every write the app performs is a call on that `api`. Drizzle appears inside a
   procedure handler and nowhere else (D26).
5. Every device converges; refusals are values.

Three files per app, and only one of them is the API: `schema.ts` (the Drizzle tables and the
manifest over them), `api.ts` (the procedures), and wherever the mesh is constructed. A component
imports `api` and names nothing else — no mesh, no handle, no instance, no query builder.

---

## 1 · Notes — one person, several devices

No teams, no roles. A phone and a laptop that must agree.

```ts
// notes/schema.ts
import { defineSchema, t } from "@syncmesh/schema";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const note = sqliteTable("note", {
  id: text().primaryKey(),
  body: text().notNull(),
  pinned: integer({ mode: "boolean" }).notNull(),
});

export const draft = sqliteTable("draft", { id: text().primaryKey(), body: text().notNull() });

export const notesSchema = () =>
  defineSchema({
    tables: {
      note: {
        columns: { id: t.uuid().primaryKey(), body: t.text(), pinned: t.boolean() },
        partition: "user",
      },
      draft: { columns: { id: t.uuid().primaryKey(), body: t.text() }, partition: "local" },
    },
  });
```

No `partitions` key: the only kinds here are the reserved three. `user` syncs across every device
of the account; `local` never leaves this one; a table naming neither is `global`, which every
device reads and only the authority writes. Neither `user` nor `local` takes an `allow` block —
only the account or the device can reach those rows — while a table in a kind the manifest
*declares* must have one, and `defineSchema` throws at load without it.

`pinned` has no `.default(false)`. A cell holds one value and one stamp, so a default is a value
nobody wrote and no merge can reason about (D25); the handler that inserts the row says
`pinned: false`, and the write that set it is the write the merge can see.

```ts
// notes/api.ts
import { mutation, query } from "@syncmesh/orpc";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { draft, note } from "./schema.js";

export const notes = {
  all: query.handler(({ mesh }) => mesh.db.select().from(note)),
  pinned: query.handler(({ mesh }) => mesh.db.select().from(note).where(eq(note.pinned, true))),

  write: mutation.input(z.object({ body: z.string().min(1) })).handler(async ({ input, mesh }) => {
    const id = crypto.randomUUID();
    await mesh.db.insert(note).values({ id, body: input.body, pinned: false });
    return { id };
  }),

  pin: mutation
    .input(z.object({ id: z.string(), pinned: z.boolean() }))
    .handler(async ({ input, mesh }) => {
      await mesh.db.update(note).set({ pinned: input.pinned }).where(eq(note.id, input.id));
      return input;
    }),
};

export const drafts = {
  keep: mutation
    .input(z.object({ id: z.string(), body: z.string() }))
    .handler(async ({ input, mesh }) => {
      await mesh.db.insert(draft).values(input); // never on the wire
      return input;
    }),
};
```

`query` and `mutation` carry no qualifier because running on the device is the ordinary case. What
is marked is `authority` (§4) — the call that needs a server and therefore fails on a ward with no
signal — because that is the one a reader has to notice.

```ts
// server — one route added to the auth you already run
app.post("/mesh/grant", async (req) => {
  const session = await auth.getSession(req);
  if (!session) return new Response(null, { status: 401 });
  const { devicePeerId } = await req.json();
  const wire = issueGrant(issuer, {
    account: session.userId,
    device: parsePeerId(devicePeerId).unwrap(),
    partitions: [],
    validFor: Temporal.Duration.from({ days: 30 }),
    now: Temporal.Now.instant(),
  });
  return Response.json({ grant: bytesToHex(wire) });
});
```

`partitions` is empty and that is complete: the reserved kinds are not confined by a grant's list,
so an account with no tenants still writes its own `user` rows and its own device's `local` ones.

```ts
// notes/device.ts
const identity = createIdentity(await loadOrMintSeed()).unwrap();
const mesh = (
  await createMesh({
    schema: notesSchema(),
    identity,
    issuer: ISSUER_PEER_ID,
    driver: bunSqliteDriver(`${dataDir}/notes.db`),
    transports: [relayTransport({ dial: webSocketDial(RELAY_URL) })],
  })
).unwrap();
mesh.grants.register(hexToBytes(await fetchGrant(identity.peerId)).unwrap()).unwrap();

export const api = meshApi(mesh, { notes, drafts }, { instance: `user:${session.userId}` });
```

The instance is the one thing the app names, once, where the mesh is built. A `user` row lives in
`user:<account>` and the validator holds it there on every receiver, so binding the api anywhere
else is a `WrongPartition` on the first write rather than a row in the wrong place.

```tsx
function Notes() {
  const { data, isPending, isSettled } = useLiveQuery(api.notes.pinned());

  if (isPending) return <Spinner />;
  if (data.length === 0) return isSettled ? <NoNotes /> : <StillSyncing />;
  return data.map((n) => <NoteRow key={n.id} note={n} />);
}

function NoteRow({ note }: { readonly note: Note }) {
  // subscribed, not read once: this flips on its own when a peer acknowledges the event
  const sync = useSyncOf(api.$sync, "note", note.id);
  return <Row dimmed={sync === "local"}>{note.body}</Row>;
}

await api.notes.write({ body: "milk" });
```

A read is `{ data, status, isPending, isError, isSuccess, isSettled, error }` — React Query's
names minus what a live query makes meaningless: nothing is stale, nothing refetches, and there is
no key to invalidate because the fold already says which tables changed. A write is
`Result<{ eventId, data }, …>`, settled the moment local SQLite commits, online or off. What
happens to it afterwards is read per row, not awaited per call.

**What the design buys here**

- Offline on the phone, edit `body`; offline on the laptop, `pin` the same note. Reconnect: both
  survive — field-level LWW over the columns each write actually touched (D04, and the diff
  capture takes at commit). Same field on both: the later stamp wins, nothing is corrupted, both
  devices show the same value.
- `api.notes.write({ body: 3 })` does not compile, and if it arrives as unparsed input the zod
  schema refuses it and the call is `Err` with nothing written. A value that gets past the input
  schema meets `checkRow` at the capture boundary and the transaction rolls back; a forged event
  carrying the same payload meets the same `checkRow` before the fold at every receiver, and is
  quarantined. One check, three places.
- `isSettled` is the difference between *there are no pinned notes* and *the relay has not
  answered yet* — `mesh.settled()`, per subscription, and the reason a cold start does not show a
  spinner to a user who genuinely has nothing.
- Lose the phone: its grant expires; the server never issues another for that device key.

**What a developer must not have to do:** name a partition on a call, write an account id into a
row, or install anything server-side beyond one route.

---

## 2 · A dental practice — teams with fixed roles (next-oral's shape)

An `organization` is a practice; members are `owner | admin | member`; patients and appointments
belong to the practice; the dental code catalogues are shared by everyone.

```ts
const practice = partition("practice", { roles: ladder("owner", "admin", "member") });

export const practiceSchema = () =>
  defineSchema({
    tables: {
      // no partition: global — the authority writes it, every device reads it
      procedure: { columns: fromDrizzle(drizzle.procedure) },
      diagnosis: { columns: fromDrizzle(drizzle.diagnosis) },

      patient: {
        columns: fromDrizzle(drizzle.patient),
        partition: practice,
        allow: ({ role }) => ({ $default: role("member"), delete: role("admin") }),
      },
      appointment: {
        columns: fromDrizzle(drizzle.appointment, { merge: { rating: "max" } }),
        partition: practice,
        allow: ({ role, owner, any }) => ({
          $default: role("member"),
          update: any(owner("dentistId"), role("admin")),
        }),
      },
      treatment_plan: {
        columns: fromDrizzle(drizzle.treatmentPlan),
        partition: practice,
        allow: ({ role }) => ({ $default: role("member") }),
      },

      preference: { columns: { id: t.text().primaryKey(), locale: t.text() }, partition: user },
    },
  });
```

Notes on the choices, against the real codebase:

- next-oral's `treatment_plan`, `clinical_note` and `form_response` carry no `org_id`; they reach
  the practice through `patId`. Here they need no column either: every row carries its partition
  on the signed event, stamped from the instance the api is bound to. The transitive-scoping
  problem the app has today disappears.
- The catalogues (`procedure`, `diagnosis`) stop being "rows in a tenant table that happen to be
  shared" and are simply global.
- `roles` is a fixed ladder, which matches `member.role` in better-auth's organization plugin.
- `$default` is not optional in an `allow` block: the block is a rule per operation with one
  answer for everything it did not name, so "any member" is stated rather than implied.
- The key under `tables` **is** the table's name, and a table name is a lowercase identifier —
  `treatment_plan`, never `treatmentPlan`; columns are camelCase, as the frozen wire vectors use.
  `fromDrizzle` refuses columns imported from a Drizzle table named anything else, so the wire,
  the trigger and the fold cannot drift apart over which string means this table.

```ts
// server — the grant comes from the active organization, exactly where next-oral resolves it today
app.post("/mesh/grant", async (req) => {
  const session = await auth.api.getSession({ headers: req.headers });
  const practiceId = session?.session.activeOrganizationId;
  if (!session || !practiceId) return new Response(null, { status: 401 });
  const member = await auth.api.getActiveMember({ headers: req.headers });
  const wire = issueGrant(issuer, {
    account: session.user.id,
    device: parsePeerId((await req.json()).devicePeerId).unwrap(),
    role: member.role, // "owner" | "admin" | "member"
    partitions: [parsePartitionKey(`practice:${practiceId}`).unwrap()],
    validFor: Temporal.Duration.from({ hours: 12 }),
    now: Temporal.Now.instant(),
  });
  return Response.json({ grant: bytesToHex(wire) });
});
```

```ts
// practice/api.ts
export const appointments = {
  onDay: query
    .input(z.object({ day: z.string() }))
    .handler(({ input, mesh }) =>
      mesh.db
        .select()
        .from(appointment)
        .where(eq(appointment.day, input.day))
        .orderBy(asc(appointment.start)),
    ),

  book: mutation
    .input(
      z.object({
        patId: z.string(),
        dentistId: z.string(),
        day: z.string(),
        start: z.number(),
        end: z.number(),
      }),
    )
    .handler(async ({ input, mesh }) => {
      const id = crypto.randomUUID();
      await mesh.db.insert(appointment).values({ id, ...input });
      return { id };
    }),
};

/** Global: read on every device, written by the authority. */
export const catalogue = {
  procedures: query.handler(({ mesh }) => mesh.db.select().from(procedure)),
};
```

```ts
export const api = meshApi(mesh, { appointments, catalogue }, { instance: `practice:${practiceId}` });
```

Switching practice is not a call on a mesh: a top-level instance gets **its own store**, so one
practice's log, state and tables live in a file that holds nothing of any other (D07). The
switcher opens the other practice's stores, builds a mesh over them, and binds a second `api` —
and leaving a practice is closing that mesh, `forget(scope)`, and deleting one file.

```ts
const stores = scopedStores({ driverFor: (_, name) => bunSqliteDriver(`${dataDir}/${name}.db`) });
const openPractice = async (practiceId: string) => {
  const instance = parsePartitionKey(`practice:${practiceId}`).unwrap();
  const held = (await stores.storeFor(instance)).unwrap();
  const mesh = (await createMesh({ schema, identity, issuer, stores: held, transports })).unwrap();
  return meshApi(mesh, { appointments, catalogue }, { instance });
};
```

**What the design buys here**

- The org id is never typed on a write. next-oral's client hand-writes `orgId` into each insert
  and its server-side scoping helper is commented out; here the api's binding is the practice, so
  a row cannot land in the wrong tenant and there is no predicate to forget.
- A member's device that forges an "admin" event: the signature verifies, `role("admin")` fails
  against the grant, and every honest receiver quarantines it. The disabled button —
  `useCan(api.$can, "patient.delete")`, which re-evaluates the moment a grant registers — is
  courtesy; the receiver check is the security.
- Conflicts: two receptionists move the same appointment offline → the later stamp wins for
  `start`; different fields → both kept. Where last-write-wins is the wrong answer for a number,
  the rule is declared on the column once — `t.float({ merge: "max" })`, or `fromDrizzle`'s
  `merge` map for an imported table — and never at a call site.

**What a developer must not have to do:** add `orgId` columns to child tables, remember an
`eq(orgId, …)` predicate in every query, or pass a partition on a write.

---

## 3 · A compliance platform — dynamic roles, shared catalogs, entity trees (kaitosec's shape)

An organization has editable roles with a per-module permission matrix (`org_role`), shared
framework catalogs with per-org overlays, and a tree of legal entities that narrows what each
member may see.

```ts
const org = partition("org"); // entities are not partitions: see below

export const complianceSchema = () =>
  defineSchema({
    tables: {
      // global catalogs: replicated to every org, written by the platform
      catalog: { columns: fromDrizzle(drizzle.catalog) },
      catalog_control: { columns: fromDrizzle(drizzle.catalogControl) },
      threat_catalog: { columns: fromDrizzle(drizzle.threatCatalog) },

      // a per-org overlay on the global catalogs
      catalog_selection: {
        columns: fromDrizzle(drizzle.catalogSelection),
        partition: org,
        allow: ({ can }) => ({ $default: can("catalogs", "update") }),
      },

      control: {
        columns: fromDrizzle(drizzle.control, { merge: { score: "max" } }),
        partition: org,
        allow: ({ can, claim, any }) => ({
          $default: can("controls", "update"),
          read: claim("entities").has("entityId"), // row.entityId ∈ grant.claims.entities
          insert: can("controls", "create"),
          update: any(can("controls", "update"), claim("member").equals("ownerMemberId")),
          delete: can("controls", "delete"),
        }),
      },
      policy: {
        columns: fromDrizzle(drizzle.policy),
        partition: org,
        allow: ({ can, claim }) => ({
          $default: can("policies", "update"),
          read: claim("entities").has("entityId"),
        }),
      },

      notification_preference: {
        columns: fromDrizzle(drizzle.notificationPreference),
        partition: user,
      },
    },
  });
```

No `roles` list: roles are rows in this app, so they are not in the manifest. The grant carries
**claims** instead, and `claim(name)` is the one primitive: `.has(column)` asks whether the row's
column value is in a list the grant carries, `.equals(column)` whether it is the single value the
grant carries. `can("controls", "create")` is sugar for `claim("permissions.controls")` with the
action as a constant.

Ownership here is `claim("member").equals("ownerMemberId")` and not `owner("ownerMemberId")`,
which is not a stylistic choice: `owner(column)` compares the column to the grant's **account**,
and kaitosec's owner is an org-scoped member id — a different identifier that lives on the grant
as a claim because that is where the issuing server put it.

```ts
// server — the same organizationProcedure context kaitosec already has
app.post("/mesh/grant", async (req) => {
  const { session, organizationId } = await apiContext(req.headers);
  if (!session || !organizationId) return new Response(null, { status: 401 });
  const member = await getActiveMember(session, organizationId);
  const permissions = await modulePermissions(member.orgRoleId); // { controls: ["read","update"], … }
  const entities = await getAccessibleEntityIds(session.user.id, organizationId); // the CTE's answer, as ids

  const wire = issueGrant(issuer, {
    account: session.user.id,
    device: parsePeerId((await req.json()).devicePeerId).unwrap(),
    partitions: [parsePartitionKey(`org:${organizationId}`).unwrap()],
    claims: { member: member.id, role: member.role, permissions, entities },
    validFor: Temporal.Duration.from({ hours: 4 }),
    now: Temporal.Now.instant(),
  });
  return Response.json({ grant: bytesToHex(wire) });
});
```

```ts
export const controls = {
  open: query
    .input(z.object({ entityId: z.string().optional() }))
    .handler(({ input, mesh }) =>
      mesh.db
        .select()
        .from(control)
        .where(
          input.entityId === undefined
            ? eq(control.status, "open")
            : and(eq(control.status, "open"), eq(control.entityId, input.entityId)),
        ),
    ),

  raise: mutation
    .input(z.object({ title: z.string().min(1), entityId: z.string(), ownerMemberId: z.string() }))
    .handler(async ({ input, mesh }) => {
      const id = crypto.randomUUID();
      await mesh.db.insert(control).values({ id, ...input, status: "open" });
      return { id };
    }),
};
```

`await api.controls.raise({ … })` where the claims lack `controls:create` is an `Err` carrying
`PolicyDenied`: the capture transaction is refused before COMMIT, so there is no event, no
rollback to show, and nothing for the UI to undo. The same rule runs on every receiver, so a
device that lies about its own verdict is quarantined by everyone else.

**What the design buys here**

- kaitosec's audit found the hand-written `eq(t.organizationId, ctx.organizationId)` predicate
  missing in ~20 places. Here there is no predicate to forget: an `org` store holds one org, and
  the api is bound to it.
- Its 13 "nullable organizationId means global" tables split into a global table and an org
  overlay — the split its own schema already half-makes with `org_catalog_selection`.
- The 121 child tables without an org column need none.
- The permission matrix and entity access are evaluated on every device from the signed grant
  alone: no lookup, no network, the same answer everywhere.

**Two things decided here**

- `allow` is required on every table in a declared kind; the manifest throws at load without it.
  `user` and `local` tables need none (only the account or the device can reach them) and global
  tables are device-read-only.
- Writes are local-first, not optimistic. A mutation appends to the local log and folds before any
  network; the live query re-runs off that fold; there is no pending state to roll back. The only
  thing that undoes a write is a signed correction from the authority (E16), arriving as one more
  event — which is why `$sync` has a `$correction` axis beside it and not a fourth state.

**What the design does not do, said plainly**

- **`read` narrows a query, not a device's disk.** A device holding `org:acme` holds the org's
  rows; the `read` rule is what compiles to SQL for a caller a *server* acts as
  (`mesh.on(instance, { as })`, or Postgres RLS), and what a reviewer reads to know who may see a
  row. Narrowing what a device is *sent* is `interest` (RFC-0019, carried by D23's scoped
  cursors) — `relayTransport({ interest })` — and today an interest is what a device asks for, not
  an entitlement an authority imposes. The imposed version is §4's tier, and it is not built.
- **Entity access is a snapshot.** A member removed from an entity keeps the rows their last
  grant admitted until it is replaced or expires. That is why `validFor` is hours here, and why
  `grants.expiring` / `grants.renew` exist rather than a timer this library owns. Live revocation
  is E21.
- **Entities are not partitions.** A partition is the unit of *replication*; an entity is a
  *visibility* filter inside one. Making every entity a store would be hundreds of stores per org
  and would not model "descendants" anyway.
- **Global tables are read-only on devices.** The platform writes them through the authority
  (E16), checked on authorship rather than on a local flag, so every peer reaches the same
  verdict. A device that inserts into `catalog` gets `ReadOnlyPartition` — which is also how a
  forgotten `partition:` on a tenant table shows up on the first write in development, rather
  than as a silent leak.

---

## 4 · A sleep clinic platform — rows shared across tenants (Somnara's shape)

Clinics are organizations; a patient is one person who attends several clinics. The clinical
record — `patient`, `artifact`, `insurance`, `sleep_diary` — belongs to the patient, carries no org
column, and every clinic they attend may read and write it. A report becomes visible to the
patient only once `status = "signed"`; a video-consult token exists only in a time window and only
after the pre-consult questionnaire row exists.

This is the case a partition cannot carry. A partition is the unit of replication: a row is in
exactly one, and a device holds whole partitions. The patient record is not "in the clinic" (three
clinics share it) and not "in the user" (clinic staff need it); and "visible once signed" is a
predicate over the row's own state that changes with time.

The manifest names a third tier per table:

```ts
const clinic = partition("clinic", { roles: ladder("owner", "admin", "doctor", "staff") });

export const clinicSchema = () =>
  defineSchema({
    tables: {
      icd_code: { columns: fromDrizzle(drizzle.icdCode) }, // global
      booking: {
        columns: fromDrizzle(drizzle.booking),
        partition: clinic,
        allow: ({ role, owner, any }) => ({
          $default: role("staff"),
          update: any(owner("userId"), role("admin")),
        }),
      },
      schedule: {
        columns: fromDrizzle(drizzle.schedule),
        partition: clinic,
        allow: ({ role }) => ({ $default: role("staff") }),
      },

      patient: { columns: fromDrizzle(drizzle.patient), visibility: "authority" },
      artifact: { columns: fromDrizzle(drizzle.artifact), visibility: "authority" },
      sleep_diary: { columns: fromDrizzle(drizzle.sleepDiary), visibility: "authority" },
    },
  });
```

**The authority is the only author of a gated table (D24-A).** A device never writes one: the
validator holds such a table to the configured `authority` peer, checked on authorship, so a
device's insert is `ReadOnlyPartition` on every peer alike and there is no local verdict for
`can()` and `validate()` to disagree about. The app asks instead, and the ask is an `authority`
procedure — declared here, implemented on the server, and never carried into the app's bundle:

```ts
// clinic/api.ts — this file has no server code in it, and cannot acquire any
export const reports = {
  sign: authority.input(z.object({ id: z.string() })).returns<{ signedAt: number }>(),
};

export const diaries = {
  /** An ordinary read of the subset this device was admitted. */
  forPatient: query
    .input(z.object({ patientId: z.string() }))
    .handler(({ input, mesh }) =>
      mesh.db.select().from(sleepDiary).where(eq(sleepDiary.patientId, input.patientId)),
    ),
};

export const api = meshApi(mesh, { reports, diaries }, { instance, link });
```

`link` is how an `authority` call leaves the device — an HTTP client, a queue, a test double. With
no link configured the call fails naming itself rather than silently doing nothing, which is the
honest answer on a device that was never given a network. On the server the same procedure is
implemented over `withMesh(mesh)`, acting as the caller your own auth established, so the schema
stays the only permission model.

**What is not built.** The relay-side half — the gate that decides, from the app's own database,
which gated rows reach which device — does not exist. E08 records the attempt and its rejection;
D24 decides the framing (admission, not validation) and settles what an admitted subset costs on
the wire: a scoped cursor whose scope names the *entitlement*, or a device whose entitlement
widens keeps a cursor that silently skips what it was not allowed to see when it was narrower.
Until that lands, a `visibility: "authority"` table declares its intent, refuses device writes,
and is replicated like any other authority-written table.

The three tiers, side by side:

| Tier | Decided by | May read | Offline | Carries |
|---|---|---|---|---|
| Partition | structure: the table's kind, the row's instance, the grant | nothing | fully | tenant data — kaitosec's 174 tables, the practice's tables |
| Row rule (`allow`) | every device, from row + patch + grant claims | the grant | fully | roles, ownership, entity access as claims |
| Authority visibility | the relay | the app's database | after the authority has spoken once | rows shared across tenants; state- and time-dependent visibility |

**What the design does not do, said plainly**

- An authority-visibility row cannot be obtained peer-to-peer (over BLE, say) from a device that
  has it unless the authority admitted the receiver first. That is correct: a clinic phone must
  not be able to pull a patient's record from another clinic's phone because the two happened to
  meet.
- The tier gives up the offline *write*, and only that. The use-case table above never promised
  one: it promises reads held offline once the authority has spoken. Optimistic local writes plus
  an authority refusal is the split D24 rejected, and it becomes available only once the
  correction path (E16) has been tested against a tier with one author.
- Somnara's `key_org_id` — which org's AES key sealed a row — is application encryption, a column
  like any other. Somnara also has no offline layer today; it tests the model, it is not a
  customer of it.

---

## 5 · Onboarding through the mesh — a grant is bytes, any peer can carry them

The scenario with teeth: a new staff member's phone has **no internet**, but a colleague's device
in BLE range does. The new device still ends up with a verified grant, because nothing about a
grant requires the receiving device to talk to the issuer:

1. N mints its identity locally (`createIdentity` — offline, the key never leaves the device).
2. N hands its `peerId` to M over the local link. That is the whole request, and
   `mesh.requestGrant(invite)` is how a device makes it without anyone typing anything.
3. M has internet and calls the grant route **with N's peerId** — the §1 route already takes
   `devicePeerId` in the body, so this is not a new endpoint. A server holding the issuer key
   answers it; an owner's phone holding `issuerKey` answers `onGrantRequest` with `grants.issue`
   instead, and nothing else differs.
4. The signed grant rides back M → N. N verifies it offline against the issuer's public key from
   its config and registers it. Writes go through, and every `useCan(api.$can, …)` in the tree
   re-renders, because registration is what the hook subscribes to.

The carrier is a pipe, provably: flip one byte and registration fails on the signature; register
someone else's grant and it answers for *their* device key, not yours (`grantFor` is by device).
The same shape covers the serverless org — the issuer keypair on the owner's phone instead of a
server, grants minted in the room — and device linking, where an already-granted phone requests a
grant *for* the laptop's peerId under the same account.

Ordering is the part the transport owns: events from an author you hold no grant for quarantine on
`NoGrant` and are never stored; a session sends grants before any event, and when the grant lands
a resync converges. All four scenarios are pinned by
`packages/client/src/__tests__/onboarding.test.ts`, which drives two engines over an in-process
link; `examples/src/rounds` runs the same shape over a framed transport with an offline switch,
and nothing above the link changes between them.

What stays impossible by design: instant revocation without ever reaching the issuer. Expiry is
the staleness bound (D08) — renewal is one more grant frame, relayed exactly like onboarding, and
`grants.expiring` is where an authority finds what to renew.

---

## The choices, and which case defends each

| Choice | Defended by |
|---|---|
| `api.*` is the only surface an app touches; Drizzle lives in handlers | all — the component names the operation, and the shape of a read is testable where it is written |
| `query` and `mutation` unmarked, `authority` marked | 1, 4 — running on the device is the ordinary case; needing a server is what a reader must notice |
| A query is inert until something runs it; a mutation has already started | 1 — the hook subscribes to a read, and a fire-and-forget write must not need a hook to happen |
| `partition` is per table and per api binding, never per write | 2, 3 — the per-call org id is the bug both codebases have |
| One store per top-level instance; switching org opens another mesh | 2 — the switcher is a binding, not a mutable ambient setting, and leaving is deleting a file |
| No `partitions` key needed; `user`, `local`, `global` built in | 1 |
| No `partition` → `global`, device-read-only, authority-authored | 2, 3 — catalogs; the read-only rule makes the default safe |
| `partitions` is a tree of kinds, no `isolation`, no `parent` strings | 2, 3 — top-level means own store; nesting is structural |
| `roles` ladder is optional; grants carry claims; `claim(name).has/.equals(column)`, `can` as sugar | 3 — roles are data there, and a ladder cannot express a matrix |
| `$default` required in every `allow` block | 2, 3 — "any member" is stated, never implied |
| Merge rules on the column (`t.float({ merge: "max" })`, `fromDrizzle(t, { merge })`) | 2, 3 — one home, typed against the columns, and no `.default()` to pretend a value nobody wrote |
| One entry shape `{ columns, partition?, allow?, visibility? }` | all — `fromDrizzle` returns columns |
| `Err(…)` at the call site, quarantine at every receiver | all — the UI check is courtesy, the receiver check is security |
| `isSettled` beside `isPending` | 1 — "no notes" and "the relay has not answered" are different states, and only one draws a spinner |
| `$sync` per row rather than a promise per write | 1, 5 — a write made offline on Tuesday syncs on Thursday, long after that promise is gone |
| `visibility: "authority"` as a third tier, not a partition | 4 — rows shared across tenants; state- and time-dependent visibility |
| The authority is a gated table's only author | 4 — one author is one verdict, so the split that sank the first attempt is unrepresentable |
| Writes local-first, never optimistic | 1, 3 — the local log is the truth on the device, and a correction is an event, not a rollback |
