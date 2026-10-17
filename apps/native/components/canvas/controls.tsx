/**
 * The editor panels' building blocks, shared by Customize and My Designs.
 *
 * Built for people who are not confident with phones: every control is at
 * least 48dp, carries a word as well as an icon, and states what is selected
 * to screen readers.
 */

import { Ionicons } from "@expo/vector-icons";
import { Switch, useThemeColor } from "heroui-native";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { type StringKey, useT } from "@/lib/i18n";
import { FONTS } from "./fonts";
import type { AlignId, FontId } from "./scene";

type IconName = keyof typeof Ionicons.glyphMap;

export function HeaderButton({
	icon,
	label,
	onPress,
	disabled,
}: {
	icon: IconName;
	label: string;
	onPress: () => void;
	disabled?: boolean;
}) {
	const foreground = useThemeColor("foreground");
	return (
		<Pressable
			onPress={onPress}
			disabled={disabled}
			accessibilityRole="button"
			accessibilityState={{ disabled }}
			hitSlop={4}
			className={`min-h-12 flex-row items-center gap-1 rounded-full px-3 ${disabled ? "opacity-40" : ""}`}
		>
			<Ionicons name={icon} size={22} color={foreground} />
			<Text className="text-base text-foreground">{label}</Text>
		</Pressable>
	);
}

/**
 * Takes the space left over by the header and panel and hands its children
 * the largest size of the given aspect ratio that fits, centred. The canvas
 * is sized in dp; the scene is normalised, so any size is correct.
 */
export function CanvasArea({
	aspect,
	children,
}: {
	aspect: number;
	children: (width: number, height: number) => ReactNode;
}) {
	const [box, setBox] = useState<{ w: number; h: number } | null>(null);
	const fitted =
		box && box.w > 0 && box.h > 0
			? box.w / box.h > aspect
				? { w: Math.floor(box.h * aspect), h: Math.floor(box.h) }
				: { w: Math.floor(box.w), h: Math.floor(box.w / aspect) }
			: null;
	return (
		<View
			className="flex-1 items-center justify-center px-4 py-2"
			onLayout={(e) => {
				const { width, height } = e.nativeEvent.layout;
				// The padding is ours, not the canvas's.
				setBox({ w: width - 32, h: height - 16 });
			}}
		>
			{fitted ? children(fitted.w, fitted.h) : null}
		</View>
	);
}

export function ToolButton({
	icon,
	label,
	onPress,
	disabled,
	active,
}: {
	icon: IconName;
	label: string;
	onPress: () => void;
	disabled?: boolean;
	active?: boolean;
}) {
	const [foreground, accentSoft] = useThemeColor([
		"foreground",
		"accent-soft-foreground",
	]);
	return (
		<Pressable
			onPress={onPress}
			disabled={disabled}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled, selected: active }}
			className={`min-h-16 min-w-16 flex-1 items-center justify-center gap-1 rounded-xl px-1 py-2 ${active ? "bg-accent-soft" : "bg-surface-secondary"} ${disabled ? "opacity-40" : ""}`}
		>
			<Ionicons
				name={icon}
				size={22}
				color={active ? accentSoft : foreground}
			/>
			<Text
				numberOfLines={1}
				className={`text-xs ${active ? "font-semibold text-accent-soft-foreground" : "text-foreground"}`}
			>
				{label}
			</Text>
		</Pressable>
	);
}

export function Segmented<T extends string>({
	options,
	value,
	onChange,
}: {
	options: { id: T; label: string }[];
	value: T;
	onChange: (id: T) => void;
}) {
	return (
		<View
			accessibilityRole="tablist"
			className="flex-row gap-1 rounded-xl bg-surface-secondary p-1"
		>
			{options.map((o) => {
				const on = o.id === value;
				return (
					<Pressable
						key={o.id}
						onPress={() => onChange(o.id)}
						accessibilityRole="tab"
						accessibilityState={{ selected: on }}
						className={`min-h-12 flex-1 items-center justify-center rounded-lg px-2 ${on ? "bg-surface" : ""}`}
					>
						<Text
							numberOfLines={1}
							className={`text-sm ${on ? "font-semibold text-foreground" : "text-muted"}`}
						>
							{o.label}
						</Text>
					</Pressable>
				);
			})}
		</View>
	);
}

/** Colour dots. The colours are paint for the artwork, hence hardcoded. */
export function SwatchRow({
	colors,
	value,
	onChange,
	names,
}: {
	colors: readonly string[];
	value: string;
	onChange: (color: string) => void;
	names: string[];
}) {
	const accent = useThemeColor("accent");
	return (
		<View className="flex-row flex-wrap justify-between gap-2">
			{colors.map((color, i) => {
				const on = color.toLowerCase() === value.toLowerCase();
				return (
					<Pressable
						key={color}
						onPress={() => onChange(color)}
						accessibilityRole="radio"
						accessibilityLabel={names[i]}
						accessibilityState={{ checked: on }}
						className="h-12 w-12 items-center justify-center rounded-full"
						style={{ borderWidth: 3, borderColor: on ? accent : "transparent" }}
					>
						<View
							className="h-9 w-9 rounded-full border border-border"
							style={{ backgroundColor: color }}
						/>
					</Pressable>
				);
			})}
		</View>
	);
}

export function FontRow({
	value,
	onChange,
}: {
	value: FontId;
	onChange: (font: FontId) => void;
}) {
	const t = useT();
	return (
		<Segmented
			options={FONTS.map((f) => ({ id: f.id, label: t(f.label) }))}
			value={value}
			onChange={onChange}
		/>
	);
}

export function AlignRow({
	value,
	onChange,
}: {
	value: AlignId;
	onChange: (align: AlignId) => void;
}) {
	const t = useT();
	return (
		<Segmented
			options={[
				{ id: "left", label: t("editor.alignLeft") },
				{ id: "center", label: t("editor.alignCenter") },
				{ id: "right", label: t("editor.alignRight") },
			]}
			value={value}
			onChange={onChange}
		/>
	);
}

/**
 * Bigger / smaller buttons. Pinch works too, but many people in this
 * audience have never pinched anything; a button they can read always works.
 */
export function SizeRow({
	onSmaller,
	onBigger,
	disabled,
}: {
	onSmaller: () => void;
	onBigger: () => void;
	disabled?: boolean;
}) {
	const t = useT();
	return (
		<View className="flex-row gap-2">
			<ToolButton
				icon="remove-circle-outline"
				label={t("editor.smaller")}
				onPress={onSmaller}
				disabled={disabled}
			/>
			<ToolButton
				icon="add-circle-outline"
				label={t("editor.bigger")}
				onPress={onBigger}
				disabled={disabled}
			/>
		</View>
	);
}

export function ToggleRow({
	label,
	hint,
	value,
	onChange,
	disabled,
}: {
	label: string;
	hint?: string;
	value: boolean;
	onChange: (value: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<Pressable
			onPress={() => !disabled && onChange(!value)}
			accessibilityRole="switch"
			accessibilityLabel={label}
			accessibilityHint={hint}
			accessibilityState={{ checked: value, disabled }}
			className={`min-h-14 flex-row items-center gap-3 py-1 ${disabled ? "opacity-50" : ""}`}
		>
			<View className="flex-1">
				<Text className="text-base text-foreground">{label}</Text>
				{hint ? <Text className="text-muted text-xs">{hint}</Text> : null}
			</View>
			<Switch
				isSelected={value}
				onSelectedChange={onChange}
				isDisabled={disabled}
			/>
		</Pressable>
	);
}

export const COLOR_NAMES: StringKey[] = [
	"editor.colorWhite",
	"editor.colorBlack",
	"editor.colorGold",
	"editor.colorSaffron",
	"editor.colorMaroon",
	"editor.colorGreen",
];

export const BACKGROUND_COLOR_NAMES: StringKey[] = [
	"editor.colorCream",
	"editor.colorWhite",
	"editor.colorSaffron",
	"editor.colorMaroon",
	"editor.colorBlue",
	"editor.colorBlack",
];
