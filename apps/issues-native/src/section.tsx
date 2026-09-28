import type { ReactNode } from "react";

import { Spinner } from "heroui-native";
import { Text, View } from "react-native";

/** A titled group of rows. Shared by the devtools and settings screens. */
export const Section = ({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: string;
}) => (
  <View className="gap-2">
    <Text className="px-1 text-[13px] font-medium text-muted-foreground">{title}</Text>
    {children}
  </View>
);

export const Caption = ({ children }: { readonly children: ReactNode }) => (
  <Text className="px-1 text-[12px] leading-[17px] text-muted-foreground">{children}</Text>
);

export const Notice = ({
  children,
  spinner = true,
}: {
  readonly children: ReactNode;
  readonly spinner?: boolean;
}) => (
  <View className="flex-1 items-center justify-center gap-3 p-8">
    {spinner ? <Spinner size="sm" /> : null}
    <Text className="text-center text-[15px] text-muted-foreground">{children}</Text>
  </View>
);
