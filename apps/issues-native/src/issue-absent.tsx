import type { ReactNode } from "react";

import { Spinner } from "heroui-native";
import { Text, View } from "react-native";

/**
 * Absent is three different facts, and only one of them is "deleted".
 *
 * **The screen used to render two of the three.** A row deleted on another phone is taken out of
 * this one's tables outright — the fold hard-deletes it — so `issues.get` answers *deleted* and
 * *never heard of* with the same empty result, and this screen said "not on this device" about an
 * issue it had watched a peer delete. The record that remembers the delete is the engine's, kept
 * because a concurrent edit has to be able to beat it, and `Replica.deleted` is the door onto it.
 *
 * `deleted` is read first because it is the only one of the three that is positive knowledge. The
 * other two are readings of an absence; this one is a fact the replica holds, so a device that is
 * still catching up already knows it — and no amount of catching up produces a row a peer deleted.
 *
 * `settled` separates the remaining two: until every source has answered, an issue this device has
 * not heard of yet is *not here yet* rather than gone, and saying "not on this device" about a row
 * a laptop is holding would be as wrong as the opposite (book ch. 9).
 *
 * What none of them says is **who**. The tombstone names the device that wrote the delete, and a
 * device is not an account; "deleted by Bo" is a join against the activity feed, not this.
 */
export const Absent = ({
  deleted,
  settled,
}: {
  readonly deleted: boolean;
  readonly settled: boolean;
}) => {
  if (deleted) return <Centred busy={false}>That issue was deleted.</Centred>;
  if (settled) return <Centred busy={false}>That issue is not on this device.</Centred>;
  return <Centred>Catching up…</Centred>;
};

/**
 * One sentence in the middle of the screen, with a spinner only where something is still running.
 *
 * `busy` is not decoration. "That issue was deleted." is a final answer, and a spinner under it
 * says the opposite — that this device is still working and the sentence may yet change.
 */
const Centred = ({
  busy = true,
  children,
}: {
  readonly busy?: boolean;
  readonly children: ReactNode;
}) => (
  <View className="flex-1 items-center justify-center gap-3 p-8">
    {busy ? <Spinner size="sm" /> : null}
    <Text className="text-center text-[15px] text-muted-foreground">{children}</Text>
  </View>
);
