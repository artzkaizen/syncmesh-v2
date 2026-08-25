import { parsePartitionKey } from "@syncmesh/kernel";
import { describe, expect, test } from "bun:test";

import { CREATE, N1, NOTES, PEER_A, column, key, row, setup } from "./fixtures.js";

const ACME = parsePartitionKey("org:acme").unwrap();
const GLOBEX = parsePartitionKey("org:globex").unwrap();

describe("partitions on the engine", () => {
  test("a write in an instance lands on the row; rowsIn reads one instance at a time", async () => {
    const { engine } = setup(PEER_A);
    const write = (k: string, body: string, partition = ACME) =>
      engine.mutate(CREATE, (tx) => tx.insert(NOTES, key(k), row({ body })), { partition });
    (await write("n1", "a")).unwrap();
    (await write("n2", "g", GLOBEX)).unwrap();
    (await write("n3", "c")).unwrap();
    (
      await engine.mutate(CREATE, (tx) => tx.insert(NOTES, key("n4"), row({ body: "global" })))
    ).unwrap();

    expect([...engine.rowsIn(NOTES, ACME).keys()]).toEqual([N1, key("n3")]);
    expect(engine.rowsIn(NOTES, GLOBEX).get(key("n2"))?.get(column("body"))).toBe("g");
    expect(engine.state().get(NOTES)?.get(key("n4"))).not.toHaveProperty("partition");
  });
});
