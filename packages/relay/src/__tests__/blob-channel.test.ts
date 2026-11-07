import { parsePartitionKey } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { createBlobChannel } from "../blob-channel.js";

const HASH = "a".repeat(64);
const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();
const bytes = Uint8Array.of(1, 2, 3);

describe("the relay's blob channel", () => {
  test("a refusal settles only the uploads billed to the partition it names", async () => {
    const channel = createBlobChannel(() => undefined);
    const toAcme = channel.capability.upload(HASH, bytes, { partition: ACME });
    const toGlobex = channel.capability.upload(HASH, bytes, { partition: GLOBEX });
    const refusal = { reason: "quota", partition: ACME, limit: 10, used: 10 } as const;

    channel.settle(HASH, refusal);
    expect(await toAcme).toEqual(refusal);
    // the other partition's put is still waiting on its own answer, which says it was kept
    channel.settle(HASH, undefined);
    expect(await toGlobex).toBeUndefined();
  });

  test("a stored answer settles every upload of the hash, whatever it is billed to", async () => {
    const channel = createBlobChannel(() => undefined);
    const uploads = [
      channel.capability.upload(HASH, bytes, { partition: ACME }),
      channel.capability.upload(HASH, bytes, {}),
    ];
    channel.settle(HASH, undefined);
    expect(await Promise.all(uploads)).toEqual([undefined, undefined]);
  });
});
