import type { SuiteCase } from "@syncmesh/engine";
import type { PartitionKey, RowKey, TableName } from "@syncmesh/kernel";

import { equal } from "@syncmesh/engine";
import { hlcOf, parsePeerId } from "@syncmesh/kernel";
import { Temporal } from "@syncmesh/temporal";

import type { OpenDriver } from "./index.js";

import { sqlBlobLedger } from "../blob-ledger.js";
import { hashOf, sqlBlobStore } from "../blob.js";

const photo = Uint8Array.from({ length: 300 }, (_, i) => i % 7);
const PEER = parsePeerId("ab".repeat(32)).unwrap();
// SAFETY: a test fixture name; the brand is over this string
const NOTES = "notes" as TableName;
// SAFETY: a test fixture name; the brand is over this string
const ACME = "org:acme" as PartitionKey;
// SAFETY: test fixture row keys; the brand is over these strings
const [N1, N2] = ["n1" as RowKey, "n2" as RowKey];

/** What a relay keeps about its blobs' references (gaps U18): it survives a reopen, in both dialects. */
export const blobLedgerCases = (openDriver: OpenDriver): readonly SuiteCase[] => [
  {
    name: "blob ledger: rows, windows, sealed partitions and completeness survive a reopen, and the inventory sizes what is held",
    run: async () => {
      const driver = await openDriver("blob-ledger");
      const store = (await sqlBlobStore(driver)).unwrap();
      const hash = (await store.put(photo)).unwrap();
      const ledger = (await sqlBlobLedger(driver)).unwrap();
      equal((await ledger.load()).unwrap().complete, undefined, "a ledger never saved says so");

      const written = { hlc: hlcOf(1_700_000_000_123, 4), peer: PEER };
      const deleted = { hlc: hlcOf(1_700_000_000_456, 0), peer: PEER };
      const live = {
        table: NOTES,
        key: N1,
        hashes: [hash],
        written,
        deleted: undefined,
      };
      const gone = { table: NOTES, key: N2, hashes: [hash], written, deleted };
      const since = Temporal.Instant.fromEpochMilliseconds(1_700_000_000_789);
      const left = hashOf(Uint8Array.of(1, 2, 3));
      (
        await ledger.save({
          rows: [live, gone],
          windows: [
            { hash, since },
            { hash: left, since },
          ],
          sealed: [ACME, undefined],
          complete: true,
        })
      ).unwrap();
      // a row saved again is joined with what was kept, not added beside it nor written over it:
      // the later delete lands, the older write and the missing name do not undo anything
      const older = { hlc: hlcOf(1_600_000_000_000, 0), peer: PEER };
      (
        await ledger.save({
          rows: [{ ...live, hashes: [], written: older, deleted }],
          windows: [{ hash: left, since: undefined }],
          sealed: [ACME],
          complete: true,
        })
      ).unwrap();

      await driver.close?.();
      const reopened = await openDriver("blob-ledger");
      const again = (await sqlBlobLedger(reopened)).unwrap();
      const state = (await again.load()).unwrap();
      equal(state.complete, true, "completeness kept");
      equal(
        [...state.sealed].map((home) => home ?? "").sort(),
        ["", ACME],
        "sealed partitions kept",
      );
      const rows = [...state.rows].sort((a, b) => a.key.localeCompare(b.key));
      equal(rows.length, 2, "one row per (table, key)");
      equal(
        rows.map((row) => row.hashes),
        [[hash], [hash]],
        "the names each row carried",
      );
      equal(
        rows.map((row) => row.deleted?.hlc[0].epochMilliseconds),
        [1_700_000_000_456, 1_700_000_000_456],
        "the later save's delete stamp",
      );
      equal(
        rows.map((row) => row.written?.hlc[0].epochMilliseconds),
        [1_700_000_000_123, 1_700_000_000_123],
        "an older write saved later does not move the stamp back",
      );
      equal(rows[0]?.written?.hlc[1], 4, "the logical half of a stamp");
      equal(
        state.windows.map((window) => [window.hash, window.since?.epochMilliseconds]),
        [[hash, 1_700_000_000_789]],
        "a window kept, and one forgotten when its blob left",
      );
      equal(String(rows[0]?.written?.peer), String(PEER), "and its peer");
      const sizes = (await again.stored?.())?.unwrap();
      equal(sizes?.get(hashOf(photo)), photo.byteLength, "the inventory sizes what is held");
      await reopened.close?.();
    },
  },
];
