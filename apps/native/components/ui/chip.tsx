import { Ionicons } from "@expo/vector-icons";
import { cn, useThemeColor } from "heroui-native";
import { Pressable, Text } from "react-native";

/**
 * A selectable pill: filters, languages, settings choices.
 *
 * Selection is shown by a tick as well as by colour, because colour alone is
 * the first thing to go on a dim screen or for someone who is colour-blind.
 * 48dp tall so it is a comfortable target for an older thumb.
 */
export function Chip({
	label,
	selected,
	onPress,
	icon,
	className,
}: {
	label: string;
	selected: boolean;
	onPress: () => void;
	icon?: keyof typeof Ionicons.glyphMap;
	className?: string;
}) {
	const [accentSoftForeground, foreground] = useThemeColor([
		"accent-soft-foreground",
		"foreground",
	]);
	const iconName = selected ? "checkmark" : icon;

	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityState={{ selected }}
			hitSlop={4}
			className={cn(
				"min-h-12 flex-row items-center justify-center gap-1.5 rounded-full border px-4",
				selected ? "border-accent bg-accent-soft" : "border-border bg-surface",
				className,
			)}
		>
			{iconName ? (
				<Ionicons
					name={iconName}
					size={18}
					color={selected ? accentSoftForeground : foreground}
				/>
			) : null}
			<Text
				numberOfLines={1}
				className={cn(
					"text-base",
					selected
						? "font-semibold text-accent-soft-foreground"
						: "text-foreground",
				)}
			>
				{label}
			</Text>
		</Pressable>
	);
}
