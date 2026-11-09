import type { SuiteCase } from "@syncmesh/engine";

import { equal } from "@syncmesh/engine";
import { parsePeerId } from "@syncmesh/kernel";

import type { OpenDriver } from "./index.js";

import { operationStore } from "../operation-store.js";
import { A, B, seq } from "./fixtures.js";

const C = parsePeerId("c".repeat(64)).unwrap();

/**
 * The custody ledger on every dialect (D28): a vouch replaces its holder's other lineages, and a
 * proven lineage retires them before anything is signed out of it. The statements differ per
 * dialect; what they leave behind must not.
 */
export function custodyCases(openDriver: OpenDriver): readonly SuiteCase[] {
  return [
    {
      name: "custody: a vouch replaces the holder's other lineage, and a proven lineage retires it unsigned",
      run: async () => {
        const driver = await openDriver("custody-lineage");
        const store = (await operationStore(driver)).unwrap();
        for (const n of [1, 2])
          (
            await store.record({ id: `op-${n}`, peer: A, seq: seq(n), label: "l", atMs: n })
          ).unwrap();
        (await store.vouch(B, A, seq(2), "inc-1", 10)).unwrap();
        (await store.vouch(C, A, seq(1), "inc-9", 10)).unwrap();
        const holders = async (n: number) =>
          (await store.vouchesOf(A, seq(n))).unwrap().map((v) => `${v.holder}/${v.incarnation}`);
        equal((await store.soleCustody()).unwrap().length, 0, "both held before");

        // B rebuilt, holding the first only: its vouch for the second goes with the old lineage
        (await store.vouch(B, A, seq(1), "inc-2", 20)).unwrap();
        equal(await holders(2), [], "the lost lineage's vouch");
        equal(await holders(1), [`${C}/inc-9`, `${B}/inc-2`], "the new lineage's vouch");

        // B proves a third lineage before it signs out of it: nothing of B's counts, C's still does
        (await store.retireLineages(B, "inc-3")).unwrap();
        equal(await holders(1), [`${C}/inc-9`], "after the retirement");
        equal(
          (await store.soleCustody()).unwrap().map((op) => op.id),
          ["op-2"],
          "sole custody after the retirement",
        );
        await driver.close?.();
      },
    },
  ];
}
