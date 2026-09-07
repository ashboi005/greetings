import React, { useState } from "react";
import {
	View,
	Text,
	ScrollView,
	Image,
	Pressable,
	Modal,
	Platform,
	Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Button, Surface, TextField, Label, Input, useToast, Spinner } from "heroui-native";
import { downloadContent, reportContent } from "@/lib/services";
import { transformImageUrl } from "@/lib/api";

export default function ContentDetailScreen() {
	const params = useLocalSearchParams<{
		id: string;
		title?: string;
		imageUrl?: string;
		designerName?: string;
		downloadCount?: string;
	}>();
	const router = useRouter();
	const { toast } = useToast();

	const [isDownloading, setIsDownloading] = useState(false);
	const [isSharing, setIsSharing] = useState(false);
	const [reportModalVisible, setReportModalVisible] = useState(false);
	const [reportReason, setReportReason] = useState<"inappropriate" | "copyright" | "spam" | "wrong_info" | "other">("inappropriate");
	const [reportNote, setReportNote] = useState("");
	const [isReporting, setIsReporting] = useState(false);

	const fullImageUrl = transformImageUrl(params.imageUrl, "width=1000,format=auto,quality=90") || params.imageUrl;

	const handleDownload = async () => {
		if (!params.id) return;
		setIsDownloading(true);
		try {
			const res = await downloadContent(params.id, "detail", false);
			if (res.url) {
				if (Platform.OS === "web") {
					window.open(res.url, "_blank");
					toast.show({
						variant: "success",
						label: "Image opened in new tab for download",
					});
				} else {
					try {
						const MediaLibrary = require("expo-media-library");
						const FileSystem = require("expo-file-system/legacy");

						const { status } = await MediaLibrary.requestPermissionsAsync();
						if (status !== "granted") {
							toast.show({
								variant: "danger",
								label: "Permission to access media library is required",
							});
							setIsDownloading(false);
							return;
						}

						const filename = `greetings_${params.id}_${Date.now()}.webp`;
						const fileUri = `${FileSystem.documentDirectory || ""}${filename}`;
						const downloadRes = await FileSystem.downloadAsync(res.url, fileUri);
						await MediaLibrary.saveToLibraryAsync(downloadRes.uri);

						toast.show({
							variant: "success",
							label: "Saved image to Gallery successfully!",
						});
					} catch (nativeErr: any) {
						// Fallback if native module is not linked in Expo Go preview
						await Linking.openURL(res.url);
						toast.show({
							variant: "success",
							label: "Opened download URL in browser",
						});
					}
				}
			}
		} catch (err: any) {
			if (err?.response?.status === 409) {
				toast.show({
					variant: "danger",
					label: "This content is no longer available for download.",
				});
			} else {
				toast.show({
					variant: "danger",
					label: err?.response?.data?.error?.message || "Failed to download image",
				});
			}
		} finally {
			setIsDownloading(false);
		}
	};

	const handleShare = async () => {
		if (!params.id) return;
		setIsSharing(true);
		try {
			const res = await downloadContent(params.id, "detail", false);
			if (res.url) {
				if (Platform.OS === "web") {
					if (navigator.share) {
						await navigator.share({
							title: params.title || "Share Greeting",
							url: res.url,
						});
					} else {
						await window.navigator.clipboard.writeText(res.url);
						toast.show({
							variant: "success",
							label: "Download link copied to clipboard!",
						});
					}
				} else {
					try {
						const Sharing = require("expo-sharing");
						const FileSystem = require("expo-file-system/legacy");

						const isAvailable = await Sharing.isAvailableAsync();
						if (!isAvailable) {
							await Linking.openURL(res.url);
							setIsSharing(false);
							return;
						}

						const filename = `greetings_share_${params.id}.webp`;
						const fileUri = `${FileSystem.cacheDirectory || ""}${filename}`;
						const downloadRes = await FileSystem.downloadAsync(res.url, fileUri);

						await Sharing.shareAsync(downloadRes.uri, {
							mimeType: "image/webp",
							dialogTitle: params.title || "Share Greeting",
						});
					} catch (nativeErr: any) {
						await Linking.openURL(res.url);
					}
				}
			}
		} catch (err: any) {
			toast.show({
				variant: "danger",
				label: err?.response?.data?.error?.message || "Failed to share image",
			});
		} finally {
			setIsSharing(false);
		}
	};

	const submitReport = async () => {
		if (!params.id) return;
		setIsReporting(true);
		try {
			const res = await reportContent(params.id, {
				reason: reportReason,
				note: reportNote.trim() || undefined,
			});
			setReportModalVisible(false);
			if (res.heldForReview) {
				toast.show({
					variant: "success",
					label: "Thank you! This content is now held for review.",
				});
			} else {
				toast.show({
					variant: "success",
					label: "Report submitted successfully.",
				});
			}
		} catch (err: any) {
			if (err?.response?.status === 409) {
				setReportModalVisible(false);
				toast.show({
					variant: "success",
					label: "Thanks, you have already reported this item.",
				});
			} else {
				toast.show({
					variant: "danger",
					label: err?.response?.data?.error?.message || "Failed to submit report",
				});
			}
		} finally {
			setIsReporting(false);
		}
	};

	return (
		<SafeAreaView className="flex-1 bg-background">
			{/* Top Header */}
			<View className="px-4 py-3 flex-row items-center justify-between border-b border-border/30">
				<Pressable onPress={() => router.back()} className="p-1">
					<Ionicons name="arrow-back" size={24} color="#374151" />
				</Pressable>
				<Text className="text-lg font-bold text-foreground flex-1 ml-3" numberOfLines={1}>
					{params.title || "Greeting Detail"}
				</Text>
				<Pressable onPress={() => setReportModalVisible(true)} className="p-2">
					<Ionicons name="flag-outline" size={20} color="#EF4444" />
				</Pressable>
			</View>

			<ScrollView className="flex-1 px-4 py-4">
				<View className="w-full bg-muted rounded-2xl overflow-hidden shadow-sm mb-6 items-center justify-center min-h-[300px]">
					{fullImageUrl ? (
						<Image
							source={{ uri: fullImageUrl }}
							style={{ width: "100%", height: 380 }}
							resizeMode="contain"
						/>
					) : (
						<View className="p-8 items-center">
							<Ionicons name="image-outline" size={64} color="#9CA3AF" />
							<Text className="text-muted-foreground mt-2">Preview unavailable</Text>
						</View>
					)}
				</View>

				<Surface variant="secondary" className="rounded-2xl p-5 mb-6">
					<Text className="text-xl font-bold text-foreground mb-1">{params.title}</Text>
					<Text className="text-sm text-muted-foreground mb-3">
						Designed by {params.designerName || "Community Designer"}
					</Text>

					<View className="flex-row items-center gap-2 py-2 border-t border-border/20">
						<Ionicons name="download-outline" size={16} color="#6B7280" />
						<Text className="text-xs text-muted-foreground">
							{params.downloadCount || "0"} downloads recorded
						</Text>
					</View>
				</Surface>

				{/* Action Buttons */}
				<View className="gap-3 mb-10">
					<Button onPress={handleDownload} isDisabled={isDownloading}>
						{isDownloading ? (
							<Spinner size="sm" color="default" />
						) : (
							<View className="flex-row items-center gap-2">
								<Ionicons name="download-outline" size={20} color="#FFF" />
								<Button.Label>Download Full Image</Button.Label>
							</View>
						)}
					</Button>

					<Button onPress={handleShare} isDisabled={isSharing} variant="secondary">
						{isSharing ? (
							<Spinner size="sm" color="default" />
						) : (
							<View className="flex-row items-center gap-2">
								<Ionicons name="share-social-outline" size={20} color="#374151" />
								<Button.Label>Share Greeting</Button.Label>
							</View>
						)}
					</Button>
				</View>
			</ScrollView>

			{/* Report Modal */}
			<Modal visible={reportModalVisible} transparent animationType="fade">
				<View className="flex-1 bg-black/60 items-center justify-center p-5">
					<Surface variant="secondary" className="w-full rounded-2xl p-6">
						<Text className="text-lg font-bold text-foreground mb-3">Report Content</Text>
						<Text className="text-xs text-muted-foreground mb-4">
							Help us keep the platform safe. Select a reason for reporting:
						</Text>

						{(["inappropriate", "copyright", "spam", "wrong_info", "other"] as const).map((r) => (
							<Pressable
								key={r}
								onPress={() => setReportReason(r)}
								className={`p-3 rounded-xl mb-2 border ${
									reportReason === r ? "bg-primary/10 border-primary" : "bg-background border-border"
								}`}
							>
								<Text className={`capitalize font-medium ${reportReason === r ? "text-primary" : "text-foreground"}`}>
									{r.replace("_", " ")}
								</Text>
							</Pressable>
						))}

						<TextField className="mt-3 mb-4">
							<Label>Optional Notes</Label>
							<Input
								value={reportNote}
								onChangeText={setReportNote}
								placeholder="Describe the issue..."
								multiline
							/>
						</TextField>

						<View className="flex-row gap-3">
							<Button
								onPress={() => setReportModalVisible(false)}
								variant="secondary"
								className="flex-1"
							>
								<Button.Label>Cancel</Button.Label>
							</Button>
							<Button onPress={submitReport} isDisabled={isReporting} className="flex-1">
								{isReporting ? <Spinner size="sm" color="default" /> : <Button.Label>Submit</Button.Label>}
							</Button>
						</View>
					</Surface>
				</View>
			</Modal>
		</SafeAreaView>
	);
}
