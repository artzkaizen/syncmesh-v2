import type { SqlValue } from "@syncmesh/storage";
/**
 * The Durable Object the crash suite runs in workerd: `doSqliteDriver` over the object's own
 * `ctx.storage.sql`, written one batch per call by the suite's own writer.
 *
 * Bundled by `harness.ts` and loaded into Miniflare; never imported by a test. Each call is one
 * turn, and the turn is the only transaction a Durable Object has, so a batch is whole on disk
 * or absent — which is what the suite checks after the runtime is killed, or after the object is
 * reset part-way through a batch.
 */
import type { CrashMode } from "@syncmesh/storage/driver-tests";
import type { DurableObjectState } from "cloudflare:workers";

import { crashWriter } from "@syncmesh/storage/driver-tests";
import { DurableObject } from "cloudflare:workers";

import type { DurableSqlStorage } from "../../driver.js";

import { doSqliteDriver } from "../../driver.js";

/**
 * What one {@link CrashRoom.step} wrote: the batch's highest sequence, and how many statements it
 * took. A pair rather than an object: Miniflare hands a returned object back as a stub to fetch
 * its fields from, and an array as the values.
 */
export type Stepped = readonly [committed: number, statements: number];

/** The fixture's bindings: none. */
type Env = Record<never, never>;

export class CrashRoom extends DurableObject<Env> {
  /** Statements run since the current step began, and the count at which to reset the object. */
  #statements = 0;
  #abortAt: number | undefined;
  readonly #driver;
  #writer: ReturnType<typeof crashWriter> | undefined;
  #mode: CrashMode | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    const counted: DurableSqlStorage = {
      exec: (query, ...bindings) => {
        this.#statements += 1;
        // the reset lands in the middle of the batch, after `abortAt - 1` of its statements ran
        if (this.#statements === this.#abortAt) ctx.abort(`reset at statement ${this.#abortAt}`);
        return sql.exec(query, ...bindings);
      },
    };
    this.#driver = doSqliteDriver(counted);
  }

  /**
   * Writes the next batch in `mode`, carrying on from what the log holds. With `abortAt`, the
   * object is reset at that statement of the batch and the call never answers.
   */
  async step(mode: CrashMode, abortAt?: number): Promise<Stepped> {
    if (this.#mode !== mode) {
      this.#mode = mode;
      this.#writer = crashWriter(this.#driver, mode);
    }
    const write = await this.#writer!;
    this.#statements = 0;
    this.#abortAt = abortAt;
    const committed = await write();
    this.#abortAt = undefined;
    return [committed, this.#statements];
  }

  /** The driver's `run`, across the RPC boundary: how the suite reads the log back. */
  async run(statement: string, params: readonly SqlValue[]): Promise<void> {
    await this.#driver.run(statement, params);
  }

  /** The driver's `all`, across the RPC boundary. */
  all(statement: string, params: readonly SqlValue[]) {
    return this.#driver.all(statement, params);
  }
}

export default { fetch: () => new Response("crash fixture") };
