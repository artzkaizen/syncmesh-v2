import { Chip, ListGroup } from "heroui-native";
import { useCallback, useEffect, useState } from "react";
import { ScrollView } from "react-native";

import type { Waiting } from "../src/devtools-readings";
import type { Scale } from "../src/measure";

import { useDevice } from "../src/device";
import {
  buildFlags,
  healthNote,
  healthTone,
  readWaiting,
  readings,
} from "../src/devtools-readings";
import { Counting, Detail, LinkEvents, Transports, WritesWaiting } from "../src/devtools-sections";
import { meshInstruments } from "../src/open";
import { Caption, Notice, Section } from "../src/section";

/**
 * What this device is doing about sync, on the device, without a laptop.
 *
 * It exists because of two bugs that were invisible here and obvious in a source file. The first:
 * switching Wi-Fi off does not close a WebSocket — the connection is abandoned and no `close`
 * event arrives — so the relay went on believing it had a link for the **37 seconds** its
 * keepalive deadline takes to expire, while writes sat on disk with nowhere to go. The second:
 * Bluetooth was gated behind `extra.bluetooth` in `app.json` and nothing on the device said so.
 * Both were found by reading code and grepping a Metro log, which is not a thing a person holding
 * a phone can do.
 *
 * So the screen answers the five questions those two cost an afternoon each: which transports
 * exist, what condition each is in, when each last said anything, how many writes are waiting for
 * somebody to acknowledge them, and what this device is holding.
 *
 * **The honest bit is the third one.** A `Transport` reports link *endings* and a condition; it
 * does not report a frame arriving, and nothing above it does either. So no row here claims to
 * know when a medium last carried traffic. What catches the dead socket instead is the pair a
 * reader sees side by side: a relay whose condition still says `ok`, and a writes list that has
 * been growing for forty seconds.
 *
 * Deliberately **not** `@syncmesh/devtools`, which the web app mounts. That panel is a remote
 * source over a leader's port — an architecture this app does not have, because a phone's engine
 * is simply on the thread that asks it things — and its one entry point pulls `@syncmesh/browser`
 * and the DOM in with it. What is reused is the vocabulary: the same condition words, the same
 * ending severities, the same coarse ages. See `src/devtools-readings.ts`.
 */

/** A second, because everything on this screen is an age and an age that does not tick is a lie. */
const TICK_MS = 1000;

/** Enough waiting writes to see the shape of a queue; the count beside them carries the rest. */
const WAITING_SHOWN = 8;

export default function DevtoolsScreen() {
  const device = useDevice();
  const instruments = meshInstruments();
  const writes = instruments?.writes;

  /**
   * The clock this screen redraws against.
   *
   * A tick rather than a subscription, because the conditions and the endings are already in
   * memory and cost nothing to re-read, and because the thing that changes most often is not the
   * mesh but how long ago something happened. A panel whose "4s ago" stays at 4s is worse than no
   * panel: it reads as a fact rather than as a stopped clock.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(tick);
  }, []);

  /**
   * The ledger, read on a change rather than on the tick.
   *
   * `unsettled()` is a `LEFT JOIN` over the operations table, which is real work and not something
   * to do once a second for a number that only moves when a write commits or a receipt lands —
   * and `onChange` fires on exactly those two.
   */
  const [waiting, setWaiting] = useState<Waiting>();
  const reread = useCallback(
    () => void readWaiting(writes, WAITING_SHOWN).then(setWaiting),
    [writes],
  );
  useEffect(() => {
    reread();
    return writes?.onChange(reread);
  }, [reread, writes]);

  /** Three `count(*)`s over the whole log: read once, and again when somebody asks. */
  const [scale, setScale] = useState<Scale>();
  const measure = useCallback(() => void device.scale().then(setScale), [device]);
  useEffect(measure, [measure]);

  if (instruments === undefined)
    return (
      <Notice spinner={false}>
        No mesh is running on this device. Between a reset and the relaunch that follows it there is
        nothing to report.
      </Notice>
    );

  const { health } = instruments.status();
  const media = readings(instruments);
  const endings = instruments.endings();

  return (
    <ScrollView
      contentContainerStyle={{ gap: 24, paddingBottom: 48, paddingHorizontal: 16, paddingTop: 8 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Section title="Mesh">
        <ListGroup>
          <ListGroup.Item>
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle>Health</ListGroup.ItemTitle>
              <ListGroup.ItemDescription>{healthNote(health)}</ListGroup.ItemDescription>
            </ListGroup.ItemContent>
            <ListGroup.ItemSuffix>
              <Chip color={healthTone(health)} size="sm" variant="soft">
                <Chip.Label>{health}</Chip.Label>
              </Chip>
            </ListGroup.ItemSuffix>
          </ListGroup.Item>
        </ListGroup>
      </Section>

      <Transports media={media} nowMs={nowMs} />

      <WritesWaiting nowMs={nowMs} waiting={waiting} />

      <LinkEvents endings={endings} nowMs={nowMs} />

      <Section title="Build">
        <ListGroup>
          {buildFlags().map((flag) => (
            <Detail key={flag.key} label={`extra.${flag.key}`} value={flag.value} />
          ))}
          <Detail label="Relay in use" value={device.relay} />
          <Detail label="Authority in use" value={device.authority} />
        </ListGroup>
        <Caption>
          The extra block from app.json as this build actually read it, beside the addresses it
          derived. A radio switched off here is a transport that was never built, which is invisible
          everywhere else on the device — and “not declared” is a different fact from “false”.
        </Caption>
      </Section>

      <Section title="This device is holding">
        <ListGroup>
          {scale === undefined ? (
            <Counting />
          ) : (
            <>
              <Detail label="Events" value={scale.events.toLocaleString()} />
              <Detail label="State rows" value={scale.rows.toLocaleString()} />
              <Detail label="Log size" value={`${(scale.bytes / 1024).toFixed(0)} KB`} />
            </>
          )}
          <ListGroup.Item
            accessibilityLabel="Count the log again"
            accessibilityRole="button"
            className="min-h-11"
            onPress={measure}
          >
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle className="text-accent">Count the log again</ListGroup.ItemTitle>
              <ListGroup.ItemDescription>
                Three counts over the whole log, so it is asked for rather than watched
              </ListGroup.ItemDescription>
            </ListGroup.ItemContent>
          </ListGroup.Item>
        </ListGroup>
      </Section>
    </ScrollView>
  );
}
