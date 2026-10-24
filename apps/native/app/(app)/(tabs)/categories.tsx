import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Skeleton, useThemeColor } from "heroui-native";
import {
	Pressable,
	RefreshControl,
	ScrollView,
	Text,
	useWindowDimensions,
	View,
} from "react-native";

import { useTags } from "@/components/ui/reference-data";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { ScreenHeader } from "@/components/ui/screen-header";
import { EmptyState, ErrorState } from "@/components/ui/state-views";
import { track } from "@/lib/analytics";
import { friendlyError } from "@/lib/errors";
import { useI18n } from "@/lib/i18n";
import { sortForDisplay, tagEmoji, tagLabel } from "@/lib/tag-display";
import type { Tag } from "@/lib/types";

const SIDE_PADDING = 16;
const GAP = 10;
const COLUMNS = 3;

/**
 * Sections, in order. Everyday occasions lead because Good Morning and Good
 * Night are what this audience shares most — daily, not yearly. `language`
 * and `region` tags exist too, but those are already the profile's job and
 * the search filters', so they are not repeated here as tiles.
 */
const SECTIONS = ["occasion", "festival", "theme"] as const;
type Section = (typeof SECTIONS)[number];

/**
 * Categories: browse by occasion, festival or theme.
 *
 * Asked for by the client. It replaces the Search tab rather than adding a
 * sixth — six tabs are too cramped to read on a 360dp phone — and search
 * lives on as the box at the top. A tile is a search with a tag and no text
 * (§5), so both open the same results screen.
 */
export default function CategoriesScreen() {
	const { t, language } = useI18n();
	const router = useRouter();
	const tags = useTags();
	const { width } = useWindowDimensions();
	// Floored: the exact share fills the row to the last fraction of a pixel,
	// and once layout rounds each tile up the third one wraps onto a new line.
	const tileWidth = Math.floor(
		(width - SIDE_PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS,
	);

	const grouped = new Map<Section | "other", Tag[]>();
	for (const tag of tags.data ?? []) {
		if (tag.category === "language" || tag.category === "region") continue;
		const key = (SECTIONS as readonly string[]).includes(tag.category)
			? (tag.category as Section)
			: "other";
		grouped.set(key, [...(grouped.get(key) ?? []), tag]);
	}
	const sections = [...SECTIONS, "other" as const].filter((key) =>
		grouped.has(key),
	);

	const openTag = (tag: Tag, section: Section | "other") => {
		track("category_opened", { category: section });
		router.push({
			pathname: "/(app)/search",
			params: { tagId: tag.id, title: tagLabel(tag, language) },
		});
	};

	return (
		<SafeAreaView edges={["top"]} className="flex-1 bg-background">
			<ScrollView
				contentContainerStyle={{
					paddingHorizontal: SIDE_PADDING,
					paddingBottom: 24,
				}}
				refreshControl={
					<RefreshControl
						refreshing={tags.isRefetching}
						onRefresh={() => void tags.refetch()}
					/>
				}
			>
				<ScreenHeader
					title={t("categories.title")}
					subtitle={t("categories.subtitle")}
				/>

				<SearchPrompt
					label={t("categories.searchPrompt")}
					onPress={() =>
						router.push({ pathname: "/(app)/search", params: { focus: "1" } })
					}
				/>

				{tags.isPending ? (
					<TileSkeletons width={tileWidth} />
				) : tags.isError ? (
					<ErrorState
						message={friendlyError(tags.error, t, language)}
						onRetry={() => void tags.refetch()}
					/>
				) : sections.length === 0 ? (
					<EmptyState
						icon="grid-outline"
						title={t("categories.emptyTitle")}
						body={t("categories.emptyBody")}
					/>
				) : (
					sections.map((section) => (
						<View key={section} className="mt-6">
							<Text
								className="mb-3 font-heading-semibold text-foreground text-lg"
								accessibilityRole="header"
							>
								{t(`categories.${section}`)}
							</Text>
							<View className="flex-row flex-wrap" style={{ gap: GAP }}>
								{sortForDisplay(grouped.get(section) ?? []).map((tag) => (
									<CategoryTile
										key={tag.id}
										emoji={tagEmoji(tag)}
										label={tagLabel(tag, language)}
										width={tileWidth}
										onPress={() => openTag(tag, section)}
									/>
								))}
							</View>
						</View>
					))
				)}
			</ScrollView>
		</SafeAreaView>
	);
}

/** Looks like a search field, but is a button: typing happens on the results screen. */
function SearchPrompt({
	label,
	onPress,
}: {
	label: string;
	onPress: () => void;
}) {
	const muted = useThemeColor("muted");
	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
			className="min-h-14 flex-row items-center gap-3 rounded-2xl border border-border bg-surface px-4"
		>
			<Ionicons name="search" size={22} color={muted} />
			<Text className="flex-1 text-base text-muted" numberOfLines={1}>
				{label}
			</Text>
		</Pressable>
	);
}

function CategoryTile({
	emoji,
	label,
	width,
	onPress,
}: {
	emoji: string;
	label: string;
	width: number;
	onPress: () => void;
}) {
	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
			style={{ width }}
			className="min-h-24 items-center justify-center gap-1.5 rounded-2xl border border-border bg-surface px-2 py-3 active:bg-accent-soft"
		>
			{/* Emoji are decoration; the label is what screen readers announce. */}
			<Text className="text-3xl" accessible={false}>
				{emoji}
			</Text>
			{/* Full width, or Android sizes the centred label to its first line
			    and clips the wrap: "रक्षा बंधन" showed as "रक्षा". */}
			<Text
				className="w-full text-center font-semibold text-foreground text-sm"
				numberOfLines={2}
			>
				{label}
			</Text>
		</Pressable>
	);
}

function TileSkeletons({ width }: { width: number }) {
	return (
		<View className="mt-6 flex-row flex-wrap" style={{ gap: GAP }}>
			{Array.from({ length: 9 }, (_, i) => (
				<Skeleton
					// biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
					key={i}
					className="h-24 rounded-2xl"
					style={{ width }}
				/>
			))}
		</View>
	);
}
