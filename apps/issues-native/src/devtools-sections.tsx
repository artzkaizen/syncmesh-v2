import type { DevtoolsLinkEvent } from "@syncmesh/devtools";
import type { ReactNode } from "react";

import { Chip, ListGroup, Spinner } from "heroui-native";
import { Text, View } from "react-native";

import type { Reading, Waiting } from "./devtools-readings";

import { endingLine, endingTone, since } from "./devtools-readings";
import { Caption, Section } from "./section";

/** Enough endings to read a reconnect storm without turning the screen into a log viewer. */
const ENDINGS_SHOWN = 8;

/** Each medium this mesh built, its condition and its last word, and a way to wake them all. */
export function Transports({
  media,
  nowMs,
}: {
  readonly media: readonly Reading[];
  readonly nowMs: number;
}) {
  const wakeable = media.filter((reading) => reading.wake !== undefined);
  return (
    <Section title="Transports">
      <ListGroup>
        {media.length === 0 ? (
          <Plain>
            No medium is attached. This device is on its own log — reads still answer, writes still
            commit, and nothing is going anywhere.
          </Plain>
        ) : (
          media.map((reading) => (
            <ListGroup.Item key={reading.name}>
              <ListGroup.ItemContent>
                <ListGroup.ItemTitle>
                  {reading.name} · {reading.kind}
                </ListGroup.ItemTitle>
                <ListGroup.ItemDescription>{reading.note}</ListGroup.ItemDescription>
                <ListGroup.ItemDescription>
                  {reading.said === undefined
                    ? "has said nothing since this app launched"
                    : `last said ${since(reading.said.at.epochMilliseconds, nowMs)} ago — ${endingLine(reading.said)}`}
                </ListGroup.ItemDescription>
              </ListGroup.ItemContent>
              <ListGroup.ItemSuffix>
                <Chip color={reading.tone} size="sm" variant="soft">
                  <Chip.Label>{reading.condition}</Chip.Label>
                </Chip>
              </ListGroup.ItemSuffix>
            </ListGroup.Item>
          ))
        )}
        {wakeable.length === 0 ? null : (
          <ListGroup.Item
            accessibilityLabel="Re-check every link"
            accessibilityRole="button"
            className="min-h-11"
            onPress={() => {
              for (const reading of wakeable) reading.wake?.();
            }}
          >
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle className="text-accent">Re-check every link</ListGroup.ItemTitle>
              <ListGroup.ItemDescription>
                Hangs up and dials again rather than waiting out a keepalive deadline
              </ListGroup.ItemDescription>
            </ListGroup.ItemContent>
          </ListGroup.Item>
        )}
      </ListGroup>
      <Caption>
        A transport reports endings and a condition, never a frame — so "last said" is the last
        thing the medium announced, not the last thing it carried. A link that proved itself at
        launch and died an hour ago reads exactly like one that is fine; the writes below are what
        tell them apart.
      </Caption>
    </Section>
  );
}

/** The writes committed here that no peer has receipted yet, oldest first. */
export function WritesWaiting({
  nowMs,
  waiting,
}: {
  readonly nowMs: number;
  readonly waiting: Waiting | undefined;
}) {
  return (
    <Section title="Writes waiting">
      <ListGroup>
        {waiting === undefined ? (
          <Counting />
        ) : waiting.refused !== undefined ? (
          <Plain>{waiting.refused}</Plain>
        ) : waiting.total === 0 ? (
          <Plain>Nothing waiting. Every write this device made has been receipted by a peer.</Plain>
        ) : (
          <>
            <Detail
              label="Unacknowledged"
              value={`${waiting.total} write${waiting.total === 1 ? "" : "s"}`}
            />
            {waiting.rows.map((row) => (
              <ListGroup.Item key={row.id}>
                <ListGroup.ItemContent>
                  <ListGroup.ItemTitle>{row.label}</ListGroup.ItemTitle>
                  <ListGroup.ItemDescription>
                    committed {since(row.atMs, nowMs)} ago
                  </ListGroup.ItemDescription>
                </ListGroup.ItemContent>
                <ListGroup.ItemSuffix>
                  <Chip color="default" size="sm" variant="soft">
                    <Chip.Label>{row.status}</Chip.Label>
                  </Chip>
                </ListGroup.ItemSuffix>
              </ListGroup.Item>
            ))}
          </>
        )}
      </ListGroup>
      <Caption>
        {waiting !== undefined && waiting.total > waiting.rows.length
          ? `The oldest ${waiting.rows.length} of ${waiting.total}. `
          : ""}
        Committed here and held by nobody else yet. This is the reading that catches a link which
        believes in itself: a relay still reading ok above a list that keeps growing is a socket the
        network already took away.
      </Caption>
    </Section>
  );
}

/** The link endings kept since the mesh opened, newest first. */
export function LinkEvents({
  endings,
  nowMs,
}: {
  readonly endings: readonly DevtoolsLinkEvent[];
  readonly nowMs: number;
}) {
  return (
    <Section title="Link events">
      <ListGroup>
        {endings.length === 0 ? (
          <Plain>Nothing has ended since this app launched.</Plain>
        ) : (
          endings.slice(0, ENDINGS_SHOWN).map((event) => (
            // the ring's own ordinal, which never repeats — a key built from the array index
            // names a *position*, and the ending sitting at position 3 is a different ending a
            // moment later, so a reader who had not scrolled would see one row become another
            <ListGroup.Item key={event.id}>
              <ListGroup.ItemContent>
                <ListGroup.ItemTitle>{event.transport}</ListGroup.ItemTitle>
                <ListGroup.ItemDescription>{endingLine(event)}</ListGroup.ItemDescription>
              </ListGroup.ItemContent>
              <ListGroup.ItemSuffix>
                <View className="items-end gap-1">
                  <Chip color={endingTone(event.kind)} size="sm" variant="soft">
                    <Chip.Label>{event.kind}</Chip.Label>
                  </Chip>
                  <Text className="text-[11px] text-muted-foreground">
                    {since(event.at.epochMilliseconds, nowMs)} ago
                  </Text>
                </View>
              </ListGroup.ItemSuffix>
            </ListGroup.Item>
          ))
        )}
      </ListGroup>
      <Caption>
        Kept from the moment the mesh opened, because the feed underneath retains nothing: a panel
        that subscribed when you opened it could only ever show the quiet that followed.
      </Caption>
    </Section>
  );
}

/**
 * The chrome, mirroring `app/settings.tsx` row for row.
 *
 * Copied rather than shared on purpose and only for now: settings owns its own copies, the two
 * screens are being worked on at once, and lifting them into a module while both are moving would
 * be a merge conflict in place of a wrapper. They belong in one place the moment both are still.
 */

/** A read-only row: a name on the left, the value on the right, selectable because URLs get pasted. */
export const Detail = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <ListGroup.Item>
    <ListGroup.ItemContent>
      <ListGroup.ItemTitle>{label}</ListGroup.ItemTitle>
    </ListGroup.ItemContent>
    <ListGroup.ItemSuffix>
      <Text
        className="max-w-[200px] text-right text-[13px] text-muted-foreground"
        numberOfLines={2}
        // a relay URL that is wrong is a URL somebody needs to paste somewhere
        selectable
      >
        {value}
      </Text>
    </ListGroup.ItemSuffix>
  </ListGroup.Item>
);

/** A row that is a sentence rather than a pair: an absence said out loud, which a zero cannot say. */
export const Plain = ({ children }: { readonly children: ReactNode }) => (
  <ListGroup.Item>
    <ListGroup.ItemContent>
      <Text className="text-[13px] text-muted-foreground">{children}</Text>
    </ListGroup.ItemContent>
  </ListGroup.Item>
);

/**
 * A row whose figure is still being counted.
 *
 * Its own component rather than a `Plain` holding a spinner, because a `Spinner` is a `View` and a
 * `View` inside a `Text` is not a thing React Native lays out — it renders wrong on iOS and throws
 * on Android, which is a bug you find on the platform you did not open first.
 */
export const Counting = () => (
  <ListGroup.Item>
    <ListGroup.ItemContent>
      <Spinner size="sm" />
    </ListGroup.ItemContent>
  </ListGroup.Item>
);
