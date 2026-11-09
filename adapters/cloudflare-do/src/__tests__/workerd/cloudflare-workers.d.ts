/**
 * The one export of workerd's `cloudflare:workers` the crash fixture uses, declared here rather
 * than taken from `@cloudflare/workers-types`: this package names the platform structurally
 * everywhere else (`DurableSqlStorage`), and the fixture is bundled for workerd, never run by Bun.
 */
declare module "cloudflare:workers" {
  import type { DurableSqlStorage } from "../../driver.js";

  /** The slice of `DurableObjectState` the fixture reaches: its SQL, and the reset. */
  export interface DurableObjectState {
    readonly storage: { readonly sql: DurableSqlStorage };
    /** Resets the object: what the turn wrote and had not committed is gone with it. */
    abort(reason?: string): void;
  }

  /** The base class an RPC-callable Durable Object extends. */
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
