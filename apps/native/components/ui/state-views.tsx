import { Ionicons } from "@expo/vector-icons";
import { useThemeColor } from "heroui-native";
import type { ReactNode } from "react";
import { Text, View } from "react-native";

import { useT } from "@/lib/i18n";
import { ActionButton } from "./action-button";

/**
 * A calm, centred message for "nothing here yet". Always says what to do next
 * when there is something to do — an empty screen with no way out reads as
 * "the app is broken" to someone unsure of themselves.
 */
export function EmptyState({
	icon,
	title,
	body,
	action,
}: {
	icon: keyof typeof Ionicons.glyphMap;
	title: string;
	body?: string;
	action?: ReactNode;
}) {
	const accentSoftForeground = useThemeColor("accent-soft-foreground");

	return (
		<View className="items-center px-8 py-12">
			<View className="mb-4 size-20 items-center justify-center rounded-full bg-accent-soft">
				<Ionicons name={icon} size={36} color={accentSoftForeground} />
			</View>
			<Text className="text-center font-heading-semibold text-foreground text-xl">
				{title}
			</Text>
			{body ? (
				<Text className="mt-2 text-center text-base text-muted">{body}</Text>
			) : null}
			{action ? <View className="mt-6 self-stretch">{action}</View> : null}
		</View>
	);
}

/** A failed load, with the one thing the person can do about it. */
export function ErrorState({
	message,
	onRetry,
}: {
	message: string;
	onRetry: () => void;
}) {
	const t = useT();
	return (
		<EmptyState
			icon="cloud-offline-outline"
			title={t("common.loadFailedTitle")}
			body={message}
			action={
				<ActionButton
					label={t("common.retry")}
					icon="refresh"
					variant="secondary"
					onPress={onRetry}
				/>
			}
		/>
	);
}
