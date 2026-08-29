import type { Mesh } from "@syncmesh/client";

import { local, meshApi } from "@syncmesh/orpc";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { PRACTICE, observation, patient } from "./schema.js";

/**
 * The app's API. Every read and every write an app performs is one of these, and Drizzle appears
 * only inside a handler — a component names `api.observations.forPatient({ … })` and nothing else
 * (D26).
 */

export const patients = {
  list: local.query.handler(({ mesh }) => mesh.db.select().from(patient).orderBy(asc(patient.bed))),

  admit: local.mutation
    .input(z.object({ id: z.string(), name: z.string().min(1), bed: z.string().min(1) }))
    .handler(async ({ input, mesh }) => {
      await mesh.db.insert(patient).values(input);
      return input;
    }),
};

export const observations = {
  /** One patient's readings, newest first. Live: another clinician's entry arrives as a re-render. */
  forPatient: local.query
    .input(z.object({ patientId: z.string() }))
    .handler(({ input, mesh }) =>
      mesh.db
        .select()
        .from(observation)
        .where(eq(observation.patientId, input.patientId))
        .orderBy(desc(observation.takenAt)),
    ),

  record: local.mutation
    .input(
      z.object({
        patientId: z.string(),
        code: z.string().min(1),
        value: z.string().min(1),
        takenAt: z.number().int(),
        author: z.string().min(1),
      }),
    )
    .handler(async ({ input, mesh }) => {
      const id = crypto.randomUUID();
      await mesh.db.insert(observation).values({ id, ...input, amends: null });
      return { id };
    }),

  /**
   * A correction is a new row naming the one it replaces. Nothing is edited and nothing is
   * deleted, so a reading taken on a ward with no signal cannot be lost by a later one.
   */
  amend: local.mutation
    .input(z.object({ amends: z.string(), value: z.string().min(1), author: z.string().min(1) }))
    .handler(async ({ input, mesh }) => {
      const [previous] = await mesh.db
        .select()
        .from(observation)
        .where(eq(observation.id, input.amends));
      if (previous === undefined) throw new Error(`no observation ${input.amends} to amend`);
      const id = crypto.randomUUID();
      await mesh.db.insert(observation).values({
        id,
        patientId: previous.patientId,
        code: previous.code,
        value: input.value,
        takenAt: Date.now(),
        author: input.author,
        amends: input.amends,
      });
      return { id };
    }),
};

/** Bound to one mesh and one ward; import this and nothing else. */
export const roundsApi = (mesh: Mesh) =>
  meshApi(mesh, { patients, observations }, { instance: PRACTICE });
