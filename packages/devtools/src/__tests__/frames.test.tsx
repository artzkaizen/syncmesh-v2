import "./dom.js";
import type { ReactNode } from "react";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { Frames as FrameSampler } from "../frames.js";

import { BUCKETS, BUCKET_MS, STALLED_MS, createFrames, droppedIn } from "../frames.js";
import { Frames } from "../react/frames.js";
import { SEVERITY_COLOR } from "../tokens.js";

/** A vsync-accurate run of frames, so the sampler sees what a screen would have given it. */
const run = (frames: FrameSampler, fromMs: number, count: number, stepMs: number): number => {
  let at = fromMs;
  for (let n = 0; n < count; n += 1) {
    frames.frame(at);
    at += stepMs;
  }
  return at - stepMs;
};

const HZ120 = 1000 / 120;
const HZ60 = 1000 / 60;
const T0 = 10_000;

describe("the display's rate is derived, never assumed to be 60", () => {
  test("a 120Hz screen reads as 120, and a steady 120 loses nothing", () => {
    const frames = createFrames();
    const last = run(frames, T0, 60, HZ120);
    const seen = frames.read(last);
    expect(seen.hz).toBe(120);
    expect(seen.dropped).toBe(0);
  });

  test("a 60Hz screen reads as 60, and a steady 60 loses nothing — the same run, different screen", () => {
    const frames = createFrames();
    const last = run(frames, T0, 60, HZ60);
    const seen = frames.read(last);
    expect(seen.hz).toBe(60);
    // the frame that a 120Hz display would have called a drop is this display painting perfectly
    expect(seen.dropped).toBe(0);
  });

  test("a 120Hz screen that falls to 60 loses a frame each time, which is the whole point", () => {
    const frames = createFrames();
    let at = run(frames, T0, 40, HZ120);
    for (let n = 0; n < 10; n += 1) {
      at += HZ60;
      frames.frame(at);
    }
    const seen = frames.read(at);
    expect(seen.hz).toBe(120);
    expect(seen.dropped).toBe(10); // one vsync missed per frame
  });

  test("frames lost are counted against the derived period, not a constant", () => {
    expect(droppedIn(16.7, 1000 / 60)).toBe(0);
    expect(droppedIn(16.7, 1000 / 120)).toBe(1);
    expect(droppedIn(100, 1000 / 120)).toBe(11);
  });
});

describe("a dropped bucket is only blamed on syncmesh when something said so", () => {
  /** Forty frames at 120Hz, then one frame an eighth of a second late: a visible stutter. */
  const stutter = () => {
    const frames = createFrames();
    const at = run(frames, T0, 40, HZ120);
    const late = at + 125;
    frames.frame(late);
    return { frames, from: at, late };
  };

  test("a drop with nothing to pin it on is `unattributed`, never silently cleared", () => {
    const { frames, late } = stutter();
    const seen = frames.read(late);
    expect(seen.dropped).toBeGreaterThan(0);
    expect(seen.buckets.some((bucket) => bucket.blame === "unattributed")).toBe(true);
    expect(seen.meshBlamed).toBe(false);
  });

  test("a long frame with a syncmesh script in it makes the bucket the finding", () => {
    const { frames, from, late } = stutter();
    frames.blocked(from, late - from, "mesh");
    const seen = frames.read(late);
    expect(seen.meshBlamed).toBe(true);
    expect(seen.buckets.some((bucket) => bucket.blame === "mesh")).toBe(true);
  });

  test("`mesh` outranks `app` in one bucket whichever order the records arrive in", () => {
    const first = stutter();
    first.frames.blocked(first.from, first.late - first.from, "app");
    first.frames.blocked(first.from, first.late - first.from, "mesh");
    expect(first.frames.read(first.late).meshBlamed).toBe(true);

    const second = stutter();
    second.frames.blocked(second.from, second.late - second.from, "mesh");
    second.frames.blocked(second.from, second.late - second.from, "app");
    expect(second.frames.read(second.late).meshBlamed).toBe(true);
  });

  test("a long frame that cost nobody a frame takes no colour at all", () => {
    const frames = createFrames();
    const at = run(frames, T0, 60, HZ120);
    // the browser reported a long frame; nothing was lost in it, so nothing here is a finding
    frames.blocked(T0, at - T0, "mesh");
    const seen = frames.read(at);
    expect(seen.dropped).toBe(0);
    expect(seen.meshBlamed).toBe(false);
    expect(seen.buckets.every((bucket) => bucket.blame === "none")).toBe(true);
  });
});

describe("a tab that has stopped painting says so rather than showing a plausible number", () => {
  test("a stall reads as not measuring, with no rate to report", () => {
    const frames = createFrames();
    const at = run(frames, T0, 60, HZ120);
    expect(frames.read(at).measuring).toBe(true);

    const stalled = frames.read(at + STALLED_MS + 1);
    expect(stalled.measuring).toBe(false);
    // not a zero and not the last good figure: both of those are readings this cannot make
    expect(stalled.fps).toBeUndefined();
  });

  test("the run rolls forward while nothing paints, so the bars empty instead of freezing", () => {
    const frames = createFrames();
    const at = run(frames, T0, 60, HZ120);
    expect(frames.read(at).buckets.some((bucket) => bucket.frames > 0)).toBe(true);

    const later = frames.read(at + BUCKET_MS * (BUCKETS + 1));
    expect(later.buckets.every((bucket) => bucket.frames === 0)).toBe(true);
    expect(later.buckets).toHaveLength(BUCKETS);
  });

  test("frames a second comes from complete buckets, so the one in flight never reads as a drop", () => {
    const frames = createFrames();
    // exactly one second of a steady 120Hz, read a hair into the next bucket
    const at = run(frames, T0, 200, HZ120);
    expect(frames.read(at).fps).toBe(120);
  });
});

const render = (node: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    text: () => container.textContent ?? "",
    fills: () =>
      [...container.querySelectorAll("div")].map((node) => node.style.background).filter(Boolean),
    close: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

const reading = (over: Partial<ReturnType<FrameSampler["read"]>>) => ({
  buckets: Array.from({ length: BUCKETS }, () => ({
    frames: 2,
    dropped: 0,
    blame: "none" as const,
  })),
  fps: 116,
  hz: 120,
  measuring: true,
  dropped: 0,
  meshBlamed: false,
  ...over,
});

describe("the meter draws what it measured and nothing it did not", () => {
  test("a runtime that does not paint gets no meter, rather than a meter reading zero", () => {
    const panel = render(<Frames reading={undefined} />);
    expect(panel.text()).toBe("");
    panel.close();
  });

  test("a high-refresh display is reported as it is, not clamped to 60", () => {
    const panel = render(<Frames attribution="long-animation-frame" reading={reading({})} />);
    expect(panel.text()).toBe("116 fps");
    panel.close();
  });

  test("a stalled tab shows a missing figure, in the shape of a figure", () => {
    const panel = render(<Frames reading={reading({ measuring: false, fps: undefined })} />);
    // never a sentence. A bare "not measuring" in the strip reads as a status line for whatever
    // panel is under it — it was read as "the database is not being read" above the storage
    // counts. A dash where the number goes cannot be mistaken for anything but this meter, and
    // the reason stays in the tooltip, which is where the sentence belongs.
    expect(panel.text()).toBe("\u2014 fps");
    expect(panel.text()).not.toContain("not measuring");
    panel.close();
  });

  test("a bucket blamed on syncmesh takes the loud colour; one merely late does not", () => {
    const mesh = reading({
      meshBlamed: true,
      dropped: 3,
      buckets: Array.from({ length: BUCKETS }, (_, at) => ({
        frames: 2,
        dropped: at === 4 ? 3 : 0,
        blame: at === 4 ? ("mesh" as const) : ("none" as const),
      })),
    });
    const panel = render(<Frames attribution="long-animation-frame" reading={mesh} />);
    expect(panel.fills()).toContain(SEVERITY_COLOR.critical);
    panel.close();

    const late = render(
      <Frames
        attribution="longtask"
        reading={reading({
          dropped: 3,
          buckets: Array.from({ length: BUCKETS }, (_, at) => ({
            frames: 2,
            dropped: at === 4 ? 3 : 0,
            blame: at === 4 ? ("unattributed" as const) : ("none" as const),
          })),
        })}
      />,
    );
    expect(late.fills()).toContain(SEVERITY_COLOR.high);
    expect(late.fills()).not.toContain(SEVERITY_COLOR.critical);
    late.close();
  });
});
