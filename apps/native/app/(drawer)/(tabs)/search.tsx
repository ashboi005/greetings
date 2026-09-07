import { Ionicons } from "@expo/vector-icons";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Input, Surface } from "heroui-native";
import { useState } from "react";
import {
	ActivityIndicator,
	Dimensions,
	FlatList,
	Image,
	Pressable,
	ScrollView,
	Text,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { getThumbnailUrl } from "@/lib/api";
import {
	getLanguages,
	getRegions,
	getTags,
	searchContent,
} from "@/lib/services";
import type { FeedItem } from "@/lib/types";

const { width } = Dimensions.get("window");
const COLUMN_WIDTH = (width - 36) / 2;

export default function SearchScreen() {
	const router = useRouter();
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedTag, setSelectedTag] = useState<string | null>(null);
	const [selectedLang, setSelectedLang] = useState<string | null>(null);
	const [selectedRegion, _setSelectedRegion] = useState<string | null>(null);

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
		queryKey: [
			"search",
			searchQuery,
			selectedTag,
			selectedLang,
			selectedRegion,
		],
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
				<Surface
					variant="secondary"
					className="overflow-hidden rounded-2xl border border-border/40 shadow-sm"
				>
					<View
						style={{ width: COLUMN_WIDTH, height: COLUMN_WIDTH * 1.2 }}
						className="bg-muted"
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
						<Text
							className="mt-1 text-muted-foreground text-xs"
							numberOfLines={1}
						>
							{item.designer?.name || "Designer"}
						</Text>
					</View>
				</Surface>
			</Pressable>
		);
	};

	return (
		<SafeAreaView className="flex-1 bg-background" edges={["top"]}>
			<View className="border-border/30 border-b px-4 py-3">
				<Text className="mb-3 font-bold text-foreground text-xl">
					Search & Browse
				</Text>

				<View className="flex-row items-center rounded-xl bg-muted/60 px-3 py-1">
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
			<View className="border-border/20 border-b py-2">
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					className="flex-row gap-2 px-4"
				>
					{tags?.map((t) => {
						const isSelected = selectedTag === t.id;
						return (
							<Pressable
								key={t.id}
								onPress={() => setSelectedTag(isSelected ? null : t.id)}
								className={`mr-1 rounded-full border px-3 py-1.5 ${
									isSelected
										? "border-primary bg-primary"
										: "border-border/50 bg-muted/40"
								}`}
							>
								<Text
									className={`text-xs ${isSelected ? "font-bold text-primary-foreground" : "text-foreground"}`}
								>
									#{t.label}
								</Text>
							</Pressable>
						);
					})}
				</ScrollView>

				{languages && languages.length > 0 ? (
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						className="mt-2 flex-row gap-2 px-4"
					>
						{languages.map((l) => {
							const isSelected = selectedLang === l.code;
							return (
								<Pressable
									key={l.code}
									onPress={() => setSelectedLang(isSelected ? null : l.code)}
									className={`mr-1 rounded-full border px-3 py-1 ${
										isSelected
											? "border-primary bg-primary/80"
											: "border-border/40 bg-background"
									}`}
								>
									<Text
										className={`text-xs ${isSelected ? "font-bold text-primary-foreground" : "text-muted-foreground"}`}
									>
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
						<View className="items-center py-16">
							<Ionicons name="search-outline" size={48} color="#D1D5DB" />
							<Text className="mt-3 font-semibold text-foreground">
								No results found
							</Text>
							<Text className="mt-1 text-muted-foreground text-xs">
								Try adjusting your search terms or filters
							</Text>
						</View>
					}
				/>
			)}
		</SafeAreaView>
	);
}
