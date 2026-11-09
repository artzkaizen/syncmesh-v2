import { crashTests, tornTests } from "@syncmesh/storage/driver-tests";
import { afterAll, beforeAll, describe, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bundleRoom, workerdHarness, workerdTornHarness } from "./workerd/harness.js";

/**
 * O16 on a real workerd: the crash suite every device driver passes, run against
 * `doSqliteDriver` over a Durable Object's own `ctx.storage.sql`, in Miniflare.
 *
 * Two deaths. `sigkill` is the `kill -9` the device suites use, aimed at workerd itself while the
 * object steps through batches. `reset` is the object calling `ctx.abort()` part-way through a
 * batch, a different statement each round: the turn is the only transaction a Durable Object
 * has, so a reset inside it must take the whole batch with it.
 *
 * Then the torn suite, on the object's own file: zeros written into a page while no runtime
 * holds it, read back through a fresh one.
 */
const dir = mkdtempSync(join(tmpdir(), "syncmesh-do-crash-"));
let script = "";
beforeAll(async () => void (script = await bundleRoom(dir)), 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }), 60_000);

for (const death of ["sigkill", "reset"] as const)
  describe(`@syncmesh/cloudflare-do survives ${death === "sigkill" ? "kill -9 of workerd" : "a reset mid-batch"}`, () => {
    const harness = workerdHarness(() => script, join(dir, death), death);
    for (const c of crashTests(harness)) test(c.name, c.run, 120_000);
  });

/**
 * The one torn case a Durable Object does not take, and why: it asks the open to check the pages
 * after a session that never reached `close`, and an inline log keeps no session (D39). The
 * object's storage is the platform's, which survives the object; there is no device to lose
 * power under it. `verifyLog` still checks the pages on demand, and the read still refuses a hole.
 */
const NO_SESSION = "torn: after an unclean shutdown, the open checks the pages first";

describe("@syncmesh/cloudflare-do refuses a torn log rather than reading around it (D39)", () => {
  const harness = workerdTornHarness(() => script, join(dir, "torn"));
  for (const c of tornTests(harness)) if (c.name !== NO_SESSION) test(c.name, c.run, 120_000);
});
