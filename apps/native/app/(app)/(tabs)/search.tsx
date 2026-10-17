import { useInfiniteQuery } from "@tanstack/react-query";
import { SearchField } from "heroui-native";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Chip } from "@/components/ui/chip";
import { feedSummary, GreetingGrid } from "@/components/ui/greeting-grid";
import {
	useLanguages,
	useRegions,
	useTags,
} from "@/components/ui/reference-data";
import { RegionPickerModal } from "@/components/ui/region-list";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { ScreenHeader } from "@/components/ui/screen-header";
import { EmptyState } from "@/components/ui/state-views";
import { track } from "@/lib/analytics";
import { useT } from "@/lib/i18n";
import { searchContent } from "@/lib/services";
import type { Tag } from "@/lib/types";

/** Long enough that a slow typist is not searched mid-word. */
const DEBOUNCE_MS = 350;

/** The server's cap on `q`. */
const MAX_QUERY_LENGTH = 100;

/** Festivals lead: for this audience, tapping "Diwali" beats typing it. */
const TAG_CATEGORY_ORDER = ["festival", "occasion", "theme", "language"];

function sortTags(tags: Tag[]): Tag[] {
	const rank = (tag: Tag) => {
		const index = TAG_CATEGORY_ORDER.indexOf(tag.category);
		return index === -1 ? TAG_CATEGORY_ORDER.length : index;
	};
	return [...tags].sort((a, b) => rank(a) - rank(b));
}

/**
 * Search, and browse-by-filter.
 *
 * Both are the same endpoint: with no text it simply lists what matches the
 * filters (§5), so tapping a festival chip is a search with no `q`. Spelling
 * mistakes are the server's job — it has a fuzzy fallback — so nothing here
 * tries to correct them.
 */
export default function SearchScreen() {
	const t = useT();
	const [text, setText] = useState("");
	const [q, setQ] = useState("");
	const [tagId, setTagId] = useState<string | null>(null);
	const [language, setLanguage] = useState<string | null>(null);
	const [region, setRegion] = useState<string | null>(null);
	const [regionPickerOpen, setRegionPickerOpen] = useState(false);

	const tags = useTags();
	const languages = useLanguages();
	const regions = useRegions();

	useEffect(() => {
		const timer = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [text]);

	const hasFilters = Boolean(tagId || language || region);
	const isActive = Boolean(q) || hasFilters;
	const queryKey = ["search", { q, tagId, language, region }];

	const query = useInfiniteQuery({
		queryKey,
		queryFn: ({ pageParam }) => {
			// Once per search, not once per page.
			if (!pageParam) {
				track("search_performed", {
					has_query: Boolean(q),
					has_tag: Boolean(tagId),
					has_language: Boolean(language),
				});
			}
			return searchContent({
				q,
				tags: tagId ?? undefined,
				language: language ?? undefined,
				region: region ?? undefined,
				cursor: pageParam,
			});
		},
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.nextCursor,
		enabled: isActive,
	});

	const clearAll = () => {
		setText("");
		setQ("");
		setTagId(null);
		setLanguage(null);
		setRegion(null);
	};

	const regionName = regions.data?.find((r) => r.code === region)?.name;

	const header = (
		<View className="gap-4 pb-5">
			<ScreenHeader title={t("search.title")} />

			<SearchField value={text} onChange={setText}>
				<SearchField.Group>
					<SearchField.SearchIcon />
					<SearchField.Input
						placeholder={t("search.placeholder")}
						maxLength={MAX_QUERY_LENGTH}
						returnKeyType="search"
						onSubmitEditing={() => setQ(text.trim())}
						className="text-base"
					/>
					<SearchField.ClearButton />
				</SearchField.Group>
			</SearchField>

			{tags.data && tags.data.length > 0 ? (
				<FilterRow label={t("search.festivals")}>
					{sortTags(tags.data).map((tag) => (
						<Chip
							key={tag.id}
							label={tag.label}
							selected={tagId === tag.id}
							onPress={() => setTagId(tagId === tag.id ? null : tag.id)}
						/>
					))}
				</FilterRow>
			) : null}

			{languages.data && languages.data.length > 0 ? (
				<FilterRow label={t("search.language")}>
					{languages.data.map((lang) => (
						<Chip
							key={lang.code}
							label={lang.nativeName}
							selected={language === lang.code}
							onPress={() =>
								setLanguage(language === lang.code ? null : lang.code)
							}
						/>
					))}
				</FilterRow>
			) : null}

			<View className="flex-row flex-wrap items-center gap-3">
				{regions.data ? (
					<Chip
						label={regionName ?? t("search.anyState")}
						icon="location-outline"
						selected={Boolean(region)}
						onPress={() => setRegionPickerOpen(true)}
					/>
				) : null}
				{isActive ? (
					<Pressable
						onPress={clearAll}
						accessibilityRole="button"
						className="min-h-12 justify-center px-2"
					>
						<Text className="font-semibold text-accent text-base">
							{t("search.clearAll")}
						</Text>
					</Pressable>
				) : null}
			</View>

			<RegionPickerModal
				visible={regionPickerOpen}
				regions={regions.data ?? []}
				selected={region}
				onSelect={setRegion}
				onClose={() => setRegionPickerOpen(false)}
			/>
		</View>
	);

	return (
		<SafeAreaView edges={["top"]} className="flex-1 bg-background">
			<GreetingGrid
				query={query}
				queryKey={queryKey}
				source="search"
				toSummary={feedSummary}
				header={header}
				keyboardDismissMode="on-drag"
				idle={
					isActive ? undefined : (
						<EmptyState
							icon="search-outline"
							title={t("search.idleTitle")}
							body={t("search.idleBody")}
						/>
					)
				}
				empty={
					<EmptyState
						icon="sad-outline"
						title={t("search.emptyTitle")}
						body={t("search.emptyBody")}
					/>
				}
			/>
		</SafeAreaView>
	);
}

/** A labelled, sideways-scrolling row of chips that bleeds to the screen edge. */
function FilterRow({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<View className="gap-2">
			<Text className="font-semibold text-base text-foreground">{label}</Text>
			<ScrollView
				horizontal
				showsHorizontalScrollIndicator={false}
				keyboardShouldPersistTaps="handled"
				className="-mx-4"
				contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
			>
				{children}
			</ScrollView>
		</View>
	);
}
