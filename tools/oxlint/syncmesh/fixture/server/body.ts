// The server-only half a screen must never pull in: an authority body. Imported by `app/imports.ts`
// to give `syncmesh/no-server-import-in-app` something to report.

export const claimNumber = () => 42;
export type Claimed = { readonly number: number };
