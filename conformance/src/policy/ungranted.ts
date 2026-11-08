/** The ungranted mesh with accounts on: a link is the only author a rule ever sees (D21). */
import type { Mesh } from "./changes.js";

import { createAuthors, doc, insert, linkRow, remove, update } from "./changes.js";
import { ACCOUNT, ACME, BETA, LINKED, MEMBER, STRANGER, VIEWER, part } from "./schema.js";

/** Every author unvouched for, unless a link vouches for it. */
export function ungrantedMesh(): Mesh {
  const { by } = createAuthors();
  const linkAccount = String(ACCOUNT.peerId);
  return {
    description: "ungranted with accounts: a link is the only author a rule ever sees",
    granted: false,
    accounts: true,
    steps: [
      {
        description: "no author: every rule is skipped, the schema never is",
        events: [
          by(STRANGER, [insert("notes", "n1", { title: "x", ownerId: linkAccount })]),
          by(STRANGER, [insert("notes", "n2", { title: 1, ownerId: linkAccount })]),
          by(STRANGER, [insert("profiles", "p1", { name: "anyone" })], part("user:whoever")),
        ],
      },
      {
        description: "links: a device claims only itself, alone, with the account's signature",
        events: [
          by(LINKED, [linkRow(ACCOUNT, LINKED, ACME, "link")]),
          by(STRANGER, [linkRow(ACCOUNT, MEMBER, ACME, "link")]),
          by(MEMBER, [linkRow(ACCOUNT, MEMBER, ACME, "link", { sign: VIEWER })]),
          by(MEMBER, [linkRow(ACCOUNT, MEMBER, ACME, "link", { kind: 1 })]),
          by(MEMBER, [linkRow(ACCOUNT, MEMBER, BETA, "link")]),
          by(MEMBER, [
            linkRow(ACCOUNT, MEMBER, ACME, "link"),
            insert("notes", "n9", { title: "x", ownerId: "a" }),
          ]),
          by(MEMBER, [doc("_links", "x")]),
        ],
      },
      {
        description: "a linked device answers to its account, with no role",
        events: [
          by(LINKED, [update("notes", "n1", { title: "owned" })]),
          by(LINKED, [insert("notes", "n3", { title: "x", ownerId: linkAccount })]),
          by(LINKED, [insert("profiles", "p2", { name: "mine" })], part(`user:${linkAccount}`)),
          by(LINKED, [insert("profiles", "p3", { name: "not mine" })], part("user:someone")),
        ],
      },
    ],
    probes: [
      {
        description: "an unlinked device is judged by the schema alone",
        event: by(STRANGER, [insert("tasks", "t1", { title: "x", done: true })]),
      },
      { description: "a linked device's role rule", event: by(LINKED, [remove("notes", "n1")]) },
    ],
  };
}
