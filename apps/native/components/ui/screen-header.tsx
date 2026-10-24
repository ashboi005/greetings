import type { ReactNode } from "react";
import { Text, View } from "react-native";

/**
 * The title block at the top of a tab screen.
 *
 * Big and plain on purpose: for this audience the heading is how they confirm
 * which screen they are on, so it is the one thing that must never be small.
 */
export function ScreenHeader({
	title,
	subtitle,
	right,
}: {
	title: string;
	subtitle?: string;
	right?: ReactNode;
}) {
	return (
		<View className="flex-row items-center gap-3 pt-3 pb-4">
			<View className="flex-1">
				<Text
					className="font-heading text-2xl text-foreground"
					accessibilityRole="header"
				>
					{title}
				</Text>
				{subtitle ? (
					<Text className="mt-0.5 text-base text-muted">{subtitle}</Text>
				) : null}
			</View>
			{right}
		</View>
	);
}
