import { mutation, query } from "@syncmesh/orpc";
import { asc, desc, eq } from "drizzle-orm";
import * as z from "zod";

import { observation, patient } from "./schema.js";

/**
 * The app's API. Every read and every write an app performs is one of these, and Drizzle appears
 * only inside a handler — a component names `api.observations.forPatient({ … })` and nothing else
 * (D26).
 */

export const patients = {
  list: query.handler(({ db }) => db.select().from(patient).orderBy(asc(patient.bed))),

  admit: mutation
    .input(z.object({ id: z.string(), name: z.string().min(1), bed: z.string().min(1) }))
    .handler(async ({ input, db }) => {
      await db.insert(patient).values(input);
      return input;
    }),
};

export const observations = {
  /** One patient's readings, newest first. Live: another clinician's entry arrives as a re-render. */
  forPatient: query
    .input(z.object({ patientId: z.string() }))
    .handler(({ input, db }) =>
      db
        .select()
        .from(observation)
        .where(eq(observation.patientId, input.patientId))
        .orderBy(desc(observation.takenAt)),
    ),

  record: mutation
    .input(
      z.object({
        patientId: z.string(),
        code: z.string().min(1),
        value: z.string().min(1),
        takenAt: z.number().int(),
        author: z.string().min(1),
      }),
    )
    .handler(async ({ input, db }) => {
      const id = crypto.randomUUID();
      await db.insert(observation).values({ id, ...input, amends: null });
      return { id };
    }),

  /**
   * A correction is a new row naming the one it replaces. Nothing is edited and nothing is
   * deleted, so a reading taken on a ward with no signal cannot be lost by a later one.
   */
  amend: mutation
    .input(z.object({ amends: z.string(), value: z.string().min(1), author: z.string().min(1) }))
    .handler(async ({ input, db }) => {
      const [previous] = await db
        .select()
        .from(observation)
        .where(eq(observation.id, input.amends));
      if (previous === undefined) throw new Error(`no observation ${input.amends} to amend`);
      const id = crypto.randomUUID();
      await db.insert(observation).values({
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

/** What the app can do. `createApp` binds it to a mesh and a ward; nothing here knows either. */
export const procedures = { patients, observations };
