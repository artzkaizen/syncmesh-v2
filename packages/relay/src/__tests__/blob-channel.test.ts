import { parsePartitionKey } from "@syncmesh/kernel";
import { BLOB_MISSING } from "@syncmesh/transport";
import { describe, expect, test } from "bun:test";

import { createBlobChannel } from "../blob-channel.js";
import { decodeRelayFrame } from "../frame-decode.js";

const HASH = "a".repeat(64);
const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();
const bytes = Uint8Array.of(1, 2, 3);

describe("the relay's blob channel", () => {
  test("a refusal settles only the uploads billed to the partition it names", async () => {
    const channel = createBlobChannel(() => true);
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
    const channel = createBlobChannel(() => true);
    const uploads = [
      channel.capability.upload(HASH, bytes, { partition: ACME }),
      channel.capability.upload(HASH, bytes, {}),
    ];
    channel.settle(HASH, undefined);
    expect(await Promise.all(uploads)).toEqual([undefined, undefined]);
  });

  test("a request leaves on a seated session, and one its socket dropped goes again on the next seat", async () => {
    const sent: string[] = [];
    const channel = createBlobChannel((frame) => {
      const decoded = decodeRelayFrame(frame).unwrap();
      sent.push(decoded.kind);
      return true;
    });
    // asked before the join: nothing leaves on a session the room has not seated
    const fetched = channel.capability.download(HASH, { timeoutMs: 5000 });
    const put = channel.capability.upload(HASH, bytes, { partition: ACME });
    expect(sent).toEqual([]);
    channel.seated();
    expect(sent).toEqual(["blob-get", "blob-put"]);
    // a re-join on the same socket sends nothing twice
    channel.seated();
    expect(sent).toHaveLength(2);
    // the room closed the socket to re-seat it, unanswered: the next seat asks again
    channel.unseated();
    channel.seated();
    expect(sent).toEqual(["blob-get", "blob-put", "blob-get", "blob-put"]);
    channel.answer(HASH, undefined);
    channel.settle(HASH, undefined);
    expect(await fetched).toBe(BLOB_MISSING);
    expect(await put).toBeUndefined();
    // answered requests are not asked again
    channel.unseated();
    channel.seated();
    expect(sent).toHaveLength(4);
  });

  test("a frame that did not leave is sent on the next seat, not taken as asked", () => {
    let up = false;
    const sent: string[] = [];
    const channel = createBlobChannel((frame) => {
      if (up) sent.push(decodeRelayFrame(frame).unwrap().kind);
      return up;
    });
    channel.seated();
    void channel.capability.download(HASH, { timeoutMs: 5000 });
    expect(sent).toEqual([]);
    up = true;
    channel.seated();
    expect(sent).toEqual(["blob-get"]);
  });
});
