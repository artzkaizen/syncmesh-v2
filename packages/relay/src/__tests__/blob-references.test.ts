import { hashOf } from "@syncmesh/storage";
import { describe, expect, test } from "bun:test";

import { createBlobReferences } from "../blob-references.js";
import { entryOf, filled, peer, remove, write } from "./fixtures.js";

const photo = hashOf(filled(1, 8));

describe("createBlobReferences (gaps U18)", () => {
  test("a row holds what it named until a delete stamped after its latest write", async () => {
    const author = peer(50, "acct_a");
    const refs = createBlobReferences();
    expect(refs.note(entryOf(await write(author, "n1", photo)).event)).toEqual([]);
    expect([...refs.referenced()]).toEqual([photo]);
    expect(refs.note(entryOf(await remove(author, "n1")).event)).toEqual([photo]);
    expect([...refs.referenced()]).toEqual([]);
    // a later write brings the row back, and every name it ever carried with it, as the kernel does
    refs.note(entryOf(await write(author, "n1", "no blob in this one")).event);
    expect([...refs.referenced()]).toEqual([photo]);
  });

  test("the order events arrive in changes nothing: an older delete after a newer write frees nothing", async () => {
    const late = peer(51, "acct_a", 1000);
    const early = peer(52, "acct_b", 10);
    const deleted = entryOf(await remove(early, "n1")).event;
    const written = entryOf(await write(late, "n1", photo)).event;
    for (const order of [
      [written, deleted],
      [deleted, written],
    ]) {
      const refs = createBlobReferences();
      for (const event of order) refs.note(event);
      expect([...refs.referenced()]).toEqual([photo]);
    }
  });

  test("a row that never named a blob is not tracked; one that did is saved and restored whole", async () => {
    const author = peer(53, "acct_a");
    const refs = createBlobReferences();
    refs.note(entryOf(await write(author, "plain", "nothing")).event);
    refs.note(entryOf(await remove(author, "plain")).event);
    expect(refs.size()).toBe(0);

    refs.note(entryOf(await write(author, "n1", photo)).event);
    const saved = refs.taken();
    expect(saved.map((row) => `${row.key} ${row.hashes.join(" ")}`)).toEqual([`n1 ${photo}`]);
    expect(refs.taken()).toEqual([]); // taken once
    const restored = createBlobReferences();
    restored.restore(saved);
    expect([...restored.referenced()]).toEqual([photo]);
    restored.note(entryOf(await remove(author, "n1")).event);
    expect([...restored.referenced()]).toEqual([]);
  });
});
