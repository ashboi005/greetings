import { Ionicons } from "@expo/vector-icons";
import {
	type InfiniteData,
	type QueryKey,
	type UseInfiniteQueryResult,
	useQueryClient,
} from "@tanstack/react-query";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { Skeleton, Spinner, useThemeColor } from "heroui-native";
import { type ReactElement, type ReactNode, useState } from "react";
import {
	FlatList,
	Platform,
	Pressable,
	RefreshControl,
	Text,
	useWindowDimensions,
	View,
} from "react-native";

import { getThumbnailUrl } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { useI18n } from "@/lib/i18n";
import type { FeedItem } from "@/lib/types";
import { ActionButton } from "./action-button";
import { ErrorState } from "./state-views";

/**
 * The two-column greeting grid shared by Home, Search and Saved, and the tile
 * it is made of.
 *
 * All three lists page the same way — an opaque `nextCursor`, null at the end —
 * so the paging, refresh, loading, empty and error handling live here once.
 * docs/mobile-integration.md §4 has the cursor rules this follows.
 */

const SIDE_PADDING = 16;
const COLUMN_GAP = 12;

/**
 * Every grid asks the CDN for this one width, whatever the phone. A handful of
 * fixed sizes cache far better at Cloudflare's edge than a width computed per
 * device (§8); 200dp covers a tile on anything up to a large phone.
 */
const THUMBNAIL_WIDTH_DP = 200;

/** Portrait, the shape most greetings are drawn in. */
export const TILE_ASPECT_RATIO = 4 / 5;

/** Where a greeting was opened from — also its analytics `source`. */
export type GreetingSource = "feed" | "search" | "detail" | "history";

export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

export type PagedQuery<T> = UseInfiniteQueryResult<
	InfiniteData<Page<T>, unknown>,
	Error
>;

/** What a tile needs to draw itself and to open the detail screen. */
export interface GreetingSummary {
	id: string;
	title: string;
	imageUrl: string | null;
	designerName?: string;
	downloadCount?: number;
}

/** Feed and search items share this shape. */
export function feedSummary(item: FeedItem): GreetingSummary {
	return {
		id: item.id,
		title: item.title,
		imageUrl: item.imageUrl,
		designerName: item.designer.name,
		downloadCount: item.downloadCount,
	};
}

/**
 * Opens the detail screen. There is no "get one content item" endpoint, so the
 * list hands over everything the detail screen shows as route params.
 */
export function useOpenGreeting() {
	const router = useRouter();
	return (item: GreetingSummary, source: GreetingSource) => {
		const params: Record<string, string> = {
			id: item.id,
			title: item.title,
			source,
		};
		if (item.imageUrl) params.imageUrl = item.imageUrl;
		if (item.designerName) params.designerName = item.designerName;
		if (item.downloadCount !== undefined) {
			params.downloadCount = String(item.downloadCount);
		}
		router.push({ pathname: "/(app)/content/[id]", params });
	};
}

/** The resized thumbnail every list paints — never the full-size original. */
export function greetingThumbnail(imageUrl: string | null): string | null {
	return getThumbnailUrl(imageUrl, THUMBNAIL_WIDTH_DP);
}

function useTileWidth(): number {
	const { width } = useWindowDimensions();
	return Math.floor((width - SIDE_PADDING * 2 - COLUMN_GAP) / 2);
}

export function GreetingTile({
	item,
	caption,
	width,
	onPress,
}: {
	item: GreetingSummary;
	caption?: string;
	width: number;
	onPress: () => void;
}) {
	const muted = useThemeColor("muted");
	const thumbnail = greetingThumbnail(item.imageUrl);

	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={item.title}
			style={({ pressed }) => ({ width, opacity: pressed ? 0.8 : 1 })}
		>
			<View
				className="items-center justify-center overflow-hidden rounded-2xl bg-surface-secondary"
				style={{ width, aspectRatio: TILE_ASPECT_RATIO }}
			>
				{thumbnail ? (
					<Image
						source={{ uri: thumbnail }}
						style={{ width: "100%", height: "100%" }}
						contentFit="cover"
						cachePolicy="memory-disk"
						recyclingKey={item.id}
						transition={150}
						accessibilityIgnoresInvertColors
					/>
				) : (
					// No CDN in this deployment (§8): a placeholder, never a guessed URL.
					<Ionicons name="image-outline" size={36} color={muted} />
				)}
			</View>
			<Text
				numberOfLines={2}
				className="mt-2 font-medium text-base text-foreground leading-snug"
			>
				{item.title}
			</Text>
			{caption ? (
				<Text numberOfLines={1} className="text-muted text-sm">
					{caption}
				</Text>
			) : null}
		</Pressable>
	);
}

/** Grey tiles in the grid's exact shape, so nothing jumps when data arrives. */
export function SkeletonGrid({ count = 6 }: { count?: number }) {
	const width = useTileWidth();
	return (
		<View
			className="flex-row flex-wrap"
			style={{ columnGap: COLUMN_GAP, rowGap: 20 }}
			accessibilityElementsHidden
			importantForAccessibility="no-hide-descendants"
		>
			{Array.from({ length: count }, (_, i) => (
				// Placeholders have no identity; their position is the only key.
				// biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
				<View key={i} style={{ width }}>
					<Skeleton
						className="rounded-2xl"
						style={{ width, aspectRatio: TILE_ASPECT_RATIO }}
					/>
					<Skeleton className="mt-2 h-4 w-3/4 rounded-md" />
				</View>
			))}
		</View>
	);
}

/**
 * The paged grid itself.
 *
 * Pull-to-refresh trims the cached pages to the first one before refetching.
 * React Query's plain `refetch()` would replay every page with its old cursor,
 * and the guide is explicit that a refresh starts again from page 1 (§4).
 */
export function GreetingGrid<T extends { id: string }>({
	query,
	queryKey,
	toSummary,
	caption,
	source,
	header,
	empty,
	idle,
	keyboardDismissMode,
}: {
	query: PagedQuery<T>;
	queryKey: QueryKey;
	toSummary: (item: T) => GreetingSummary;
	caption?: (item: T) => string | undefined;
	source: GreetingSource;
	header?: ReactElement;
	empty: ReactNode;
	/** Shown instead of everything else when the query is not running at all. */
	idle?: ReactNode;
	keyboardDismissMode?: "none" | "on-drag";
}) {
	const queryClient = useQueryClient();
	const openGreeting = useOpenGreeting();
	const { t, language } = useI18n();
	const tileWidth = useTileWidth();
	const [accent, surface] = useThemeColor(["accent", "surface"]);
	const [refreshing, setRefreshing] = useState(false);

	const items = query.data?.pages.flatMap((page) => page.items) ?? [];

	const refreshFromTop = async () => {
		setRefreshing(true);
		queryClient.setQueryData<InfiniteData<Page<T>, unknown>>(
			queryKey,
			(data) =>
				data && {
					pages: data.pages.slice(0, 1),
					pageParams: data.pageParams.slice(0, 1),
				},
		);
		try {
			await query.refetch();
		} finally {
			setRefreshing(false);
		}
	};

	const loadMore = () => {
		if (
			query.hasNextPage &&
			!query.isFetchingNextPage &&
			!query.isFetchNextPageError
		) {
			void query.fetchNextPage();
		}
	};

	let listEmpty: ReactNode;
	if (idle) listEmpty = idle;
	else if (query.isPending) listEmpty = <SkeletonGrid />;
	else if (query.isError) {
		listEmpty = (
			<ErrorState
				message={friendlyError(query.error, t, language)}
				onRetry={() => void query.refetch()}
			/>
		);
	} else listEmpty = empty;

	let footer: ReactNode = null;
	if (query.isFetchingNextPage) {
		footer = (
			<View className="items-center py-6">
				<Spinner color={accent} />
			</View>
		);
	} else if (query.isFetchNextPageError) {
		footer = (
			<View className="items-center gap-3 py-6">
				<Text className="text-base text-muted">
					{t("common.loadMoreFailed")}
				</Text>
				<ActionButton
					label={t("common.retry")}
					icon="refresh"
					variant="secondary"
					size="md"
					onPress={() => void query.fetchNextPage()}
				/>
			</View>
		);
	} else if (items.length > 0 && query.hasNextPage === false) {
		footer = (
			<Text className="py-8 text-center text-base text-muted">
				{t("common.endOfList")}
			</Text>
		);
	}

	return (
		<FlatList
			data={idle ? [] : items}
			keyExtractor={(item) => item.id}
			numColumns={2}
			renderItem={({ item }) => {
				const summary = toSummary(item);
				return (
					<GreetingTile
						item={summary}
						caption={caption?.(item)}
						width={tileWidth}
						onPress={() => openGreeting(summary, source)}
					/>
				);
			}}
			columnWrapperStyle={{ gap: COLUMN_GAP }}
			ItemSeparatorComponent={RowGap}
			ListHeaderComponent={header}
			ListEmptyComponent={<View>{listEmpty}</View>}
			ListFooterComponent={<View>{footer}</View>}
			contentContainerStyle={{
				flexGrow: 1,
				paddingHorizontal: SIDE_PADDING,
				paddingBottom: 24,
			}}
			onEndReached={loadMore}
			onEndReachedThreshold={0.6}
			refreshControl={
				idle ? undefined : (
					<RefreshControl
						refreshing={refreshing}
						onRefresh={refreshFromTop}
						tintColor={accent}
						colors={[accent]}
						progressBackgroundColor={surface}
					/>
				)
			}
			keyboardShouldPersistTaps="handled"
			keyboardDismissMode={keyboardDismissMode}
			initialNumToRender={6}
			maxToRenderPerBatch={6}
			windowSize={7}
			removeClippedSubviews={Platform.OS === "android"}
		/>
	);
}

function RowGap() {
	return <View style={{ height: 20 }} />;
}
