// Cases for `syncmesh/no-server-import-in-app`. The rule keys on the file's own path — this file
// sits under `app/`, which is what makes it a client file — and on the import's path. The
// repository lints nothing under tools/oxlint, so run this by hand from the fixture directory:
//
//   ../../../../node_modules/.bin/oxlint --config .oxlintrc.json app/imports.ts
//
// Every line under "should report" must produce one diagnostic, and nothing under
// "should NOT report" may produce any.

// should report — a runtime import of a server module ships the body to the client bundle
import { claimNumber } from "../server/body.js";
import * as bodies from "../server/body.js";
import { claimNumber as viaSuffix } from "./numbering.server.js";

// should NOT report — a type carries no body, and the mirror type is meant to be shared
import type { Claimed } from "../server/body.js";
// nor a sibling under app/, whatever it is called
import { shared } from "./contract.js";

export const uses = [claimNumber, bodies, viaSuffix, shared];
export type Mirror = Claimed;
