import { Ionicons } from "@expo/vector-icons";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Surface } from "heroui-native";
import {
	ActivityIndicator,
	FlatList,
	Image,
	Pressable,
	RefreshControl,
	Text,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getThumbnailUrl } from "@/lib/api";
import { getDownloadHistory } from "@/lib/services";
import type { DownloadHistoryItem } from "@/lib/types";

export default function DownloadsScreen() {
	const router = useRouter();

	const {
		data,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isLoading,
		refetch,
		isRefetching,
	} = useInfiniteQuery({
		queryKey: ["downloadHistory"],
		queryFn: ({ pageParam = null }) => getDownloadHistory(pageParam, 20),
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		initialPageParam: null as string | null,
	});

	const downloadItems = data?.pages.flatMap((page) => page.items) || [];

	const renderItem = ({ item }: { item: DownloadHistoryItem }) => {
		const thumbUri = getThumbnailUrl(item.imageUrl, 80);

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
						},
					})
				}
				className="mb-3"
			>
				<Surface
					variant="secondary"
					className="flex-row items-center gap-3 rounded-2xl p-3"
				>
					<View className="h-16 w-16 items-center justify-center overflow-hidden rounded-xl bg-muted">
						{thumbUri ? (
							<Image
								source={{ uri: thumbUri }}
								style={{ width: "100%", height: "100%" }}
							/>
						) : (
							<Ionicons name="image-outline" size={24} color="#9CA3AF" />
						)}
					</View>

					<View className="flex-1">
						<Text className="font-semibold text-foreground text-sm">
							{item.title}
						</Text>
						<Text className="mt-0.5 text-muted-foreground text-xs">
							{item.designer?.name || "Designer"}
						</Text>
						<Text className="mt-1 text-muted-foreground text-xs">
							Downloaded {item.timesDownloaded} time
							{item.timesDownloaded > 1 ? "s" : ""}
						</Text>
					</View>

					<Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
				</Surface>
			</Pressable>
		);
	};

	return (
		<SafeAreaView className="flex-1 bg-background" edges={["top"]}>
			<View className="border-border/30 border-b px-4 py-3">
				<Text className="font-bold text-foreground text-xl">
					Download History
				</Text>
				<Text className="mt-0.5 text-muted-foreground text-xs">
					Your downloaded greetings
				</Text>
			</View>

			{isLoading ? (
				<View className="flex-1 items-center justify-center">
					<ActivityIndicator size="large" />
				</View>
			) : (
				<FlatList
					data={downloadItems}
					renderItem={renderItem}
					keyExtractor={(item, index) => `${item.id}-${index}`}
					contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
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
					ListEmptyComponent={
						<View className="items-center py-20">
							<Ionicons name="download-outline" size={48} color="#D1D5DB" />
							<Text className="mt-3 font-semibold text-foreground">
								No downloads yet
							</Text>
							<Text className="mt-1 text-muted-foreground text-xs">
								Greetings you download will appear here
							</Text>
						</View>
					}
				/>
			)}
		</SafeAreaView>
	);
}
