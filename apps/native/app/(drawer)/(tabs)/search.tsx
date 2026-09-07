import React, { useState } from "react";
import {
	View,
	Text,
	FlatList,
	Pressable,
	Image,
	Dimensions,
	ActivityIndicator,
	ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { getTags, getLanguages, getRegions, searchContent } from "@/lib/services";
import { getThumbnailUrl } from "@/lib/api";
import type { FeedItem } from "@/lib/types";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Surface, Input } from "heroui-native";

const { width } = Dimensions.get("window");
const COLUMN_WIDTH = (width - 36) / 2;

export default function SearchScreen() {
	const router = useRouter();
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedTag, setSelectedTag] = useState<string | null>(null);
	const [selectedLang, setSelectedLang] = useState<string | null>(null);
	const [selectedRegion, setSelectedRegion] = useState<string | null>(null);

	const { data: tags } = useQuery({
		queryKey: ["tags"],
		queryFn: () => getTags(),
	});

	const { data: languages } = useQuery({
		queryKey: ["languages"],
		queryFn: () => getLanguages(),
	});

	const { data: regions } = useQuery({
		queryKey: ["regions"],
		queryFn: () => getRegions(),
	});

	const {
		data,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isLoading,
		refetch,
	} = useInfiniteQuery({
		queryKey: ["search", searchQuery, selectedTag, selectedLang, selectedRegion],
		queryFn: ({ pageParam = null }) =>
			searchContent({
				q: searchQuery.trim() || undefined,
				tags: selectedTag || undefined,
				language: selectedLang || undefined,
				region: selectedRegion || undefined,
				cursor: pageParam,
				limit: 20,
			}),
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		initialPageParam: null as string | null,
	});

	const searchItems = data?.pages.flatMap((page) => page.items) || [];

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
					<View style={{ width: COLUMN_WIDTH, height: COLUMN_WIDTH * 1.2 }} className="bg-muted">
						{thumbUri ? (
							<Image
								source={{ uri: thumbUri }}
								style={{ width: "100%", height: "100%" }}
								resizeMode="cover"
							/>
						) : (
							<View className="flex-1 items-center justify-center p-4">
								<Ionicons name="image-outline" size={40} color="#9CA3AF" />
							</View>
						)}
					</View>
					<View className="p-3">
						<Text className="font-semibold text-foreground text-sm" numberOfLines={1}>
							{item.title}
						</Text>
						<Text className="text-xs text-muted-foreground mt-1" numberOfLines={1}>
							{item.designer?.name || "Designer"}
						</Text>
					</View>
				</Surface>
			</Pressable>
		);
	};

	return (
		<SafeAreaView className="flex-1 bg-background" edges={["top"]}>
			<View className="px-4 py-3 border-b border-border/30">
				<Text className="text-xl font-bold text-foreground mb-3">Search & Browse</Text>

				<View className="flex-row items-center bg-muted/60 rounded-xl px-3 py-1">
					<Ionicons name="search" size={18} color="#9CA3AF" />
					<Input
						value={searchQuery}
						onChangeText={setSearchQuery}
						placeholder="Search greetings, festival names..."
						className="flex-1 border-0 bg-transparent px-2 py-1"
					/>
					{searchQuery ? (
						<Pressable onPress={() => setSearchQuery("")}>
							<Ionicons name="close-circle" size={18} color="#9CA3AF" />
						</Pressable>
					) : null}
				</View>
			</View>

			{/* Filter Chips */}
			<View className="py-2 border-b border-border/20">
				<ScrollView horizontal showsHorizontalScrollIndicator={false} className="px-4 flex-row gap-2">
					{tags?.map((t) => {
						const isSelected = selectedTag === t.id;
						return (
							<Pressable
								key={t.id}
								onPress={() => setSelectedTag(isSelected ? null : t.id)}
								className={`px-3 py-1.5 rounded-full border mr-1 ${
									isSelected ? "bg-primary border-primary" : "bg-muted/40 border-border/50"
								}`}
							>
								<Text className={`text-xs ${isSelected ? "text-primary-foreground font-bold" : "text-foreground"}`}>
									#{t.label}
								</Text>
							</Pressable>
						);
					})}
				</ScrollView>

				{languages && languages.length > 0 ? (
					<ScrollView horizontal showsHorizontalScrollIndicator={false} className="px-4 flex-row gap-2 mt-2">
						{languages.map((l) => {
							const isSelected = selectedLang === l.code;
							return (
								<Pressable
									key={l.code}
									onPress={() => setSelectedLang(isSelected ? null : l.code)}
									className={`px-3 py-1 rounded-full border mr-1 ${
										isSelected ? "bg-primary/80 border-primary" : "bg-background border-border/40"
									}`}
								>
									<Text className={`text-xs ${isSelected ? "text-primary-foreground font-bold" : "text-muted-foreground"}`}>
										{l.nativeName}
									</Text>
								</Pressable>
							);
						})}
					</ScrollView>
				) : null}
			</View>

			{/* Results Grid */}
			{isLoading ? (
				<View className="flex-1 items-center justify-center">
					<ActivityIndicator size="large" />
					<Text className="mt-3 text-muted-foreground">Searching...</Text>
				</View>
			) : (
				<FlatList
					data={searchItems}
					renderItem={renderItem}
					keyExtractor={(item, index) => `${item.id}-${index}`}
					numColumns={2}
					columnWrapperStyle={{ justifyContent: "space-between" }}
					contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
					onEndReached={() => {
						if (hasNextPage && !isFetchingNextPage) {
							fetchNextPage();
						}
					}}
					onEndReachedThreshold={0.5}
					ListEmptyComponent={
						<View className="py-16 items-center">
							<Ionicons name="search-outline" size={48} color="#D1D5DB" />
							<Text className="text-foreground font-semibold mt-3">No results found</Text>
							<Text className="text-xs text-muted-foreground mt-1">Try adjusting your search terms or filters</Text>
						</View>
					}
				/>
			)}
		</SafeAreaView>
	);
}
