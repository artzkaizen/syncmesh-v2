/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- this is the Standard Schema interface as published (standardschema.dev); its shape is not ours to change */

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

/**
 * The Standard JSON Schema extension (standardschema.dev/json-schema): a validator that can say
 * what it accepts as JSON Schema. zod 4.2 and later carry it on `~standard`.
 */
export interface StandardJSONSchemaV1Props {
  readonly jsonSchema: {
    readonly input: (options: {
      readonly target: "draft-2020-12" | "draft-07" | "openapi-3.0";
      /** The vendor's own converter options (zod: `toJSONSchema`'s params, `override` among them). */
      readonly libraryOptions?: Record<string, unknown>;
    }) => Record<string, unknown>;
  };
}

/**
 * Whether a validator's `~standard` names {@link StandardJSONSchemaV1Props}. Only the name is
 * checked: a caller runs the converter inside `Result.try`, so one of another shape is a value.
 */
export const speaksJsonSchema = (
  standard: StandardSchemaV1["~standard"],
): standard is StandardSchemaV1["~standard"] & StandardJSONSchemaV1Props =>
  "jsonSchema" in standard;

export type Output<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */
