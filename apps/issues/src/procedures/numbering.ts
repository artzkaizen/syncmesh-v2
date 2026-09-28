import { mutation } from "@syncmesh/orpc";
import * as z from "zod";

import { Id, scoped } from "../domain.js";

/**
 * `ENG-42`: the one thing in this tracker a device cannot decide for itself.
 *
 * A gapless per-team sequence is a fact about every device at once, and no amount of local
 * cleverness produces one. Two people filing an issue on two planes both compute "the highest
 * number I have seen, plus one" and both get 42; when the planes land, one of them has to lose
 * an identifier they have already put in a commit message. LiveStore's Linear clone makes
 * exactly this choice — `highestIssueId$ + 1` as the primary key — and carries a `TODO` about
 * it, which is the honest version of the same story.
 *
 * So the number is not the identity. The identity is a UUID allocated on the device, and the
 * number is a *later fact* an authority attaches. Until it lands the issue exists, syncs,
 * merges and can be commented on; it just renders as `ENG-•`.
 *
 * The `.authority()` terminal is where the body would be, and there is none: after
 * `.output(...)` the chain has no `.handler`, so a body cannot be written in shared code by
 * mistake. What ships to the device is this declaration. The server's half lives in
 * `../authority.ts` and is checked against this shape at the object literal.
 */
export const claimNumber = mutation
  .route({ method: "POST", path: "/issues/{issueId}/number", tags: ["issues"] })
  .input(scoped({ issueId: Id }))
  .output(z.object({ number: z.int().min(1), identifier: z.string().min(3) }))
  .errors({
    NO_SUCH_ISSUE: { message: "the issue has not reached the authority yet" },
    NO_SUCH_TEAM: { message: "the issue names a team the authority does not hold" },
  })
  .authority();
