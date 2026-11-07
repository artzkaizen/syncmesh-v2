import type { Delta, LoroDoc } from "loro-crdt";

/**
 * Regenerates conformance/loro-vectors.json (RFC-0023 §13): what the `loro@1` adapter exports for a
 * scripted history, in TypeScript over `loro-crdt` and in Rust over `loro`, byte for byte. Run
 * only when the adapter or its pinned library deliberately changes (README rule 3):
 * `bun conformance/src/generate-loro-vectors.ts`.
 *
 * A history is a script both runtimes interpret: the edits go through Loro's own API (syncmesh
 * never wraps it), and every byte syncmesh carries or stores — `snapshot`, `version`, `since`,
 * `apply` — goes through the adapter. Loro records no wall-clock time unless asked, so a fixed
 * replica id is all determinism needs.
 */
import { replicaId } from "@syncmesh/docs";
import { parsePeerId, type JsonValue } from "@syncmesh/kernel";
import { loro } from "@syncmesh/loro";
import { bytesToHex, hexToBytes } from "@syncmesh/wire";

/** One step of a history; `doc` names the replica it runs on. */
export type Step =
  | { readonly op: "new"; readonly doc: string; readonly replica: string }
  | { readonly op: "style"; readonly doc: string; readonly key: string }
  | {
      readonly op: "insert";
      readonly doc: string;
      readonly text: string;
      readonly pos: number;
      readonly value: string;
    }
  | {
      readonly op: "delete";
      readonly doc: string;
      readonly text: string;
      readonly pos: number;
      readonly len: number;
    }
  | {
      readonly op: "mark";
      readonly doc: string;
      readonly text: string;
      readonly start: number;
      readonly end: number;
      readonly key: string;
    }
  | {
      readonly op: "set";
      readonly doc: string;
      readonly map: string;
      readonly key: string;
      readonly value: string;
    }
  | { readonly op: "commit"; readonly doc: string }
  | { readonly op: "snapshot"; readonly doc: string; readonly as: string }
  | { readonly op: "version"; readonly doc: string; readonly as: string }
  | { readonly op: "since"; readonly doc: string; readonly from: string; readonly as: string }
  | {
      readonly op: "apply";
      readonly doc: string;
      readonly updates: readonly string[];
      readonly changed?: boolean;
    };

export interface History {
  readonly description: string;
  readonly steps: readonly Step[];
  /** Every labelled byte string the script produced, as hex. */
  readonly outputs: Readonly<Record<string, string>>;
  /** Per replica at the end: each text's plain value, each map as JSON, and the adapter's bytes. */
  readonly final: Readonly<
    Record<
      string,
      {
        readonly texts: Readonly<Record<string, string>>;
        readonly maps: Readonly<Record<string, JsonValue>>;
        /** Each text as Loro's delta: runs of text with their marks. */
        readonly deltas: Readonly<Record<string, readonly Delta<string>[]>>;
        readonly snapshot: string;
        readonly version: string;
      }
    >
  >;
}

const adapter = loro();

/** The edits: Loro's own API, which syncmesh never wraps. */
function edit(d: LoroDoc, step: Step): void {
  switch (step.op) {
    case "style":
      return d.configTextStyle({ [step.key]: { expand: "after" } });
    case "insert":
      return d.getText(step.text).insert(step.pos, step.value);
    case "delete":
      return d.getText(step.text).delete(step.pos, step.len);
    case "mark":
      return d.getText(step.text).mark({ start: step.start, end: step.end }, step.key, true);
    case "set":
      return d.getMap(step.map).set(step.key, step.value);
    case "commit":
      return d.commit();
    default:
      return undefined;
  }
}

/** What syncmesh carries: every byte here goes through the adapter. Returns the step as it ran. */
function carry(d: LoroDoc, step: Step, outputs: Record<string, string>): Step {
  switch (step.op) {
    case "snapshot":
      outputs[step.as] = bytesToHex(adapter.snapshot(d));
      return step;
    case "version":
      outputs[step.as] = bytesToHex(adapter.version(d));
      return step;
    case "since":
      outputs[step.as] = bytesToHex(adapter.since(d, bytes(outputs, step.from)).unwrap());
      return step;
    case "apply":
      return {
        ...step,
        changed: adapter
          .apply(
            d,
            step.updates.map((label) => bytes(outputs, label)),
          )
          .unwrap(),
      };
    default:
      return step;
  }
}

/** Runs a script, filling in what `apply` reported and every labelled output. */
export function run(description: string, steps: readonly Step[]): History {
  const docs = new Map<string, LoroDoc>();
  const outputs: Record<string, string> = {};
  // every replica reports every container the script names, whether it wrote it or imported it
  const texts = [...new Set(steps.flatMap((s) => ("text" in s ? [s.text] : [])))].sort();
  const maps = [...new Set(steps.flatMap((s) => ("map" in s ? [s.map] : [])))].sort();
  const ran = steps.map((step): Step => {
    if (step.op === "new") {
      docs.set(step.doc, adapter.create(BigInt(step.replica)));
      return step;
    }
    const d = docs.get(step.doc) ?? panicAt(`no replica ${step.doc}`);
    edit(d, step);
    return carry(d, step, outputs);
  });
  const final = Object.fromEntries(
    [...docs].map(([name, d]) => [
      name,
      {
        texts: Object.fromEntries(texts.map((t) => [t, d.getText(t).toString()])),
        maps: Object.fromEntries(maps.map((m) => [m, mapJson(d, m)])),
        deltas: Object.fromEntries(texts.map((t) => [t, d.getText(t).toDelta()])),
        snapshot: bytesToHex(adapter.snapshot(d)),
        version: bytesToHex(adapter.version(d)),
      },
    ]),
  );
  return { description, steps: ran, outputs, final };
}

/** A map's value as JSON: the script only ever sets strings, so that is all a map can hold. */
const mapJson = (d: LoroDoc, map: string): JsonValue => {
  const value: unknown = d.getMap(map).toJSON();
  // SAFETY: `set` steps write string values only, and toJSON of a map of strings is a JSON object
  return value as JsonValue;
};

const panicAt = (message: string): never => {
  throw new Error(message);
};
const bytes = (outputs: Record<string, string>, label: string) =>
  hexToBytes(outputs[label] ?? panicAt(`no output ${label}`)).unwrap();

/** Three peers and nonces, fixed: the replica derivation every runtime must reproduce. */
const REPLICAS = [0x11, 0x22, 0x33].map((fill, i) => {
  const peerId = parsePeerId(bytesToHex(new Uint8Array(32).fill(fill))).unwrap();
  const nonce = Uint8Array.from({ length: 16 }, (_, j) => i * 16 + j);
  return { peerId, nonce: bytesToHex(nonce), replica: String(replicaId(peerId, nonce)) };
});

// SAFETY: REPLICAS is the three-element literal just above
const [A, B, C] = REPLICAS.map((r) => r.replica) as [string, string, string];

export function loroVectors() {
  return {
    adapter: adapter.id,
    library: { typescript: "loro-crdt@1.17.1", rust: "loro@1.17.1" },
    replicas: REPLICAS,
    histories: [
      run("loro#1163: an insert concurrent with a delete baked into a snapshot (D38's gate)", [
        { op: "new", doc: "a", replica: "1" },
        { op: "insert", doc: "a", text: "t", pos: 0, value: "abcdef" },
        { op: "commit", doc: "a" },
        { op: "snapshot", doc: "a", as: "a0" },
        { op: "version", doc: "a", as: "va0" },
        { op: "new", doc: "b", replica: "2" },
        { op: "apply", doc: "b", updates: ["a0"] },
        { op: "insert", doc: "b", text: "t", pos: 4, value: "X" },
        { op: "commit", doc: "b" },
        { op: "since", doc: "b", from: "va0", as: "bx" },
        { op: "delete", doc: "a", text: "t", pos: 2, len: 2 },
        { op: "commit", doc: "a" },
        { op: "snapshot", doc: "a", as: "a1" },
        { op: "new", doc: "c", replica: "3" },
        { op: "apply", doc: "c", updates: ["a1"] },
        { op: "apply", doc: "c", updates: ["bx"] },
      ]),
      run("three replicas insert at one position concurrently; every delivery order converges", [
        { op: "new", doc: "a", replica: A },
        { op: "new", doc: "b", replica: B },
        { op: "new", doc: "c", replica: C },
        { op: "version", doc: "a", as: "empty" },
        { op: "insert", doc: "a", text: "body", pos: 0, value: "alpha " },
        { op: "commit", doc: "a" },
        { op: "insert", doc: "b", text: "body", pos: 0, value: "beta " },
        { op: "commit", doc: "b" },
        { op: "insert", doc: "c", text: "body", pos: 0, value: "gamma " },
        { op: "commit", doc: "c" },
        { op: "since", doc: "a", from: "empty", as: "ua" },
        { op: "since", doc: "b", from: "empty", as: "ub" },
        { op: "since", doc: "c", from: "empty", as: "uc" },
        { op: "apply", doc: "a", updates: ["uc", "ub"] },
        { op: "apply", doc: "b", updates: ["ua"] },
        { op: "apply", doc: "b", updates: ["uc"] },
        { op: "apply", doc: "c", updates: ["ub", "ua", "ub"] },
      ]),
      run("paced flushes: each burst is one update past the last flushed version", [
        { op: "new", doc: "a", replica: A },
        { op: "new", doc: "b", replica: B },
        { op: "version", doc: "a", as: "v0" },
        { op: "insert", doc: "a", text: "body", pos: 0, value: "H" },
        { op: "commit", doc: "a" },
        { op: "insert", doc: "a", text: "body", pos: 1, value: "ello" },
        { op: "commit", doc: "a" },
        { op: "since", doc: "a", from: "v0", as: "f1" },
        { op: "version", doc: "a", as: "v1" },
        { op: "insert", doc: "a", text: "body", pos: 5, value: ", world" },
        { op: "commit", doc: "a" },
        { op: "since", doc: "a", from: "v1", as: "f2" },
        { op: "apply", doc: "b", updates: ["f2"] },
        { op: "apply", doc: "b", updates: ["f1"] },
        { op: "apply", doc: "b", updates: ["f1", "f2"] },
      ]),
      run("rich text: a mark concurrent with an insert inside it, and a map beside it", [
        { op: "new", doc: "a", replica: A },
        { op: "new", doc: "b", replica: B },
        { op: "style", doc: "a", key: "bold" },
        { op: "style", doc: "b", key: "bold" },
        { op: "insert", doc: "a", text: "body", pos: 0, value: "make this bold" },
        { op: "set", doc: "a", map: "meta", key: "title", value: "draft" },
        { op: "commit", doc: "a" },
        { op: "snapshot", doc: "a", as: "base" },
        { op: "version", doc: "a", as: "vbase" },
        { op: "apply", doc: "b", updates: ["base"] },
        { op: "mark", doc: "a", text: "body", start: 5, end: 9, key: "bold" },
        { op: "commit", doc: "a" },
        { op: "insert", doc: "b", text: "body", pos: 7, value: "!!" },
        { op: "set", doc: "b", map: "meta", key: "title", value: "final" },
        { op: "commit", doc: "b" },
        { op: "since", doc: "a", from: "vbase", as: "ma" },
        { op: "since", doc: "b", from: "vbase", as: "mb" },
        { op: "apply", doc: "a", updates: ["mb"] },
        { op: "apply", doc: "b", updates: ["ma"] },
      ]),
    ],
  };
}

if (import.meta.main) {
  const out = new URL("../loro-vectors.json", import.meta.url);
  await Bun.write(out, `${JSON.stringify(loroVectors(), null, 2)}\n`);
}
