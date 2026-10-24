import { Ionicons } from "@expo/vector-icons";
import { useThemeColor } from "heroui-native";
import { Pressable, Text } from "react-native";

/**
 * A top-bar action with its word next to the icon — "‹ Back", "⚑ Report".
 * Never icon-only: this audience reads the word, not the glyph.
 */
export function HeaderButton({
	icon,
	label,
	onPress,
}: {
	icon: keyof typeof Ionicons.glyphMap;
	label: string;
	onPress: () => void;
}) {
	const foreground = useThemeColor("foreground");
	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			hitSlop={4}
			className="min-h-12 flex-row items-center gap-1 rounded-full px-3"
		>
			<Ionicons name={icon} size={22} color={foreground} />
			<Text className="text-base text-foreground">{label}</Text>
		</Pressable>
	);
}
