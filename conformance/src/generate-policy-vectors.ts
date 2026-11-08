/**
 * Regenerates conformance/policy-vectors.json from fixed seeds. Run only when the ladder
 * deliberately changes (README rule 3): `bun conformance/src/generate-policy-vectors.ts`.
 *
 * The shared validator's verdict on every event (gap U3): a manifest as the data a port reads
 * (`portableSchema`), the grants each author holds, and batches of signed events handed to one
 * device in order. Each step records what the device folded and what it parked, in which bucket,
 * under which verdict tag; `probes` are writes judged as this device's own, before they are
 * numbered. Both runtimes run the same steps and must park the same events the same way. The
 * cases live in `policy/`, one module per part of the ladder.
 */
import {
  createEngine,
  createMemoryEventStore,
  createValidator,
  type ValidationError,
} from "@syncmesh/engine";
import { createHlcClock, readRows, type RowKey, type TableName } from "@syncmesh/kernel";
import { portableSchema } from "@syncmesh/schema";
import { Temporal } from "@syncmesh/temporal";
import { createGrantRegistry, decodeAndVerify, hexToBytes } from "@syncmesh/wire";

import type { Mesh } from "./policy/changes.js";

import { grantWire, grants } from "./policy/changes.js";
import { grantedMesh } from "./policy/granted-rules.js";
import {
  AUTHORITY,
  DEVICE,
  ISSUER,
  MINUTE,
  NOW,
  NOW_MS,
  docs,
  policySchema,
  table,
} from "./policy/schema.js";
import { ungrantedMesh } from "./policy/ungranted.js";

export { policySchema } from "./policy/schema.js";

/** What a vector pins of a verdict: its tag, and the rung or operation it names. */
const verdictFields = (error: ValidationError) => ({
  verdict: error._tag,
  ...("rung" in error && { rung: error.rung }),
  ...("op" in error && { op: error.op }),
});

/** Runs one mesh's steps on a fresh TypeScript device and records what it did. */
export async function runPolicyMesh(mesh: Mesh) {
  const registry = createGrantRegistry({ issuer: ISSUER.peerId, now: () => NOW });
  for (const spec of grants) registry.register(hexToBytes(grantWire(spec)).unwrap()).unwrap();
  const validate = createValidator({
    schema: policySchema,
    grantFor: mesh.granted ? registry.grantFor : null,
    authority: AUTHORITY.peerId,
    now: () => NOW,
    maxDrift: Temporal.Duration.from({ minutes: 5 }),
    docs,
    ...(mesh.accounts && { accounts: true }),
  });
  const engine = createEngine({
    peerId: DEVICE.peerId,
    clock: createHlcClock({ now: () => NOW }),
    store: createMemoryEventStore(),
    merge: policySchema.merge,
    docs,
    validate,
  });
  const steps = [];
  for (const step of mesh.steps) {
    const entries = step.events.map((hex) => decodeAndVerify(hexToBytes(hex).unwrap()).unwrap());
    const report = (await engine.receiveBatch(entries)).unwrap();
    steps.push({
      description: step.description,
      events: step.events,
      report,
      parked: engine.quarantine().map((p) => ({
        id: String(p.entry.event.id),
        reason: p.reason,
        ...verdictFields(p.verdict),
      })),
    });
  }
  const state = engine.state();
  const rows = Object.fromEntries(
    [...state.keys()]
      .map(String)
      .sort()
      .map((tbl) => [tbl, [...readRows(state, table(tbl)).keys()].map(String).sort()]),
  );
  const lookup = {
    row: (tbl: TableName, k: RowKey) => readRows(engine.state(), tbl).get(k),
    records: (tbl: TableName) => engine.state().get(tbl),
    partition: (tbl: TableName, k: RowKey) => engine.state().get(tbl)?.get(k)?.partition,
  };
  const probes = mesh.probes.map((probe) => {
    const { event } = decodeAndVerify(hexToBytes(probe.event).unwrap()).unwrap();
    const verdict = validate.validate(
      {
        peerId: event.peerId,
        changes: event.changes,
        ...(event.partition !== undefined && { partition: event.partition }),
      },
      lookup,
    );
    return {
      description: probe.description,
      event: probe.event,
      ...(verdict.isErr() ? verdictFields(verdict.error) : { verdict: null }),
    };
  });
  return {
    description: mesh.description,
    granted: mesh.granted,
    accounts: mesh.accounts,
    steps,
    rows,
    probes,
  };
}

export async function policyVectors() {
  return {
    issuer: ISSUER.peerId,
    authority: AUTHORITY.peerId,
    device: DEVICE.peerId,
    nowMs: NOW_MS,
    maxDriftMs: 5 * MINUTE,
    grants: grants.map(grantWire),
    schema: portableSchema(policySchema),
    meshes: [await runPolicyMesh(grantedMesh()), await runPolicyMesh(ungrantedMesh())],
  };
}

if (import.meta.main) {
  const out = new URL("../policy-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(await policyVectors(), null, 2)}\n`);
}
