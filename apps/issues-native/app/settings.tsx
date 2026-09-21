import { WORKSPACE_ID } from "@syncmesh/issues";
import { useLiveQuery } from "@syncmesh/react";
import { useRouter } from "expo-router";
import { Chip, ListGroup, Spinner } from "heroui-native";
import { useCallback, useEffect, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";

import type { Scale } from "../src/measure";

import { radioAbsence, radioState } from "../src/ble";
import { useDevice } from "../src/device";
import { summary } from "../src/measure";
import { Avatar } from "../src/people";

/**
 * Everything about *this install* rather than about the workspace: who it is, what it can reach,
 * what it is holding, and the two destructive buttons.
 *
 * **The diagnostics used to be a banner wedged into the list header** — a debug string and a Reset
 * button riding above the issues, which is where they went when there was nowhere else to put
 * them. They belong here, and moving them is most of why the list now looks like a list.
 *
 * Rows are `ListGroup`, which is the library's grouped-inset list: dividers, pressed states, the
 * radius on the first and last child and the inset between are all its problem rather than a stack
 * of hand-tuned `View`s that drift from every other screen. The first pass built those by hand,
 * which is why the spacing here did not match anything else in the app.
 */
export default function SettingsScreen() {
  const device = useDevice();
  const router = useRouter();
  const people = useLiveQuery(device.api.members.list({ workspaceId: WORKSPACE_ID }));
  const me = people.data.find((person) => person.id === device.actor.account);

  /**
   * What this device is holding, read once when the screen opens.
   *
   * Deliberately not live: it is three `count(*)`s over the whole log, which is a real cost and a
   * number nobody watches tick. A pull-to-refresh would be the honest affordance if it ever needs
   * to move.
   */
  const [scale, setScale] = useState<Scale>();
  useEffect(() => void device.scale().then(setScale), [device]);

  const confirm = useCallback(
    (title: string, message: string, go: () => void) =>
      Alert.alert(title, message, [
        { style: "cancel", text: "Cancel" },
        { onPress: go, style: "destructive", text: title },
      ]),
    [],
  );

  return (
    <ScrollView
      contentContainerStyle={{ gap: 24, paddingBottom: 48, paddingHorizontal: 16, paddingTop: 8 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Section title="Account">
        <ListGroup>
          <ListGroup.Item onPress={() => router.push("/identity")}>
            <ListGroup.ItemPrefix>
              {me === undefined ? null : <Avatar person={me} size={32} />}
            </ListGroup.ItemPrefix>
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle>{me?.name ?? device.actor.account}</ListGroup.ItemTitle>
              <ListGroup.ItemDescription>
                {me === undefined ? "not in this workspace yet" : `@${me.handle}`}
              </ListGroup.ItemDescription>
            </ListGroup.ItemContent>
            <ListGroup.ItemSuffix>
              <Chip color="accent" size="sm" variant="soft">
                <Chip.Label>{device.actor.role}</Chip.Label>
              </Chip>
            </ListGroup.ItemSuffix>
          </ListGroup.Item>
          <ListGroup.Item onPress={() => router.push("/identity")}>
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle>Switch user or role</ListGroup.ItemTitle>
            </ListGroup.ItemContent>
          </ListGroup.Item>
          <ListGroup.Item
            onPress={() =>
              confirm(
                "Sign out",
                "This forgets who you are. The log and this device's key stay.",
                () => void device.signOut().then(() => router.replace("/identity")),
              )
            }
          >
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle>Sign out</ListGroup.ItemTitle>
            </ListGroup.ItemContent>
          </ListGroup.Item>
        </ListGroup>
        {/* said plainly, because the rest of this app is careful and a reader could reasonably
            assume the grant is not self-minted — `actor.ts` has the long version */}
        <Caption>
          This build mints its own grant from a bundled issuer key, so it can act as anyone at any
          role. A real deployment asks an authority instead.
        </Caption>
      </Section>

      <Section title="Workspace">
        <ListGroup>
          <ListGroup.Item onPress={() => router.push("/people")}>
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle>People</ListGroup.ItemTitle>
              <ListGroup.ItemDescription>
                {String(people.data.length)} in this workspace
              </ListGroup.ItemDescription>
            </ListGroup.ItemContent>
          </ListGroup.Item>
          <ListGroup.Item onPress={() => router.push("/workspace")}>
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle>Teams, labels and projects</ListGroup.ItemTitle>
              <ListGroup.ItemDescription>
                What you may change depends on your role
              </ListGroup.ItemDescription>
            </ListGroup.ItemContent>
          </ListGroup.Item>
        </ListGroup>
      </Section>

      <Section title="Sync">
        <ListGroup>
          <Detail label="Relay" value={device.relay} />
          <Detail label="Authority" value={device.authority} />
          {/* the radio's own word, not a build-time guess — see `radioAbsence` in `src/ble.ts`
              for why one sentence for three different situations sent people to check the wrong
              thing */}
          <Detail label="Over the air" value={overTheAir(device.overTheAir)} />
          {/* the three rows above are what this install was *told*; devtools is what it is
              actually doing about it, which is a different question and a whole screen */}
          <ListGroup.Item
            accessibilityLabel="Devtools"
            accessibilityRole="button"
            onPress={() => router.push("/devtools")}
          >
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle>Devtools</ListGroup.ItemTitle>
              <ListGroup.ItemDescription>
                Transport conditions, link events, and writes nobody has acknowledged
              </ListGroup.ItemDescription>
            </ListGroup.ItemContent>
          </ListGroup.Item>
        </ListGroup>
        <Caption>
          Reads are answered by this device's own database either way. A transport only changes how
          soon somebody else's write arrives.
        </Caption>
      </Section>

      <Section title="This device is holding">
        <ListGroup>
          {scale === undefined ? (
            <ListGroup.Item>
              <ListGroup.ItemContent>
                <Spinner size="sm" />
              </ListGroup.ItemContent>
            </ListGroup.Item>
          ) : (
            <>
              <Detail label="Events" value={scale.events.toLocaleString()} />
              <Detail label="State rows" value={scale.rows.toLocaleString()} />
              <Detail label="Log size" value={`${(scale.bytes / 1024).toFixed(0)} KB`} />
            </>
          )}
          <Detail label="Last join" value={summary() || "not measured this launch"} />
        </ListGroup>
      </Section>

      <Section title="Danger">
        <ListGroup>
          <ListGroup.Item
            onPress={() =>
              confirm(
                "Reset replica",
                "Deletes this device's copy and rejoins from scratch. Anything written here that no peer has carried is lost.",
                () => void device.reset(),
              )
            }
          >
            <ListGroup.ItemContent>
              <ListGroup.ItemTitle className="text-danger">Reset local replica</ListGroup.ItemTitle>
            </ListGroup.ItemContent>
          </ListGroup.Item>
        </ListGroup>
        <Caption>
          The log lives on the peers too, so this loses nothing that was acknowledged — it just
          makes this device new again, which is the only way to measure a first sync twice.
        </Caption>
      </Section>
    </ScrollView>
  );
}

/**
 * What the radio is doing, in the words of whichever thing is actually stopping it.
 *
 * Each of these sends a person somewhere different: to `app.json`, to a rebuild, to iOS Settings,
 * or to Control Centre. Collapsing them into "Bluetooth radio present" — which was true even when
 * the permission had been refused — is what made this unanswerable on the device.
 */
const RADIO = {
  poweredOn: "on — scanning and advertising",
  poweredOff: "Bluetooth is off in Control Centre",
  unauthorized: "permission refused — allow it in iOS Settings",
  unsupported: "this device has no Bluetooth radio",
  resetting: "the radio is restarting",
  unknown: "starting up…",
} as const;

const overTheAir = (running: boolean): string => {
  if (!running) {
    const why = radioAbsence();
    if (why === "switched-off-in-config") return "switched off in app.json — needs a rebuild";
    if (why === "not-in-this-build") return "the native module is not in this build";
    return "not started";
  }
  const state = radioState();
  return state === undefined
    ? "starting up…"
    : (RADIO[state as keyof typeof RADIO] ?? `adapter says "${state}"`);
};

/** A read-only row: a name on the left, the value on the right, selectable because URLs get pasted. */
const Detail = ({ label, value }: { readonly label: string; readonly value: string }) => (
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

const Section = ({
  children,
  title,
}: {
  readonly children: React.ReactNode;
  readonly title: string;
}) => (
  <View className="gap-2">
    <Text className="px-1 text-[13px] font-medium text-muted-foreground">{title}</Text>
    {children}
  </View>
);

const Caption = ({ children }: { readonly children: React.ReactNode }) => (
  <Text className="px-1 text-[12px] leading-[17px] text-muted-foreground">{children}</Text>
);

const Notice = ({
  children,
  spinner = true,
}: {
  readonly children: React.ReactNode;
  readonly spinner?: boolean;
}) => (
  <View className="flex-1 items-center justify-center gap-3 p-8">
    {spinner ? <Spinner size="sm" /> : null}
    <Text className="text-center text-[15px] text-muted-foreground">{children}</Text>
  </View>
);
