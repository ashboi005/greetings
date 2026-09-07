import { Ionicons } from "@expo/vector-icons";
import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "expo-router";
import {
	Button,
	Input,
	Label,
	Spinner,
	Surface,
	TextField,
	useToast,
} from "heroui-native";
import { useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	Image,
	Modal,
	Pressable,
	RefreshControl,
	Text,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { apiErrorMessage } from "@/lib/api";
import { createDesign, getDesigns } from "@/lib/services";
import type { DesignSummary } from "@/lib/types";

export default function MyDesignsScreen() {
	const _router = useRouter();
	const queryClient = useQueryClient();
	const { toast } = useToast();

	const [createModalVisible, setCreateModalVisible] = useState(false);
	const [newTitle, setNewTitle] = useState("");

	const {
		data,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isLoading,
		refetch,
		isRefetching,
	} = useInfiniteQuery({
		queryKey: ["myDesigns"],
		queryFn: ({ pageParam = null }) => getDesigns(pageParam, 20),
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		initialPageParam: null as string | null,
	});

	const createMutation = useMutation({
		mutationFn: (title: string) =>
			createDesign({
				title,
				designJson: {
					version: 1,
					background: "#FFFFFF",
					elements: [],
				},
			}),
		onSuccess: (_newDesign) => {
			setCreateModalVisible(false);
			setNewTitle("");
			queryClient.invalidateQueries({ queryKey: ["myDesigns"] });
			toast.show({
				variant: "success",
				label: "Design created successfully!",
			});
		},
		onError: (cause: unknown) => {
			toast.show({
				variant: "danger",
				label: apiErrorMessage(cause, "Failed to create design"),
			});
		},
	});

	const designs = data?.pages.flatMap((page) => page.items) || [];

	const renderItem = ({ item }: { item: DesignSummary }) => {
		return (
			<Pressable
				onPress={() => {
					toast.show({
						variant: "default",
						label: `Opened "${item.title}" studio`,
					});
				}}
				className="mb-4 w-full"
			>
				<Surface
					variant="secondary"
					className="flex-row items-center gap-4 rounded-2xl p-4"
				>
					<View className="h-16 w-16 items-center justify-center overflow-hidden rounded-xl bg-muted">
						{item.previewUrl ? (
							<Image
								source={{ uri: item.previewUrl }}
								style={{ width: "100%", height: "100%" }}
							/>
						) : (
							<Ionicons name="create-outline" size={28} color="#6366F1" />
						)}
					</View>

					<View className="flex-1">
						<Text className="font-semibold text-base text-foreground">
							{item.title}
						</Text>
						<Text className="mt-1 text-muted-foreground text-xs">
							Last updated: {new Date(item.updatedAt).toLocaleDateString()}
						</Text>
					</View>

					<Ionicons name="create" size={18} color="#6366F1" />
				</Surface>
			</Pressable>
		);
	};

	return (
		<SafeAreaView className="flex-1 bg-background" edges={["top"]}>
			<View className="flex-row items-center justify-between border-border/30 border-b px-4 py-3">
				<View>
					<Text className="font-bold text-foreground text-xl">
						My Designs Studio
					</Text>
					<Text className="text-muted-foreground text-xs">
						Your private studio graphics
					</Text>
				</View>

				<Pressable
					onPress={() => setCreateModalVisible(true)}
					className="flex-row items-center gap-1 rounded-full bg-primary p-2.5"
				>
					<Ionicons name="add" size={20} color="#FFF" />
				</Pressable>
			</View>

			{isLoading ? (
				<View className="flex-1 items-center justify-center">
					<ActivityIndicator size="large" />
				</View>
			) : (
				<FlatList
					data={designs}
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
							<Ionicons name="create-outline" size={48} color="#D1D5DB" />
							<Text className="mt-3 font-semibold text-foreground">
								No saved designs
							</Text>
							<Text className="mt-1 px-6 text-center text-muted-foreground text-xs">
								Create your first design project to customize graphics
							</Text>
							<Button
								onPress={() => setCreateModalVisible(true)}
								className="mt-4"
							>
								<Button.Label>+ Create New Design</Button.Label>
							</Button>
						</View>
					}
				/>
			)}

			{/* Create Design Modal */}
			<Modal visible={createModalVisible} transparent animationType="fade">
				<View className="flex-1 items-center justify-center bg-black/60 p-5">
					<Surface variant="secondary" className="w-full rounded-2xl p-6">
						<Text className="mb-4 font-bold text-foreground text-lg">
							Create New Design
						</Text>

						<TextField className="mb-6">
							<Label>Design Title</Label>
							<Input
								value={newTitle}
								onChangeText={setNewTitle}
								placeholder="e.g. Festival Banner Poster"
							/>
						</TextField>

						<View className="flex-row gap-3">
							<Button
								onPress={() => setCreateModalVisible(false)}
								variant="secondary"
								className="flex-1"
							>
								<Button.Label>Cancel</Button.Label>
							</Button>
							<Button
								onPress={() => {
									if (newTitle.trim()) {
										createMutation.mutate(newTitle.trim());
									}
								}}
								isDisabled={createMutation.isPending || !newTitle.trim()}
								className="flex-1"
							>
								{createMutation.isPending ? (
									<Spinner size="sm" color="default" />
								) : (
									<Button.Label>Create</Button.Label>
								)}
							</Button>
						</View>
					</Surface>
				</View>
			</Modal>
		</SafeAreaView>
	);
}
