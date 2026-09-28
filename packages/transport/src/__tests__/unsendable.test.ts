import { describe, expect, test } from "bun:test";

import { Unsendable } from "../outbound.js";
import { ACME, bodyOf, connect, mintFor, peer, write } from "./fixtures.js";

/**
 * **An event this device cannot sign is an event it can never hand on, and it has to say so.**
 *
 * The log keeps another peer's event under the signature it arrived with, and keeps this device's
 * own under none — nothing signed them yet, and `envelopeOf` re-signs them on the way out. Those
 * two rules have one gap between them: an entry with no signature whose author is *not* this
 * device. It folds locally and forever, it is covered by this device's own cursor, and there is no
 * envelope anyone can build for it, so every peer that asks for history is quietly handed a run
 * with a hole in it.
 *
 * It is not a hypothetical. An install that rotated its device key while keeping its database
 * left 86 such entries behind, and the only column anywhere that made the hole visible was a
 * counter: two devices reporting themselves caught up read 105 views and 76, differing by exactly
 * the retired author's 29. Every last-writer-wins column looked identical, because the values
 * were the same on both sides whether or not the events behind them had arrived.
 *
 * So the assertion here is not that the event is delivered — it cannot be, by construction — but
 * that the attempt is **reported** rather than filtered out in silence. A loud gap is recoverable;
 * a silent one is the divergence.
 */

describe("an entry with no signature this device could have made", () => {
  test("never reaches the peer, and is named as unsendable rather than dropped quietly", async () => {
    const ada = peer(2, "acct_ada");
    const bo = peer(3, "acct_bo");
    const gone = peer(4, "acct_gone");

    // the retired install's grant is known to everyone; it is the *bytes* that are missing
    for (const holder of [ada, bo])
      holder.grants.register(mintFor(gone.identity, "acct_gone")).unwrap();

    const orphan = (await write(gone, "n1", "written under a key nobody holds any more")).unwrap();
    // exactly what the log holds for an event it authored — and what it wrongly holds for one it
    // merely inherited: the event, and neither the bytes that were signed nor the signature
    (await ada.engine.receiveBatch([{ event: orphan }])).unwrap();
    expect(bodyOf(ada, "n1")).toBe("written under a key nobody holds any more");

    const { bx, settle } = connect(ada, bo);
    const refused: Unsendable[] = [];
    bx.onError((error) => {
      if (error instanceof Unsendable) refused.push(error);
    });

    (await write(ada, "n2", "one ada really did author", ACME)).unwrap();
    await settle();

    // the event ada authored crosses; the one it inherited cannot, and that is the whole point
    expect(bodyOf(bo, "n2")).toBe("one ada really did author");
    expect(bodyOf(bo, "n1")).toBeUndefined();

    expect(refused.map((error) => error.id)).toContain(String(orphan.id));
    expect(refused[0]?.message).toContain("no stored signature");
  });
});
