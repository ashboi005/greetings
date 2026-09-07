import React from "react";
import {
	View,
	Text,
	FlatList,
	Pressable,
	Image,
	ActivityIndicator,
	RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInfiniteQuery } from "@tanstack/react-query";
import { getDownloadHistory } from "@/lib/services";
import { getThumbnailUrl } from "@/lib/api";
import type { DownloadHistoryItem } from "@/lib/types";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Surface } from "heroui-native";

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
				<Surface variant="secondary" className="rounded-2xl p-3 flex-row items-center gap-3">
					<View className="w-16 h-16 rounded-xl bg-muted overflow-hidden items-center justify-center">
						{thumbUri ? (
							<Image source={{ uri: thumbUri }} style={{ width: "100%", height: "100%" }} />
						) : (
							<Ionicons name="image-outline" size={24} color="#9CA3AF" />
						)}
					</View>

					<View className="flex-1">
						<Text className="font-semibold text-foreground text-sm">{item.title}</Text>
						<Text className="text-xs text-muted-foreground mt-0.5">
							{item.designer?.name || "Designer"}
						</Text>
						<Text className="text-xs text-muted-foreground mt-1">
							Downloaded {item.timesDownloaded} time{item.timesDownloaded > 1 ? "s" : ""}
						</Text>
					</View>

					<Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
				</Surface>
			</Pressable>
		);
	};

	return (
		<SafeAreaView className="flex-1 bg-background" edges={["top"]}>
			<View className="px-4 py-3 border-b border-border/30">
				<Text className="text-xl font-bold text-foreground">Download History</Text>
				<Text className="text-xs text-muted-foreground mt-0.5">Your downloaded greetings</Text>
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
						<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} />
					}
					onEndReached={() => {
						if (hasNextPage && !isFetchingNextPage) {
							fetchNextPage();
						}
					}}
					onEndReachedThreshold={0.5}
					ListEmptyComponent={
						<View className="py-20 items-center">
							<Ionicons name="download-outline" size={48} color="#D1D5DB" />
							<Text className="text-foreground font-semibold mt-3">No downloads yet</Text>
							<Text className="text-xs text-muted-foreground mt-1">
								Greetings you download will appear here
							</Text>
						</View>
					}
				/>
			)}
		</SafeAreaView>
	);
}
