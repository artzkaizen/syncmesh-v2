import "./dom.js";
import { describe, expect, test } from "bun:test";
import { createElement, useReducer } from "react";

import type { RefusedBy } from "../refused-by.js";
import type { OperationRecord } from "../use-operation.js";

import { refusedBy, useRefusedBy } from "../refused-by.js";
import { mount } from "./mount.js";

const OFFICE = "aa".repeat(32);
const LAPTOP = "3f2a19c0".repeat(8);
const OLD_PHONE = "b0b0b0b0".repeat(8);
const NEW_TABLET = "cc".repeat(32);

const record = (refusals: OperationRecord["refusals"]): OperationRecord => {
  const base = { id: "op-1", label: "notes.create", status: "applied" } as const;
  return refusals === undefined ? base : { ...base, refusals };
};

describe("refusedBy — a write's refusals as lines (D32, G12)", () => {
  test("one line per refuser, the authority first and named, each sentence this build's own", () => {
    const lines = refusedBy(
      record([
        { by: LAPTOP, reason: "refused", verdict: "GrantStale" },
        { by: OLD_PHONE, reason: "unknown-table", verdict: "UnknownTable" },
        { by: NEW_TABLET, reason: "refused", verdict: "TableDropped" },
        { by: OFFICE, reason: "refused", verdict: "PolicyDenied" },
        // the same refuser twice is one fact
        { by: LAPTOP, reason: "refused", verdict: "NoGrant" },
      ]),
      { authority: OFFICE },
    );
    expect(lines.map((l) => [l.kind, l.authority, l.text])).toEqual([
      ["refused", true, "the authority refused this (PolicyDenied)"],
      ["refused", false, "3f2a19c0… refused this (GrantStale)"],
      ["older-build", false, "b0b0b0b0… is on an older build and cannot read this yet"],
      ["newer-build", false, "cccccccc… is on a newer build that dropped this table"],
    ]);
  });

  test("an older build's bucket is never read as a refusal", () => {
    const [line] = refusedBy(record([{ by: OLD_PHONE, reason: "unknown-kind", verdict: "x" }]));
    expect(line?.kind).toBe("older-build");
    expect(line?.text).not.toContain("refused");
  });

  test("nothing refused, or no record yet, is no lines; a name function names the refuser", () => {
    expect(refusedBy(undefined)).toEqual([]);
    expect(refusedBy(record(undefined))).toEqual([]);
    const [line] = refusedBy(record([{ by: LAPTOP, reason: "refused", verdict: "NoGrant" }]), {
      name: () => "Ana's laptop",
    });
    expect(line?.text).toBe("Ana's laptop refused this (NoGrant)");
  });
});

describe("useRefusedBy", () => {
  test("renders a refusal when it lands and drops it when custody retires it, keeping identity between", async () => {
    const listeners = new Set<() => void>();
    let row: OperationRecord | undefined = record(undefined);
    const ref = {
      id: "op-1",
      status: () => row,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const seen: (readonly RefusedBy[])[] = [];
    let rerender = () => {};
    const Lines = () => {
      // a render the record did not cause: what the memo exists for
      rerender = useReducer((n: number) => n + 1, 0)[1];
      const lines = useRefusedBy(ref, { authority: OFFICE });
      seen.push(lines);
      return createElement(
        "ul",
        null,
        lines.map((line) =>
          createElement("li", { key: line.by, "data-kind": line.kind }, line.text),
        ),
      );
    };
    const { container, settle, root } = await mount(createElement(Lines));
    expect(container.querySelectorAll("li")).toHaveLength(0);

    row = record([{ by: OFFICE, reason: "refused", verdict: "PolicyDenied" }]);
    notify();
    await settle();
    expect(container.textContent).toBe("the authority refused this (PolicyDenied)");
    expect(container.querySelector("li")?.getAttribute("data-kind")).toBe("refused");

    // a render with the same record: no new lines, the same array
    const before = seen.at(-1);
    const renders = seen.length;
    rerender();
    await settle();
    expect(seen.length).toBeGreaterThan(renders);
    expect(seen.at(-1)).toBe(before);

    row = record(undefined); // the refuser later signed custody, which retires the refusal
    notify();
    await settle();
    expect(container.querySelectorAll("li")).toHaveLength(0);
    root.unmount();
  });
});
