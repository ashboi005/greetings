import { Ionicons } from "@expo/vector-icons";
import { Button, Spinner, useThemeColor } from "heroui-native";

type Variant = "primary" | "secondary" | "tertiary" | "danger-soft";

/**
 * A button that always carries a word, never just an icon.
 *
 * The audience reads icons unevenly — a share glyph means nothing to plenty of
 * first-time smartphone users — so every action names itself. The icon is
 * there to be recognised on the second visit, not to replace the label.
 */
export function ActionButton({
	label,
	icon,
	onPress,
	variant = "primary",
	size = "lg",
	isLoading = false,
	isDisabled = false,
	className,
}: {
	label: string;
	icon?: keyof typeof Ionicons.glyphMap;
	onPress: () => void;
	variant?: Variant;
	size?: "md" | "lg";
	isLoading?: boolean;
	isDisabled?: boolean;
	className?: string;
}) {
	const colors = useThemeColor([
		"accent-foreground",
		"accent-soft-foreground",
		"default-foreground",
		"danger-soft-foreground",
	]);
	const tint = {
		primary: colors[0],
		secondary: colors[1],
		tertiary: colors[2],
		"danger-soft": colors[3],
	}[variant];

	return (
		<Button
			variant={variant}
			size={size}
			onPress={onPress}
			isDisabled={isDisabled || isLoading}
			className={className}
			accessibilityLabel={label}
		>
			{isLoading ? (
				<Spinner size="sm" color={tint} />
			) : icon ? (
				<Ionicons name={icon} size={size === "lg" ? 22 : 20} color={tint} />
			) : null}
			<Button.Label numberOfLines={1}>{label}</Button.Label>
		</Button>
	);
}
