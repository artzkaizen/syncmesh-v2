# Rounds — the app API, end to end

A clinician walks a ward with no signal. Two phones. A reading recorded on one appears on the
other. Nothing is ever edited, so two people recording the same patient while apart both survive.

```sh
bun run --cwd examples rounds
```

```
raj sees: BP 128/84
raj's reading while offline: local
ann: BP=126/82 (amends) | HR=88 | BP=128/84
raj: BP=126/82 (amends) | HR=88 | BP=128/84
raj's reading after reconnect: delivered
```

Both devices end with the same three rows: Ann's original reading, Raj's reading taken while the
radio was down, and Ann's amendment — which is a **new row naming the one it replaces**, not an
edit. Nothing chose between them.

## What a developer writes

Three files, and only one of them is the API.

- `schema.ts` — the Drizzle tables, and the manifest saying what syncs, which instance it hangs
  under, and who may write it. `observation` denies `$default` and allows only `read` and
  `insert`, so an update or a delete is refused before the transaction commits, on every device.
- `api.ts` — **the app's API.** Every read and write is a a `query` or a `mutation`.
  Drizzle appears inside a handler and nowhere else.
- `device.ts` — this script.

## Calling it

```ts
const api = roundsApi(mesh);

await api.observations.record({ patientId: "p1", code: "BP", value: "128/84", … });
const rows = await api.observations.forPatient({ patientId: "p1" }).run();
```

A mutation runs eagerly and returns `Result<{ eventId, data }, …>`; a query is inert until
something runs it. In React that something is the hook, and the component names the call and
nothing else — no handle, no `db`, no query builder:

```tsx
function Observations({ patientId }: { readonly patientId: string }) {
  const { data, isPending, isSettled } = useLiveQuery(api.observations.forPatient({ patientId }));

  if (isPending) return <Spinner />;
  if (data.length === 0) return isSettled ? <NoReadings /> : <StillSyncing />;

  return data.map((o) => (
    <Row key={o.id} dimmed={mesh.syncOf("observation", o.id) === "local"}>
      {o.code} {o.value}
    </Row>
  ));
}
```

`isSettled` is the difference between _there are no readings_ and _the relay has not answered
yet_. `syncOf` is the difference between a reading that has reached another device and one still
waiting for a radio — per row, so it survives the app restarting, which a promise from the call
that made the write does not.

## What this demo fakes

The radio is `loopbackPair`, an in-process link with an offline switch. On a phone it is
`bleTransport` over `@syncmesh/rn-ble`; the mesh is configured with a different `transports`
entry and nothing above it changes.

Grants are handed out by the script. A real device asks — `mesh.requestGrant(invite)` — and the
grant arrives over the link. Both devices need both grants either way: a receiver admits an
author it can vouch for, so a phone that has never heard of the clinician at the next bed
quarantines her readings rather than folding them.
