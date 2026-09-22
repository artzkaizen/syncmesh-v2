import { describe, expect, test } from "bun:test";

import { announce, dismiss, onToasts, overruledBy, toasts } from "../app/overrule.js";

describe("what the app says when a write is overruled", () => {
  test("the sentence names the office and carries its reason", () => {
    expect(overruledBy("the authority renumbered it")).toBe(
      "changed by the office: the authority renumbered it",
    );
  });

  test("a line is said once per id, however many components hold the record", () => {
    let told = 0;
    const off = onToasts(() => (told += 1));
    announce("op-1", overruledBy("moved to triage"));
    announce("op-1", overruledBy("moved to triage"));
    expect(toasts().map((toast) => toast.id)).toEqual(["op-1"]);
    expect(told).toBe(1);
    off();
    dismiss("op-1");
  });

  test("dismissing takes the line down and says so; dismissing nothing says nothing", () => {
    announce("op-2", overruledBy("reassigned"));
    let told = 0;
    const off = onToasts(() => (told += 1));
    dismiss("op-2");
    dismiss("op-2");
    expect(toasts()).toEqual([]);
    expect(told).toBe(1);
    off();
  });
});
