/** The granted mesh's later steps and probes: documents, the rule combinators, batches, links. */
import type { AdapterId } from "@syncmesh/kernel";

import { parseSeqNum } from "@syncmesh/kernel";
import { deriveLineage } from "@syncmesh/wire";

import type { Authors, Mesh, Step } from "./changes.js";

import { createAuthors, doc, insert, linkRow, remove, update } from "./changes.js";
import { firstSteps } from "./granted-cells.js";
import {
  ACCOUNT,
  ACME,
  ADMIN,
  BETA,
  GAMMA,
  LINKED,
  MEMBER,
  STRICT,
  VIEWER,
  column,
  name,
} from "./schema.js";

const documents = ({ by }: Authors): Step => {
  const genesis = doc("notes", "n1", { genesis: true });
  return {
    description: "documents: the schema's rungs, then the policy's",
    events: [
      by(MEMBER, [doc("notes", "n1", { column: column("title") })]),
      by(MEMBER, [doc("notes", "n1", { adapter: name<AdapterId>("automerge@3") })]),
      by(MEMBER, [doc("notes", "n1", { genesis: true, legacy: true })]),
      by(MEMBER, [
        doc("notes", "n1", {
          genesis: true,
          lineage: deriveLineage(MEMBER.peerId, parseSeqNum(1).unwrap(), 0),
        }),
      ]),
      by(MEMBER, [genesis, doc("notes", "n1", { genesis: true })]),
      by(MEMBER, [doc("notes", "n1")]),
      by(VIEWER, [doc("notes", "n1")]),
      by(MEMBER, [genesis]),
      by(ADMIN, [genesis]),
      by(MEMBER, [doc("notes", "zz")]),
      by(MEMBER, [doc("ghostdoc", "n1")]),
      by(MEMBER, [insert("boards", "b1", { title: "x" }), doc("boards", "b1", { genesis: true })]),
      by(MEMBER, [doc("boards", "b1", { genesis: true })]),
      by(VIEWER, [doc("boards", "b1", { genesis: true })]),
      by(VIEWER, [insert("boards", "b2", { title: "x" }), doc("boards", "b2")]),
    ],
  };
};

const combinators = ({ by }: Authors): Step => ({
  description: "the rule combinators",
  events: [
    by(VIEWER, [
      insert("tasks", "v1", {
        title: "x",
        done: false,
        projectId: "p2",
        archived: true,
        label: "red",
      }),
    ]),
    by(VIEWER, [insert("tasks", "v2", { title: "x", done: false, projectId: "p9" })]),
    by(VIEWER, [update("tasks", "t1", { done: true, points: 1 })]),
    by(VIEWER, [insert("tasks", "v3", { title: "x", done: false, projectId: null, label: "red" })]),
    by(VIEWER, [update("tasks", "t1", { label: "dup" })]),
    by(VIEWER, [update("tasks", "t1", { title: "renamed" })]),
    by(VIEWER, [update("tasks", "v1", { done: true })]),
    by(MEMBER, [remove("tasks", "t1")]),
    by(MEMBER, [remove("tasks", "v1")]),
    by(ADMIN, [update("ranks", "nothing", { title: "x" })]),
    by(VIEWER, [insert("ranks", "k1", { title: "zed", score: null })]),
    by(VIEWER, [insert("ranks", "k2", { title: "abc", score: 10 })]),
    by(VIEWER, [insert("ranks", "k3", { title: "abc", score: 9 })]),
    by(VIEWER, [insert("ranks", "k4", { title: "\u{1F600}" })]),
    by(VIEWER, [insert("ranks", "k5", { title: "｡" })]),
    by(VIEWER, [update("ranks", "k1", { title: "locked" })]),
    by(VIEWER, [update("ranks", "k1", { score: 1 })]),
  ],
});

const batchOverlay = ({ by }: Authors): Step => ({
  description: "a batch is judged as it arrived: an update rides on the insert beside it",
  events: [
    by(MEMBER, [insert("notes", "p1", { title: "x", ownerId: "acct_member" })]),
    by(MEMBER, [update("notes", "p1", { title: "y" })]),
    by(MEMBER, [remove("notes", "p1")]),
    by(ADMIN, [insert("notes", "q1", { title: "x", ownerId: "acct_admin" })], BETA),
    by(VIEWER, [insert("notes", "q2", { title: "x", ownerId: "acct_viewer" })], BETA),
    by(VIEWER, [insert("notes", "q3", { title: "x", ownerId: "acct_viewer" })], GAMMA),
    by(ADMIN, [update("notes", "n1", { title: "moved" })], BETA),
  ],
});

const updateBeforeRow = ({ sign }: Authors): Step => ({
  description: "an update before its row, then the row: refused, then re-offered and folded",
  events: [sign(MEMBER, [update("notes", "late", { title: "y" })], { partition: ACME, seq: 90 })],
});

const rowLands = ({ sign }: Authors): Step => ({
  description: "the row lands, and the parked update is taken on the retry",
  events: [
    sign(MEMBER, [insert("notes", "late", { title: "x", ownerId: "acct_member" })], {
      partition: ACME,
      seq: 89,
    }),
  ],
});

const links = ({ by }: Authors): Step => ({
  description: "links are subject-signed, granted mode or not",
  events: [
    by(ADMIN, [linkRow(ACCOUNT, LINKED, ACME, "link")]),
    by(ADMIN, [linkRow(ACCOUNT, ADMIN, ACME, "unlink")]),
    by(ADMIN, [remove("_links", "x")]),
  ],
});

/** Every rung, with an issuer vouching for every author. */
export function grantedMesh(): Mesh {
  const authors = createAuthors();
  const { by } = authors;
  return {
    description: "granted: an issuer vouches for every author",
    granted: true,
    accounts: false,
    steps: [
      ...firstSteps(authors),
      documents(authors),
      combinators(authors),
      batchOverlay(authors),
      updateBeforeRow(authors),
      rowLands(authors),
      links(authors),
    ],
    probes: [
      {
        description: "a retired table refuses this device's own write",
        event: by(MEMBER, [insert("archive", "a2", { title: "x" })]),
      },
      {
        description: "a retired column too, null included",
        event: by(MEMBER, [update("notes", "n1", { legacy: null })]),
      },
      {
        description: "a derived column is never written",
        event: by(MEMBER, [update("notes", "n1", { summary: "x" })]),
      },
      {
        description: "an owner's edit",
        event: by(MEMBER, [update("notes", "n1", { title: "edit" })]),
      },
      {
        description: "a genesis on a probe names no lineage yet",
        event: by(ADMIN, [doc("notes", "n1", { genesis: true })]),
      },
      {
        description: "an owner may edit and not replace",
        event: by(MEMBER, [doc("notes", "n1", { genesis: true })]),
      },
      {
        description: "a local table's write is not local here",
        event: by(MEMBER, [insert("drafts", "d2", { body: "x" })], null),
      },
      {
        description: "a stale grant is judged against now",
        event: by(MEMBER, [insert("notes", "g3", { title: "x", ownerId: "acct_member" })], STRICT),
      },
    ],
  };
}
