import { Ionicons } from "@expo/vector-icons";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Surface } from "heroui-native";
import {
	ActivityIndicator,
	Dimensions,
	FlatList,
	Image,
	Pressable,
	RefreshControl,
	Text,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { apiErrorMessage, getThumbnailUrl } from "@/lib/api";
import { getFeed } from "@/lib/services";
import type { FeedItem } from "@/lib/types";

const { width } = Dimensions.get("window");
const COLUMN_WIDTH = (width - 36) / 2;

export default function FeedScreen() {
	const router = useRouter();

	const {
		data,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isLoading,
		isError,
		error,
		refetch,
		isRefetching,
	} = useInfiniteQuery({
		queryKey: ["feed"],
		queryFn: ({ pageParam = null }) => getFeed(pageParam, 20),
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		initialPageParam: null as string | null,
	});

	const feedItems = data?.pages.flatMap((page) => page.items) || [];

	const renderItem = ({ item }: { item: FeedItem }) => {
		const thumbUri = getThumbnailUrl(item.imageUrl, COLUMN_WIDTH);

		return (
			<Pressable
				onPress={() =>
					router.push({
						pathname: "/(drawer)/content/[id]",
						params: {
							id: item.id,
							title: item.title,
							imageUrl: item.imageUrl || "",
							designerName: item.designer?.name || "",
							downloadCount: item.downloadCount.toString(),
						},
					})
				}
				className="mb-4"
				style={{ width: COLUMN_WIDTH }}
			>
				<Surface
					variant="secondary"
					className="overflow-hidden rounded-2xl border border-border/40 shadow-sm"
				>
					<View
						style={{ width: COLUMN_WIDTH, height: COLUMN_WIDTH * 1.2 }}
						className="relative bg-muted"
					>
						{thumbUri ? (
							<Image
								source={{ uri: thumbUri }}
								style={{ width: "100%", height: "100%" }}
								resizeMode="cover"
							/>
						) : (
							<View className="flex-1 items-center justify-center p-4">
								<Ionicons name="image-outline" size={40} color="#9CA3AF" />
								<Text className="mt-2 text-center text-muted-foreground text-xs">
									No preview
								</Text>
							</View>
						)}
					</View>

					<View className="p-3">
						<Text
							className="font-semibold text-foreground text-sm"
							numberOfLines={1}
						>
							{item.title}
						</Text>
						<View className="mt-1 flex-row items-center justify-between">
							<Text className="text-muted-foreground text-xs" numberOfLines={1}>
								{item.designer?.name || "Designer"}
							</Text>
							<View className="flex-row items-center gap-1">
								<Ionicons name="download-outline" size={12} color="#6B7280" />
								<Text className="text-muted-foreground text-xs">
									{item.downloadCount}
								</Text>
							</View>
						</View>
					</View>
				</Surface>
			</Pressable>
		);
	};

	return (
		<SafeAreaView className="flex-1 bg-background" edges={["top"]}>
			<View className="flex-row items-center justify-between border-border/30 border-b px-4 py-3">
				<Text className="font-bold text-foreground text-xl">
					Greetings Feed
				</Text>
				<Ionicons name="sparkles" size={20} color="#6366F1" />
			</View>

			{isLoading ? (
				<View className="flex-1 items-center justify-center">
					<ActivityIndicator size="large" />
					<Text className="mt-3 text-muted-foreground">Loading feed...</Text>
				</View>
			) : isError ? (
				<View className="flex-1 items-center justify-center p-6">
					<Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
					<Text className="mt-3 font-semibold text-foreground text-lg">
						Failed to load feed
					</Text>
					<Text className="mt-1 mb-4 text-center text-muted-foreground text-sm">
						{apiErrorMessage(error, "Something went wrong")}
					</Text>
					<Pressable
						onPress={() => refetch()}
						className="rounded-full bg-primary px-6 py-2.5"
					>
						<Text className="font-medium text-primary-foreground">Retry</Text>
					</Pressable>
				</View>
			) : (
				<FlatList
					data={feedItems}
					renderItem={renderItem}
					keyExtractor={(item, index) => `${item.id}-${index}`}
					numColumns={2}
					columnWrapperStyle={{ justifyContent: "space-between" }}
					contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
					refreshControl={
						<RefreshControl
							refreshing={isRefetching}
							onRefresh={() => refetch()}
						/>
					}
					onEndReached={() => {
						if (hasNextPage && !isFetchingNextPage) {
							fetchNextPage();
						}
					}}
					onEndReachedThreshold={0.5}
					ListFooterComponent={
						isFetchingNextPage ? (
							<View className="items-center py-4">
								<ActivityIndicator size="small" />
							</View>
						) : null
					}
					ListEmptyComponent={
						<View className="items-center py-12">
							<Text className="text-muted-foreground">No greetings found</Text>
						</View>
					}
				/>
			)}
		</SafeAreaView>
	);
}
