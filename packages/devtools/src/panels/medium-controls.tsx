import type { ForcedMedium } from "@syncmesh/client";
import type { Result } from "@syncmesh/result";
import type { TransportCondition } from "@syncmesh/transport";

import { useState } from "react";

import type { ControlRefused, DevtoolsControls } from "../controls.js";
import type { MediumView } from "./link-kit.js";

import { FORCEABLE } from "../controls.js";
import { PREFIX } from "../css.js";
import { Tag } from "../react/primitives/index.js";
import { COLOR, RADIUS, SEVERITY_COLOR, SEVERITY_TINT, SPACE, TEXT } from "../tokens.js";
import { FAINT } from "./link-kit.js";

/**
 * The controls, which exist because the states this panel draws cannot otherwise be reached.
 *
 * Every other panel in this package can be made to show its interesting case by using the app: a
 * write that has not settled, a grant about to lapse, a peer that is behind. The Transports panel
 * cannot. You cannot turn off a real Bluetooth radio from JavaScript, put a LAN peer out of range,
 * or make a relay flap, and Chrome's own offline toggle only knows about HTTP — so `radio-off`,
 * `discovery-failed` and `connecting-failed` were words that had never been seen rendered on the
 * machine they were written on.
 *
 * **One verb, at two scopes.** A medium is either carrying or being held in a named condition, and
 * that is the whole vocabulary. There is no separate pause: a paused device *is* a device with
 * every medium off, the engine already implements offline→catch-up, and a second control that
 * produced the same state by a different route would be one more thing to leave switched on. So
 * the device-level toggle holds every medium in `temporarily-unavailable` — the same verb, applied
 * to all of them — and each row says so individually, because a global flag hides which mediums
 * existed.
 *
 * Nothing queues and nothing is dropped, because nothing is intercepted: the events a held device
 * does not send are simply still in its log, and the peer it was not talking to learns about them
 * from the cursor exchange the next session opens with. That is the path a device that walked out
 * of range already takes.
 */

/** The word for a medium that is carrying — the one entry in the picker that is not a condition. */
const CARRYING = "";

/** Every kind can be held in this one, which is why it is what the device-level toggle uses. */
const OFFLINE = "temporarily-unavailable" satisfies TransportCondition;

/** Every action here refuses the same way, so the loop over them needs one word for the outcome. */
type Refusable = Result<void, ControlRefused>;

const BUTTON = {
  ...TEXT.xs,
  border: `1px solid ${COLOR.hairline}`,
  borderRadius: RADIUS.md,
  height: 26,
  padding: `0 ${String(SPACE.sm)}px`,
} as const;

export interface MediumSwitchProps {
  readonly medium: MediumView;
  /** What this medium is being held in, or `undefined` when it is carrying on its own terms. */
  readonly held: TransportCondition | undefined;
  readonly controls: DevtoolsControls;
}

/**
 * One medium's switch: the conditions it can honestly be held in, and "carrying" for release.
 *
 * A picker rather than an on/off toggle, and that is the decision this component embodies. Off is
 * not one state — a radio that is switched off, one whose discovery failed, and one the user never
 * granted permission to are three different rows with three different severities and three
 * different sentences, and a boolean would have collapsed them into the least informative of the
 * three. The list comes from {@link FORCEABLE}, so a websocket is never offered a Bluetooth
 * permission it could not be refused by.
 *
 * A refusal stays on the row that caused it. The alternative is a toast that has gone by the time
 * anyone looks at the medium it was about.
 */
export function MediumSwitch({ medium, held, controls }: MediumSwitchProps) {
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const choose = async (value: string) => {
    setRefused(undefined);
    const outcome =
      value === CARRYING
        ? await controls.release(medium.name)
        : // SAFETY: the options are `FORCEABLE[kind]` verbatim, so the value is one of them
          await controls.force(medium.name, value as TransportCondition);
    if (outcome.isErr()) setRefused(outcome.error.message);
  };
  return (
    <span style={{ display: "flex", alignItems: "center", gap: SPACE.sm, flex: "none" }}>
      {refused === undefined ? null : (
        <Tag severity="critical" variant="solid">
          {refused}
        </Tag>
      )}
      <select
        aria-label={`Hold ${medium.name} in a condition`}
        className={`${PREFIX}-select`}
        onChange={(event) => void choose(event.target.value)}
        style={{ ...BUTTON, width: 168 }}
        value={held ?? CARRYING}
      >
        <option value={CARRYING}>carrying</option>
        {FORCEABLE[medium.kind].map((condition) => (
          <option key={condition} value={condition}>
            {condition}
          </option>
        ))}
      </select>
    </span>
  );
}

export interface DeviceSwitchProps {
  readonly mediums: readonly MediumView[];
  readonly forced: readonly ForcedMedium[];
  readonly controls: DevtoolsControls;
}

/**
 * Whether this device is carrying, partly held, or offline.
 *
 * **Three states, because forcing is per medium.** A binary toggle would have to call one held
 * radio out of three "off", and that is a lie of exactly the kind this panel refuses everywhere
 * else — the same shape as reporting a medium that cannot enumerate its links as *zero peers*. So
 * the half state gets its own rendering and its own words, and the words carry the count: *1 of 3
 * held* is actionable and *off* is not.
 */
type Engagement = "none" | "some" | "all";

const engagementOf = (mediums: number, held: number): Engagement =>
  held === 0 ? "none" : held >= mediums ? "all" : "some";

/** `role="checkbox"` rather than `switch`: only the checkbox role has a word for a mixed state. */
const CHECKED = { none: false, some: "mixed", all: true } satisfies Record<
  Engagement,
  boolean | "mixed"
>;

const wording = (state: Engagement, mediums: number, held: number) =>
  state === "all" ? "offline" : state === "none" ? "carrying" : `${held} of ${mediums} held`;

/**
 * The box that says which of the three it is — empty, dashed, filled.
 *
 * A checkbox's own vocabulary, because a reader already has it: a tick is all, a dash is some, and
 * an empty box is none. Drawn rather than written so the state survives being read at a glance
 * from across a desk, which is the whole reason the control and the indicator are one object.
 */
function Engaged({ state }: { readonly state: Engagement }) {
  const lit = state !== "none";
  return (
    <span
      aria-hidden="true"
      style={{
        width: 10,
        height: 10,
        flex: "none",
        display: "grid",
        placeItems: "center",
        borderRadius: RADIUS.sm,
        border: `1px solid ${lit ? SEVERITY_COLOR.high : COLOR.hairlineStrong}`,
        background: state === "all" ? SEVERITY_COLOR.high : "transparent",
      }}
    >
      {state === "some" ? (
        <span style={{ width: 6, height: 2, background: SEVERITY_COLOR.high }} />
      ) : null}
    </span>
  );
}

/**
 * One control that is also the indicator, for the whole device.
 *
 * A pair of buttons was the wrong shape: you pressed one thing to engage and a different thing to
 * disengage, and the fact that you were offline was reported somewhere else entirely. Here the
 * control carries its own state — the amber is the same amber as the `held here` tag on each row
 * and the mark on the bubble, so a reader never has to learn that two colours mean one fact.
 *
 * **Clicking from the half state holds the rest rather than releasing.** The gesture reads *go
 * offline*, so moving toward offline is the unsurprising reading; releasing mediums somebody
 * deliberately put into `radio-off` because they then clicked a control labelled with a count
 * would be the destructive surprise. The rule is therefore monotone: click until it says offline,
 * click once more to come back — and the per-medium pickers are still there for anyone who wants
 * one radio rather than all of them.
 *
 * It is not a second mechanism. It holds each medium by name, through the same verb the pickers
 * use, so every row afterwards says what it is being held in; a single hidden flag would have been
 * fewer clicks and one more thing that can be true without anything on screen saying which radios
 * it applies to.
 */
export function DeviceSwitch({ mediums, forced, controls }: DeviceSwitchProps) {
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const names = new Set(forced.map((one) => one.name));
  const state = engagementOf(mediums.length, names.size);
  const label = wording(state, mediums.length, names.size);
  // one at a time, because two swaps racing over one seat is a set nobody can reason about
  const run = async (over: readonly string[], act: (name: string) => Promise<Refusable>) => {
    setRefused(undefined);
    for (const name of over) {
      const outcome = await act(name);
      if (outcome.isErr()) return setRefused(outcome.error.message);
    }
  };
  const toggle = () =>
    void (state === "all"
      ? run([...names], controls.release)
      : run(
          mediums.filter((medium) => !names.has(medium.name)).map((medium) => medium.name),
          (name) => controls.force(name, OFFLINE),
        ));
  return (
    <span style={{ display: "flex", alignItems: "center", gap: SPACE.sm }}>
      {refused === undefined ? null : (
        <Tag severity="critical" variant="solid">
          {refused}
        </Tag>
      )}
      <button
        aria-checked={CHECKED[state]}
        aria-label={`Hold every medium off — ${label}`}
        disabled={mediums.length === 0}
        onClick={toggle}
        role="checkbox"
        style={{
          ...BUTTON,
          display: "inline-flex",
          alignItems: "center",
          gap: SPACE.sm,
          color: state === "none" ? COLOR.textDim : SEVERITY_COLOR.high,
          background: state === "none" ? "transparent" : SEVERITY_TINT.high,
          borderColor: state === "none" ? COLOR.hairline : `${SEVERITY_COLOR.high}33`,
        }}
        title={
          state === "all"
            ? "Every medium is held off. Click to give them all back."
            : "Hold every medium off, the way a device with no network is. Click again to release."
        }
        type="button"
      >
        <Engaged state={state} />
        {label}
      </button>
    </span>
  );
}

/**
 * What the panel says where a host passed no controls, in place of a switch that would do nothing.
 *
 * The same discipline the rest of the contract uses for an absent `storage` or `sql`: a capability
 * the source does not have is a sentence, never a greyed-out control, because a control that has
 * been disabled reads as broken and a sentence reads as a fact about this build.
 */
export function NoControls() {
  return (
    <span style={{ ...FAINT, maxWidth: 420 }}>
      read-only: this app installed the inspector without controls, so a medium cannot be held from
      here
    </span>
  );
}
