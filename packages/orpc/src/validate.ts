import type { Result as ResultType } from "@syncmesh/result";
import type { StandardSchemaV1 } from "@syncmesh/schema";

import { Result } from "@syncmesh/result";

import { InputInvalid, SchemaNotSynchronous } from "./errors.js";

/* oxlint-disable anti-slop/no-unknown-parameters -- the I/O boundary itself: turning an unparsed input into `I` is what these three exist to do, and `Api<R>` types every call site above them */
export const validate = <I>(
  schema: StandardSchemaV1 | undefined,
  input: unknown,
): ResultType<I, Error> => {
  if (schema === undefined) {
    // SAFETY: no schema means the procedure declared no input, so `I` is `void` and this asserts nothing about the value
    const bare = input as I;
    return Result.ok(bare);
  }
  const outcome = schema["~standard"].validate(input);
  if (outcome instanceof Promise)
    return Result.err(
      new SchemaNotSynchronous({ message: "an input schema must validate synchronously" }),
    );
  if (outcome.issues !== undefined)
    return Result.err(
      new InputInvalid({ message: outcome.issues.map((i) => i.message).join("; ") }),
    );
  // SAFETY: Standard Schema guarantees `value` is the schema's output once `issues` is absent, and `I` is that output — `query`/`mutation` tie the two together with `Output<S>`
  const parsed = outcome.value as I;
  return Result.ok(parsed);
};
