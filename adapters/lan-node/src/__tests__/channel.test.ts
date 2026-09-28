import type { OpenChannel } from "@syncmesh/transport/transport-tests";
import type { LanStream } from "@syncmesh/transports";

import { channelTests } from "@syncmesh/transport/transport-tests";
import { describe, test } from "bun:test";

import { nodeLan } from "../index.js";

/**
 * The channel contract over **real sockets**, on the loopback.
 *
 * The virtual mediums satisfy this too, and that is the point of running it twice: a stand-in
 * that behaves like a socket is only useful if a socket also does. Where the two disagree, this
 * is the one that is right.
 */
const overLoopback: OpenChannel = async () => {
  const server = (await nodeLan({ host: "127.0.0.1", multicast: false })).unwrap();
  const client = (await nodeLan({ host: "127.0.0.1", multicast: false })).unwrap();
  let accepted: LanStream | undefined;
  server.onConnection((stream) => void (accepted = stream));
  const near = await client.dial({ host: "127.0.0.1", port: server.address().port });
  // real sockets settle on the event loop rather than on a queue: a beat is what that costs
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
  await settle();
  if (accepted === undefined) throw new Error("the far end never accepted");
  return {
    a: near,
    b: accepted,
    settle,
    close: () => {
      near.close();
      void server.close();
      void client.close();
    },
  };
};

describe("Node's sockets satisfy the channel contract", () => {
  for (const suiteCase of channelTests(overLoopback)) test(suiteCase.name, suiteCase.run, 20_000);
});
