import React, { useState } from "react";
import {
	View,
	Text,
	FlatList,
	Pressable,
	RefreshControl,
	ActivityIndicator,
	Dimensions,
	Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInfiniteQuery } from "@tanstack/react-query";
import { getFeed } from "@/lib/services";
import { getThumbnailUrl } from "@/lib/api";
import type { FeedItem } from "@/lib/types";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Surface } from "heroui-native";

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
				<Surface variant="secondary" className="rounded-2xl overflow-hidden shadow-sm border border-border/40">
					<View style={{ width: COLUMN_WIDTH, height: COLUMN_WIDTH * 1.2 }} className="bg-muted relative">
						{thumbUri ? (
							<Image
								source={{ uri: thumbUri }}
								style={{ width: "100%", height: "100%" }}
								resizeMode="cover"
							/>
						) : (
							<View className="flex-1 items-center justify-center p-4">
								<Ionicons name="image-outline" size={40} color="#9CA3AF" />
								<Text className="text-xs text-muted-foreground text-center mt-2">No preview</Text>
							</View>
						)}
					</View>

					<View className="p-3">
						<Text className="font-semibold text-foreground text-sm" numberOfLines={1}>
							{item.title}
						</Text>
						<View className="flex-row items-center justify-between mt-1">
							<Text className="text-xs text-muted-foreground" numberOfLines={1}>
								{item.designer?.name || "Designer"}
							</Text>
							<View className="flex-row items-center gap-1">
								<Ionicons name="download-outline" size={12} color="#6B7280" />
								<Text className="text-xs text-muted-foreground">{item.downloadCount}</Text>
							</View>
						</View>
					</View>
				</Surface>
			</Pressable>
		);
	};

	return (
		<SafeAreaView className="flex-1 bg-background" edges={["top"]}>
			<View className="px-4 py-3 flex-row items-center justify-between border-b border-border/30">
				<Text className="text-xl font-bold text-foreground">Greetings Feed</Text>
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
					<Text className="text-lg font-semibold text-foreground mt-3">Failed to load feed</Text>
					<Text className="text-sm text-muted-foreground text-center mt-1 mb-4">
						{(error as any)?.response?.data?.error?.message || (error as any)?.message || "Something went wrong"}
					</Text>
					<Pressable onPress={() => refetch()} className="bg-primary px-6 py-2.5 rounded-full">
						<Text className="text-primary-foreground font-medium">Retry</Text>
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
						<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} />
					}
					onEndReached={() => {
						if (hasNextPage && !isFetchingNextPage) {
							fetchNextPage();
						}
					}}
					onEndReachedThreshold={0.5}
					ListFooterComponent={
						isFetchingNextPage ? (
							<View className="py-4 items-center">
								<ActivityIndicator size="small" />
							</View>
						) : null
					}
					ListEmptyComponent={
						<View className="py-12 items-center">
							<Text className="text-muted-foreground">No greetings found</Text>
						</View>
					}
				/>
			)}
		</SafeAreaView>
	);
}
