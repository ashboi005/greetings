import React, { useState } from "react";
import {
	View,
	Text,
	FlatList,
	Pressable,
	Image,
	ActivityIndicator,
	RefreshControl,
	Modal,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getDesigns, createDesign } from "@/lib/services";
import type { DesignSummary } from "@/lib/types";
import { Ionicons } from "@expo/vector-icons";
import { Button, Surface, TextField, Label, Input, useToast, Spinner } from "heroui-native";
import { useRouter } from "expo-router";

export default function MyDesignsScreen() {
	const router = useRouter();
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
		onSuccess: (newDesign) => {
			setCreateModalVisible(false);
			setNewTitle("");
			queryClient.invalidateQueries({ queryKey: ["myDesigns"] });
			toast.show({
				variant: "success",
				label: "Design created successfully!",
			});
		},
		onError: (err: any) => {
			toast.show({
				variant: "danger",
				label: err?.response?.data?.error?.message || "Failed to create design",
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
				<Surface variant="secondary" className="rounded-2xl p-4 flex-row items-center gap-4">
					<View className="w-16 h-16 rounded-xl bg-muted overflow-hidden items-center justify-center">
						{item.previewUrl ? (
							<Image source={{ uri: item.previewUrl }} style={{ width: "100%", height: "100%" }} />
						) : (
							<Ionicons name="create-outline" size={28} color="#6366F1" />
						)}
					</View>

					<View className="flex-1">
						<Text className="font-semibold text-foreground text-base">{item.title}</Text>
						<Text className="text-xs text-muted-foreground mt-1">
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
			<View className="px-4 py-3 border-b border-border/30 flex-row items-center justify-between">
				<View>
					<Text className="text-xl font-bold text-foreground">My Designs Studio</Text>
					<Text className="text-xs text-muted-foreground">Your private studio graphics</Text>
				</View>

				<Pressable
					onPress={() => setCreateModalVisible(true)}
					className="bg-primary p-2.5 rounded-full flex-row items-center gap-1"
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
					refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} />}
					onEndReached={() => {
						if (hasNextPage && !isFetchingNextPage) {
							fetchNextPage();
						}
					}}
					onEndReachedThreshold={0.5}
					ListEmptyComponent={
						<View className="py-20 items-center">
							<Ionicons name="create-outline" size={48} color="#D1D5DB" />
							<Text className="text-foreground font-semibold mt-3">No saved designs</Text>
							<Text className="text-xs text-muted-foreground mt-1 text-center px-6">
								Create your first design project to customize graphics
							</Text>
							<Button onPress={() => setCreateModalVisible(true)} className="mt-4">
								<Button.Label>+ Create New Design</Button.Label>
							</Button>
						</View>
					}
				/>
			)}

			{/* Create Design Modal */}
			<Modal visible={createModalVisible} transparent animationType="fade">
				<View className="flex-1 bg-black/60 items-center justify-center p-5">
					<Surface variant="secondary" className="w-full rounded-2xl p-6">
						<Text className="text-lg font-bold text-foreground mb-4">Create New Design</Text>

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
