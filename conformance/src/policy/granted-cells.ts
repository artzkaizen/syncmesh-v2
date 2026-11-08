/** The granted mesh's first steps: who may write, where, and with what cells (gap U3). */
import type { Authors, Step } from "./changes.js";

import { insert, remove } from "./changes.js";
import {
  ACME,
  ADMIN,
  AUTHORITY,
  BETA,
  GAMMA,
  LEAD,
  MEMBER,
  MINUTE,
  NOW_MS,
  OUTSIDER,
  REVOKED,
  STRANGER,
  STRICT,
  TEAM,
  key,
  part,
  table,
} from "./schema.js";

const authorityPublishes = ({ by }: Authors): Step => ({
  description:
    "the authority publishes rules for org:beta, garbage for org:gamma, a grace window for org:strict, and revokes one device",
  events: [
    by(
      AUTHORITY,
      [
        insert("_policy", "org:beta", {
          rules: { notes: { $default: { kind: "role", role: "viewer" } } },
          version: 1,
          grace: null,
        }),
      ],
      BETA,
    ),
    by(ADMIN, [insert("_policy", "org:gamma", { rules: {}, version: 1, grace: null })], GAMMA),
    by(
      AUTHORITY,
      [insert("_policy", "org:gamma", { rules: { notes: {} }, version: 1, grace: null })],
      GAMMA,
    ),
    by(
      AUTHORITY,
      [insert("_policy", "org:strict", { rules: {}, version: 1, grace: 55 * MINUTE })],
      STRICT,
    ),
    by(AUTHORITY, [
      insert("_revocations", `${ACME}:${REVOKED.peerId}`, {
        at: NOW_MS - 2 * MINUTE,
        reason: "lost",
      }),
    ]),
    by(AUTHORITY, [insert("_cdc", "pg", { watermark: "0/1" })]),
    by(AUTHORITY, [insert("_cdc", "pg", { watermark: "0/1" })], null),
    by(MEMBER, [
      insert("_corrections", "c1", {
        eventId: "e",
        table: "notes",
        key: "n1",
        reason: "r",
        detail: null,
      }),
    ]),
  ],
});

const whoMayWrite = ({ sign, by }: Authors): Step => ({
  description: "who may write at all",
  events: [
    by(STRANGER, [insert("notes", "s1", { title: "x", ownerId: "acct_stranger" })]),
    by(OUTSIDER, [insert("notes", "o1", { title: "x", ownerId: "acct_outsider" })]),
    sign(REVOKED, [insert("notes", "r1", { title: "before", ownerId: "acct_revoked" })], {
      partition: ACME,
      atMs: NOW_MS - 3 * MINUTE,
    }),
    sign(REVOKED, [insert("notes", "r2", { title: "after", ownerId: "acct_revoked" })], {
      partition: ACME,
      atMs: NOW_MS - MINUTE,
    }),
    by(MEMBER, [insert("notes", "g1", { title: "stale", ownerId: "acct_member" })], STRICT),
    by(AUTHORITY, [insert("notes", "g2", { title: "exempt", ownerId: "acct_authority" })], STRICT),
    sign(MEMBER, [insert("notes", "c1", { title: "ahead", ownerId: "acct_member" })], {
      partition: ACME,
      atMs: NOW_MS + 6 * MINUTE,
    }),
    sign(MEMBER, [insert("notes", "c2", { title: "drift", ownerId: "acct_member" })], {
      partition: ACME,
      atMs: NOW_MS + 4 * MINUTE,
    }),
  ],
});

const whereRowsLive = ({ by }: Authors): Step => ({
  description: "where a row may live",
  events: [
    by(MEMBER, [insert("notes", "w1", { title: "x", ownerId: "acct_member" })], TEAM),
    by(MEMBER, [insert("notes", "w2", { title: "x", ownerId: "acct_member" })], null),
    by(MEMBER, [insert("settings", "theme", { value: "dark" })], null),
    by(AUTHORITY, [insert("settings", "theme", { value: "dark" })], null),
    by(MEMBER, [insert("feed", "f1", { line: "x" })], null),
    by(AUTHORITY, [insert("feed", "f1", { line: "x" })], null),
    by(MEMBER, [insert("profiles", "me", { name: "m" })], part("user:acct_member")),
    by(MEMBER, [insert("profiles", "you", { name: "m" })], part("user:acct_viewer")),
    by(MEMBER, [insert("drafts", "d1", { body: "x" })], null),
    by(LEAD, [insert("shifts", "s1", { title: "x" })], TEAM),
    by(MEMBER, [insert("shifts", "s2", { title: "x" })], TEAM),
    by(LEAD, [remove("shifts", "s9")], TEAM),
    by(MEMBER, [insert("ghost", "x", { title: "x" })]),
    by(MEMBER, [insert("oldnotes", "x", { title: "x" })]),
    by(MEMBER, [insert("archive", "a1", { title: "an older build still writes it" })]),
    by(MEMBER, [{ kind: "unknown", tag: 9, table: table("notes"), key: key("u1"), data: 1 }]),
  ],
});

const cellsAgainstColumns = ({ by }: Authors): Step => ({
  description: "cells against their columns",
  events: [
    by(MEMBER, [
      insert("notes", "n1", {
        title: "mine",
        ownerId: "acct_member",
        body: null,
        legacy: "older",
      }),
    ]),
    by(MEMBER, [insert("notes", "bad1", { title: 7, ownerId: "acct_member" })]),
    by(MEMBER, [insert("notes", "bad2", { ownerId: "acct_member" })]),
    by(MEMBER, [
      insert("notes", "bad3", {
        title: "x",
        ownerId: "acct_member",
        content: Uint8Array.of(1),
      }),
    ]),
    by(MEMBER, [
      insert("notes", "dv1", {
        title: "x",
        ownerId: "acct_member",
        summary: "an older build wrote it",
        extra: "newer",
      }),
    ]),
    by(MEMBER, [
      insert("tasks", "t1", {
        title: "x",
        done: false,
        points: 2,
        label: "junk",
        ref: "123e4567-e89b-12d3-a456-426614174000",
        meta: { a: [1] },
        votes: { "+": 1 },
        weight: 0.5,
        due: NOW_MS,
      }),
    ]),
    by(MEMBER, [insert("tasks", "t2", { title: "x", done: "no" })]),
    by(MEMBER, [insert("tasks", "t3", { title: "x", done: false, points: 1.5 })]),
    by(MEMBER, [
      insert("tasks", "t4", {
        title: "x",
        done: false,
        ref: "123E4567-E89B-12D3-A456-426614174000",
      }),
    ]),
    by(MEMBER, [insert("tasks", "t5", { title: "x", done: false, votes: 3 })]),
    by(MEMBER, [insert("tasks", "t6", { title: "x", done: false, votes: { p: { a: 1 }, n: {} } })]),
    by(MEMBER, [insert("tasks", "t7", { title: "x", done: false, weight: 1e300, meta: null })]),
    by(MEMBER, [insert("tasks", "t8", { title: "x", done: false, due: "soon" })]),
    by(MEMBER, [insert("tasks", "t9", { title: "x", done: false, meta: Uint8Array.of(1) })]),
  ],
});

/** In order: the authority's rows, then the author rungs, the partition rungs and the cells. */
export const firstSteps = (authors: Authors): readonly Step[] => [
  authorityPublishes(authors),
  whoMayWrite(authors),
  whereRowsLive(authors),
  cellsAgainstColumns(authors),
];
