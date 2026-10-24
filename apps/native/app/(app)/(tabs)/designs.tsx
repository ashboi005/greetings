import { Ionicons } from "@expo/vector-icons";
import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { Spinner, useThemeColor, useToast } from "heroui-native";
import { type ReactElement, useState } from "react";
import {
	FlatList,
	Pressable,
	RefreshControl,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import {
	defaultDesignDoc,
	serializeDesignDoc,
} from "@/components/canvas/scene";
import { TextPrompt } from "@/components/canvas/text-prompt";
import { ActionButton } from "@/components/ui/action-button";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { ScreenHeader } from "@/components/ui/screen-header";
import { EmptyState } from "@/components/ui/state-views";
import { track } from "@/lib/analytics";
import { getThumbnailUrl } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { useI18n } from "@/lib/i18n";
import { createDesign, getDesigns } from "@/lib/services";
import type { DesignSummary } from "@/lib/types";

/**
 * My Designs: the user's private studio, most recently edited first (§10).
 *
 * There is no delete here, on purpose — the API has none, by design. The
 * editor invalidates this list after every save, since saving uploads a new
 * preview and moves the design to the top.
 */

const DESIGNS_KEY = ["myDesigns"];
const SIDE_PADDING = 16;
const COLUMN_GAP = 12;
/** One fixed CDN width for every phone: fixed sizes cache at the edge (§8). */
const THUMBNAIL_WIDTH_DP = 200;

export default function DesignsScreen() {
	const { t, language } = useI18n();
	const router = useRouter();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const { width } = useWindowDimensions();
	const [creating, setCreating] = useState(false);

	const query = useInfiniteQuery({
		queryKey: DESIGNS_KEY,
		queryFn: ({ pageParam }) => getDesigns(pageParam),
		initialPageParam: null as string | null,
		getNextPageParam: (last) => last.nextCursor,
	});

	const create = useMutation({
		mutationFn: (title: string) =>
			createDesign({
				title,
				designJson: serializeDesignDoc(defaultDesignDoc()),
			}),
		onSuccess: (design) => {
			setCreating(false);
			track("design_created");
			void queryClient.invalidateQueries({ queryKey: DESIGNS_KEY });
			router.push({ pathname: "/design/[id]", params: { id: design.id } });
		},
		onError: (cause) => {
			toast.show({
				variant: "danger",
				label: friendlyError(cause, t, language),
			});
		},
	});

	const designs = query.data?.pages.flatMap((page) => page.items) ?? [];
	const tileWidth = (width - SIDE_PADDING * 2 - COLUMN_GAP) / 2;

	const newButton = (
		<ActionButton
			label={t("designs.create")}
			icon="add"
			size="md"
			onPress={() => setCreating(true)}
		/>
	);

	let empty: ReactElement;
	if (query.isPending) {
		empty = (
			<View className="items-center py-16">
				<Spinner />
			</View>
		);
	} else if (query.isError) {
		empty = (
			<EmptyState
				icon="cloud-offline-outline"
				title={friendlyError(query.error, t, language)}
				action={
					<ActionButton
						label={t("common.retry")}
						icon="refresh"
						variant="secondary"
						onPress={() => void query.refetch()}
					/>
				}
			/>
		);
	} else {
		empty = (
			<EmptyState
				icon="color-palette-outline"
				title={t("designs.emptyTitle")}
				body={t("designs.emptyBody")}
				action={
					<ActionButton
						label={t("designs.create")}
						icon="add"
						onPress={() => setCreating(true)}
					/>
				}
			/>
		);
	}

	return (
		<SafeAreaView edges={["top"]} className="flex-1 bg-background">
			<FlatList
				data={designs}
				keyExtractor={(item) => item.id}
				numColumns={2}
				columnWrapperStyle={{ gap: COLUMN_GAP }}
				contentContainerStyle={{
					paddingHorizontal: SIDE_PADDING,
					paddingBottom: 24,
					gap: COLUMN_GAP,
				}}
				ListHeaderComponent={
					<ScreenHeader
						title={t("designs.title")}
						subtitle={t("designs.subtitle")}
						right={designs.length > 0 ? newButton : undefined}
					/>
				}
				ListEmptyComponent={empty}
				ListFooterComponent={
					query.isFetchingNextPage ? (
						<View className="items-center py-4">
							<Spinner />
						</View>
					) : null
				}
				renderItem={({ item }) => (
					<DesignTile
						design={item}
						width={tileWidth}
						updatedLabel={t("designs.updated", {
							date: formatDate(item.updatedAt, language),
						})}
						onPress={() =>
							router.push({ pathname: "/design/[id]", params: { id: item.id } })
						}
					/>
				)}
				onEndReached={() => {
					if (query.hasNextPage && !query.isFetchingNextPage) {
						void query.fetchNextPage();
					}
				}}
				onEndReachedThreshold={0.5}
				refreshControl={
					<RefreshControl
						refreshing={query.isRefetching && !query.isFetchingNextPage}
						onRefresh={() => void query.refetch()}
					/>
				}
			/>

			<TextPrompt
				visible={creating}
				title={t("designs.createTitle")}
				label={t("designs.titleLabel")}
				placeholder={t("designs.titlePlaceholder")}
				maxLength={80}
				confirmLabel={t("designs.createConfirm")}
				busy={create.isPending}
				onCancel={() => setCreating(false)}
				onSubmit={(title) => create.mutate(title)}
			/>
		</SafeAreaView>
	);
}

function DesignTile({
	design,
	width,
	updatedLabel,
	onPress,
}: {
	design: DesignSummary;
	width: number;
	updatedLabel: string;
	onPress: () => void;
}) {
	const muted = useThemeColor("muted");
	const thumbnail = getThumbnailUrl(design.previewUrl, THUMBNAIL_WIDTH_DP);
	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={`${design.title}, ${updatedLabel}`}
			style={{ width }}
			className="gap-1.5"
		>
			<View
				className="items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-secondary"
				style={{ width, height: width }}
			>
				{thumbnail ? (
					<Image
						source={{ uri: thumbnail }}
						style={{ width: "100%", height: "100%" }}
						contentFit="contain"
						transition={150}
						recyclingKey={design.id}
					/>
				) : (
					<Ionicons name="color-palette-outline" size={36} color={muted} />
				)}
			</View>
			<Text
				className="font-semibold text-base text-foreground"
				numberOfLines={1}
			>
				{design.title}
			</Text>
			<Text className="text-muted text-sm" numberOfLines={1}>
				{updatedLabel}
			</Text>
		</Pressable>
	);
}

function formatDate(iso: string, language: "en" | "hi"): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleDateString(language === "hi" ? "hi-IN" : "en-IN", {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}
