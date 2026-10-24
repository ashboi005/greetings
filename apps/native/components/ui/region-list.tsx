import { Ionicons } from "@expo/vector-icons";
import { cn, SearchField, useThemeColor } from "heroui-native";
import { type ReactElement, useState } from "react";
import { FlatList, Modal, Platform, Pressable, Text, View } from "react-native";

import { useT } from "@/lib/i18n";
import type { Region } from "@/lib/types";
import { SafeAreaView } from "./safe-area-view";

/**
 * The 36 states and union territories as a searchable vertical list.
 *
 * Vertical rather than a horizontal strip of chips: 36 names in a sideways
 * scroller hide 30 of them, and nobody over sixty is going to swipe through to
 * find Uttarakhand. Typing two letters narrows it; scrolling still works.
 */
export function RegionList({
	regions,
	selected,
	onSelect,
	header,
}: {
	regions: Region[];
	selected: string | null;
	onSelect: (code: string) => void;
	header?: ReactElement;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	const accentSoftForeground = useThemeColor("accent-soft-foreground");
	const muted = useThemeColor("muted");

	const needle = query.trim().toLowerCase();
	const visible = needle
		? regions.filter((r) => r.name.toLowerCase().includes(needle))
		: regions;

	return (
		<FlatList
			data={visible}
			keyExtractor={(region) => region.code}
			keyboardShouldPersistTaps="handled"
			keyboardDismissMode="on-drag"
			contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
			ListHeaderComponent={
				<View className="gap-4 pb-3">
					{header}
					<SearchField value={query} onChange={setQuery}>
						<SearchField.Group>
							<SearchField.SearchIcon />
							<SearchField.Input
								placeholder={t("common.searchStates")}
								className="text-base"
								autoCorrect={false}
								returnKeyType="search"
							/>
							<SearchField.ClearButton />
						</SearchField.Group>
					</SearchField>
				</View>
			}
			ItemSeparatorComponent={() => <View className="h-2" />}
			ListEmptyComponent={
				<Text className="py-8 text-center text-base text-muted">
					{t("common.noStatesMatch")}
				</Text>
			}
			renderItem={({ item }) => {
				const isSelected = item.code === selected;
				return (
					<Pressable
						onPress={() => onSelect(item.code)}
						accessibilityRole="radio"
						accessibilityState={{ selected: isSelected }}
						className={cn(
							"min-h-14 flex-row items-center gap-3 rounded-2xl border px-4",
							isSelected
								? "border-accent bg-accent-soft"
								: "border-border bg-surface",
						)}
					>
						<Ionicons
							name={isSelected ? "radio-button-on" : "radio-button-off"}
							size={22}
							color={isSelected ? accentSoftForeground : muted}
						/>
						<Text
							className={cn(
								"flex-1 text-base",
								isSelected
									? "font-semibold text-accent-soft-foreground"
									: "text-foreground",
							)}
						>
							{item.name}
						</Text>
					</Pressable>
				);
			}}
		/>
	);
}

/** The same list in a full-height sheet, for changing the state later. */
export function RegionPickerModal({
	visible,
	regions,
	selected,
	onSelect,
	onClose,
}: {
	visible: boolean;
	regions: Region[];
	selected: string | null;
	onSelect: (code: string) => void;
	onClose: () => void;
}) {
	const t = useT();
	const foreground = useThemeColor("foreground");

	return (
		<Modal
			visible={visible}
			animationType="slide"
			presentationStyle={Platform.OS === "ios" ? "pageSheet" : undefined}
			onRequestClose={onClose}
			statusBarTranslucent
			navigationBarTranslucent
		>
			<SafeAreaView
				className="flex-1 bg-background"
				edges={Platform.OS === "ios" ? ["bottom"] : ["top", "bottom"]}
			>
				<View className="flex-row items-center px-4 pt-4 pb-2">
					<Text
						className="flex-1 font-heading text-foreground text-xl"
						accessibilityRole="header"
					>
						{t("common.chooseState")}
					</Text>
					<Pressable
						onPress={onClose}
						accessibilityRole="button"
						accessibilityLabel={t("common.close")}
						hitSlop={8}
						className="min-h-12 flex-row items-center gap-1 px-2"
					>
						<Ionicons name="close" size={24} color={foreground} />
						<Text className="text-base text-foreground">
							{t("common.close")}
						</Text>
					</Pressable>
				</View>
				<RegionList
					regions={regions}
					selected={selected}
					onSelect={(code) => {
						onSelect(code);
						onClose();
					}}
				/>
			</SafeAreaView>
		</Modal>
	);
}
