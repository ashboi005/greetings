import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
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
	Image,
	Linking,
	Modal,
	Platform,
	Pressable,
	ScrollView,
	Text,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { apiErrorCode, apiErrorMessage, transformImageUrl } from "@/lib/api";
import { downloadContent, reportContent } from "@/lib/services";

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
	const [reportReason, setReportReason] = useState<
		"inappropriate" | "copyright" | "spam" | "wrong_info" | "other"
	>("inappropriate");
	const [reportNote, setReportNote] = useState("");
	const [isReporting, setIsReporting] = useState(false);

	const fullImageUrl =
		transformImageUrl(params.imageUrl, "width=1000,format=auto,quality=90") ||
		params.imageUrl;

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
						const downloadRes = await FileSystem.downloadAsync(
							res.url,
							fileUri,
						);
						await MediaLibrary.saveToLibraryAsync(downloadRes.uri);

						toast.show({
							variant: "success",
							label: "Saved image to Gallery successfully!",
						});
					} catch {
						// The media library module may be missing in a preview build.
						await Linking.openURL(res.url);
						toast.show({
							variant: "success",
							label: "Opened download URL in browser",
						});
					}
				}
			}
		} catch (cause) {
			if (apiErrorCode(cause) === "CONFLICT") {
				toast.show({
					variant: "danger",
					label: "This content is no longer available for download.",
				});
			} else {
				toast.show({
					variant: "danger",
					label: apiErrorMessage(cause, "Failed to download image"),
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
						const downloadRes = await FileSystem.downloadAsync(
							res.url,
							fileUri,
						);

						await Sharing.shareAsync(downloadRes.uri, {
							mimeType: "image/webp",
							dialogTitle: params.title || "Share Greeting",
						});
					} catch {
						await Linking.openURL(res.url);
					}
				}
			}
		} catch (cause) {
			toast.show({
				variant: "danger",
				label: apiErrorMessage(cause, "Failed to share image"),
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
		} catch (cause) {
			// A duplicate report is not a failure the reporter needs to see —
			// their first one is already open. §7 of the mobile guide.
			if (apiErrorCode(cause) === "CONFLICT") {
				setReportModalVisible(false);
				toast.show({
					variant: "success",
					label: "Thanks, you have already reported this item.",
				});
			} else {
				toast.show({
					variant: "danger",
					label: apiErrorMessage(cause, "Failed to submit report"),
				});
			}
		} finally {
			setIsReporting(false);
		}
	};

	return (
		<SafeAreaView className="flex-1 bg-background">
			{/* Top Header */}
			<View className="flex-row items-center justify-between border-border/30 border-b px-4 py-3">
				<Pressable onPress={() => router.back()} className="p-1">
					<Ionicons name="arrow-back" size={24} color="#374151" />
				</Pressable>
				<Text
					className="ml-3 flex-1 font-bold text-foreground text-lg"
					numberOfLines={1}
				>
					{params.title || "Greeting Detail"}
				</Text>
				<Pressable onPress={() => setReportModalVisible(true)} className="p-2">
					<Ionicons name="flag-outline" size={20} color="#EF4444" />
				</Pressable>
			</View>

			<ScrollView className="flex-1 px-4 py-4">
				<View className="mb-6 min-h-[300px] w-full items-center justify-center overflow-hidden rounded-2xl bg-muted shadow-sm">
					{fullImageUrl ? (
						<Image
							source={{ uri: fullImageUrl }}
							style={{ width: "100%", height: 380 }}
							resizeMode="contain"
						/>
					) : (
						<View className="items-center p-8">
							<Ionicons name="image-outline" size={64} color="#9CA3AF" />
							<Text className="mt-2 text-muted-foreground">
								Preview unavailable
							</Text>
						</View>
					)}
				</View>

				<Surface variant="secondary" className="mb-6 rounded-2xl p-5">
					<Text className="mb-1 font-bold text-foreground text-xl">
						{params.title}
					</Text>
					<Text className="mb-3 text-muted-foreground text-sm">
						Designed by {params.designerName || "Community Designer"}
					</Text>

					<View className="flex-row items-center gap-2 border-border/20 border-t py-2">
						<Ionicons name="download-outline" size={16} color="#6B7280" />
						<Text className="text-muted-foreground text-xs">
							{params.downloadCount || "0"} downloads recorded
						</Text>
					</View>
				</Surface>

				{/* Action Buttons */}
				<View className="mb-10 gap-3">
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

					<Button
						onPress={handleShare}
						isDisabled={isSharing}
						variant="secondary"
					>
						{isSharing ? (
							<Spinner size="sm" color="default" />
						) : (
							<View className="flex-row items-center gap-2">
								<Ionicons
									name="share-social-outline"
									size={20}
									color="#374151"
								/>
								<Button.Label>Share Greeting</Button.Label>
							</View>
						)}
					</Button>
				</View>
			</ScrollView>

			{/* Report Modal */}
			<Modal visible={reportModalVisible} transparent animationType="fade">
				<View className="flex-1 items-center justify-center bg-black/60 p-5">
					<Surface variant="secondary" className="w-full rounded-2xl p-6">
						<Text className="mb-3 font-bold text-foreground text-lg">
							Report Content
						</Text>
						<Text className="mb-4 text-muted-foreground text-xs">
							Help us keep the platform safe. Select a reason for reporting:
						</Text>

						{(
							[
								"inappropriate",
								"copyright",
								"spam",
								"wrong_info",
								"other",
							] as const
						).map((r) => (
							<Pressable
								key={r}
								onPress={() => setReportReason(r)}
								className={`mb-2 rounded-xl border p-3 ${
									reportReason === r
										? "border-primary bg-primary/10"
										: "border-border bg-background"
								}`}
							>
								<Text
									className={`font-medium capitalize ${reportReason === r ? "text-primary" : "text-foreground"}`}
								>
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
							<Button
								onPress={submitReport}
								isDisabled={isReporting}
								className="flex-1"
							>
								{isReporting ? (
									<Spinner size="sm" color="default" />
								) : (
									<Button.Label>Submit</Button.Label>
								)}
							</Button>
						</View>
					</Surface>
				</View>
			</Modal>
		</SafeAreaView>
	);
}
