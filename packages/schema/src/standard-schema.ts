/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- this is the Standard Schema interface as published (standardschema.dev); its shape is not ours to change */

/** The Standard Schema contract, declared structurally so zod, valibot and arktype all satisfy it with no dependency. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardIssue[] };

export interface StandardIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

export type Output<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */
