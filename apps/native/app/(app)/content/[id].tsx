import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
	cn,
	FieldError,
	Input,
	Label,
	Spinner,
	TextArea,
	TextField,
	useThemeColor,
	useToast,
} from "heroui-native";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { ActionButton } from "@/components/ui/action-button";
import {
	type GreetingSource,
	greetingThumbnail,
	TILE_ASPECT_RATIO,
} from "@/components/ui/greeting-grid";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { SheetModal } from "@/components/ui/sheet-modal";
import { EmptyState } from "@/components/ui/state-views";
import { useAuth } from "@/contexts/auth-context";
import { maybeShowInterstitial } from "@/lib/ads/interstitial";
import { track } from "@/lib/analytics";
import { apiErrorCode, transformImageUrl } from "@/lib/api";
import { friendlyError, isGone } from "@/lib/errors";
import { type StringKey, useI18n } from "@/lib/i18n";
import { saveOrShareGreeting } from "@/lib/media";
import {
	type DownloadSource,
	reportContent,
	updateProfile,
} from "@/lib/services";
import type { ReportPayload } from "@/lib/types";

/**
 * One greeting, large, with the three things you can do with it.
 *
 * There is no endpoint that returns a single content item, so everything shown
 * here arrives as route params from the list that opened it (see
 * `useOpenGreeting`). That is also why there is nothing to load: the preview
 * starts from the thumbnail the list already cached and sharpens in place.
 */

/** Wide enough for a sharp preview on any phone, small enough for 3G (§8). */
const PREVIEW_TRANSFORM = "width=1080,format=auto,quality=85,fit=scale-down";

/** Very tall or very wide artwork is letterboxed rather than laid out to size. */
const MIN_ASPECT = 9 / 16;
const MAX_ASPECT = 16 / 9;

const SOURCES: GreetingSource[] = ["feed", "search", "detail", "history"];

type Busy = "save" | "share" | "customize" | null;

export default function ContentDetailScreen() {
	const params = useLocalSearchParams<{
		id: string;
		title?: string;
		imageUrl?: string;
		designerName?: string;
		downloadCount?: string;
		source?: string;
	}>();
	const router = useRouter();
	const queryClient = useQueryClient();
	const { toast } = useToast();
	const { t, language } = useI18n();
	const { userProfile } = useAuth();
	const muted = useThemeColor("muted");

	const id = params.id;
	const title = params.title ?? "";
	const imageUrl = params.imageUrl || null;
	const source: GreetingSource = SOURCES.includes(
		params.source as GreetingSource,
	)
		? (params.source as GreetingSource)
		: "detail";
	// The download endpoint knows only feed/search/detail. "Where was it found"
	// is the signal designers get, so a feed or search find keeps its origin and
	// anything else — history included — counts as the detail screen.
	const downloadSource: DownloadSource =
		source === "feed" || source === "search" ? source : "detail";

	const [busy, setBusy] = useState<Busy>(null);
	const [aspect, setAspect] = useState(TILE_ASPECT_RATIO);
	const [reportOpen, setReportOpen] = useState(false);
	const [namePromptOpen, setNamePromptOpen] = useState(false);

	useEffect(() => {
		track("content_opened", { source });
	}, [source]);

	if (!id) {
		return (
			<SafeAreaView className="flex-1 justify-center bg-background">
				<EmptyState
					icon="image-outline"
					title={t("common.noLongerAvailable")}
					action={
						<ActionButton
							label={t("common.back")}
							icon="arrow-back"
							variant="secondary"
							onPress={() => router.back()}
						/>
					}
				/>
			</SafeAreaView>
		);
	}

	const failed = (cause: unknown) => {
		toast.show({ variant: "danger", label: friendlyError(cause, t, language) });
		// Held or removed while they were looking at it (§7): say so and leave.
		if (isGone(cause)) router.back();
	};

	const saveOrShare = async (action: "save" | "share") => {
		if (busy) return;
		setBusy(action);
		try {
			await maybeShowInterstitial(action);
			await saveOrShareGreeting(id, action, {
				source: downloadSource,
				title,
			});
			track(action === "save" ? "image_saved" : "image_shared", {
				customized: false,
				source,
			});
			if (action === "save") {
				toast.show({ variant: "success", label: t("content.savedToast") });
			}
			void queryClient.invalidateQueries({ queryKey: ["downloads"] });
		} catch (cause) {
			failed(cause);
		} finally {
			setBusy(null);
		}
	};

	const openCustomize = async () => {
		setBusy("customize");
		await maybeShowInterstitial("customize");
		track("customize_opened", { source });
		setBusy(null);
		const customizeParams: Record<string, string> = { id, title, source };
		if (imageUrl) customizeParams.imageUrl = imageUrl;
		router.push({ pathname: "/(app)/customize/[id]", params: customizeParams });
	};

	const handleCustomize = () => {
		if (busy) return;
		// The name is the one mandatory line of the overlay (§9). Without it the
		// editor would draw a blank, so ask for it first.
		if (!userProfile?.displayName) {
			setNamePromptOpen(true);
			return;
		}
		void openCustomize();
	};

	const previewUrl = transformImageUrl(imageUrl, PREVIEW_TRANSFORM);
	const thumbnail = greetingThumbnail(imageUrl);
	const downloadCount = Number(params.downloadCount);

	return (
		<SafeAreaView edges={["top", "bottom"]} className="flex-1 bg-background">
			<View className="flex-row items-center justify-between px-2">
				<HeaderButton
					icon="chevron-back"
					label={t("common.back")}
					onPress={() => router.back()}
				/>
				<HeaderButton
					icon="flag-outline"
					label={t("content.report")}
					onPress={() => setReportOpen(true)}
				/>
			</View>

			<ScrollView contentContainerClassName="px-4 pb-6">
				<View
					className="w-full items-center justify-center overflow-hidden rounded-2xl bg-surface-secondary"
					style={{ aspectRatio: aspect }}
				>
					{previewUrl ? (
						<Image
							source={{ uri: previewUrl }}
							placeholder={thumbnail ? { uri: thumbnail } : undefined}
							placeholderContentFit="contain"
							contentFit="contain"
							cachePolicy="memory-disk"
							recyclingKey={id}
							transition={200}
							style={{ width: "100%", height: "100%" }}
							accessibilityLabel={title}
							onLoad={({ source: loaded }) => {
								if (loaded.width > 0 && loaded.height > 0) {
									const ratio = loaded.width / loaded.height;
									setAspect(Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, ratio)));
								}
							}}
						/>
					) : (
						<Ionicons name="image-outline" size={48} color={muted} />
					)}
				</View>

				<Text
					className="mt-5 font-heading text-2xl text-foreground"
					accessibilityRole="header"
				>
					{title}
				</Text>
				<View className="mt-1 flex-row flex-wrap items-center gap-x-4 gap-y-1">
					{params.designerName ? (
						<Text className="text-base text-muted">
							{t("common.by", { name: params.designerName })}
						</Text>
					) : null}
					{Number.isFinite(downloadCount) ? (
						<View className="flex-row items-center gap-1">
							<Ionicons
								name="arrow-down-circle-outline"
								size={18}
								color={muted}
							/>
							<Text className="text-base text-muted">
								{t("common.downloads", { count: downloadCount })}
							</Text>
						</View>
					) : null}
				</View>
			</ScrollView>

			<View className="gap-3 border-border border-t px-4 pt-3 pb-2">
				<ActionButton
					label={t("content.customize")}
					icon="sparkles"
					onPress={handleCustomize}
					isLoading={busy === "customize"}
					isDisabled={busy !== null}
				/>
				<View className="flex-row gap-3">
					<TileAction
						icon="logo-whatsapp"
						label={t("content.share")}
						onPress={() => void saveOrShare("share")}
						isLoading={busy === "share"}
						isDisabled={busy !== null}
					/>
					<TileAction
						icon="download-outline"
						label={t("content.save")}
						onPress={() => void saveOrShare("save")}
						isLoading={busy === "save"}
						isDisabled={busy !== null}
					/>
				</View>
			</View>

			<ReportSheet
				visible={reportOpen}
				contentId={id}
				onClose={() => setReportOpen(false)}
				onHeld={() => router.back()}
			/>
			<NamePrompt
				visible={namePromptOpen}
				onClose={() => setNamePromptOpen(false)}
				onSaved={() => {
					setNamePromptOpen(false);
					void openCustomize();
				}}
				onShareInstead={() => {
					setNamePromptOpen(false);
					void saveOrShare("share");
				}}
			/>
		</SafeAreaView>
	);
}

/** A labelled text button for the top bar; nav chrome, so no fill. */
function HeaderButton({
	icon,
	label,
	onPress,
}: {
	icon: keyof typeof Ionicons.glyphMap;
	label: string;
	onPress: () => void;
}) {
	const foreground = useThemeColor("foreground");
	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			hitSlop={4}
			className="min-h-12 flex-row items-center gap-1 rounded-full px-3"
		>
			<Ionicons name={icon} size={22} color={foreground} />
			<Text className="text-base text-foreground">{label}</Text>
		</Pressable>
	);
}

/**
 * Half-width action with the icon above its label, so a long Hindi label can
 * wrap onto a second line instead of being cut off on a 360dp phone.
 */
function TileAction({
	icon,
	label,
	onPress,
	isLoading,
	isDisabled,
}: {
	icon: keyof typeof Ionicons.glyphMap;
	label: string;
	onPress: () => void;
	isLoading: boolean;
	isDisabled: boolean;
}) {
	const tint = useThemeColor("accent-soft-foreground");
	return (
		<Pressable
			onPress={onPress}
			disabled={isDisabled}
			accessibilityRole="button"
			accessibilityLabel={label}
			accessibilityState={{ disabled: isDisabled, busy: isLoading }}
			className={cn(
				"min-h-18 flex-1 items-center justify-center gap-1 rounded-2xl bg-accent-soft px-2 py-3",
				isDisabled && !isLoading && "opacity-60",
			)}
		>
			{isLoading ? (
				<Spinner color={tint} />
			) : (
				<Ionicons name={icon} size={26} color={tint} />
			)}
			<Text className="text-center font-semibold text-accent-soft-foreground text-base">
				{label}
			</Text>
		</Pressable>
	);
}

const REPORT_REASONS: {
	value: ReportPayload["reason"];
	label: StringKey;
}[] = [
	{ value: "inappropriate", label: "content.reasonInappropriate" },
	{ value: "copyright", label: "content.reasonCopyright" },
	{ value: "spam", label: "content.reasonSpam" },
	{ value: "wrong_info", label: "content.reasonWrongInfo" },
	{ value: "other", label: "content.reasonOther" },
];

/**
 * Report a greeting.
 *
 * A repeat report is a 409, and the guide is clear it is not a failure — the
 * person has already done the thing — so it reads as thanks (§7). A report
 * that tips the greeting into review hides it, so the screen closes after.
 */
function ReportSheet({
	visible,
	contentId,
	onClose,
	onHeld,
}: {
	visible: boolean;
	contentId: string;
	onClose: () => void;
	onHeld: () => void;
}) {
	const { t, language } = useI18n();
	const { toast } = useToast();
	const [accentSoftForeground, muted] = useThemeColor([
		"accent-soft-foreground",
		"muted",
	]);
	const [reason, setReason] = useState<ReportPayload["reason"] | null>(null);
	const [note, setNote] = useState("");
	const [isSending, setIsSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const close = () => {
		setReason(null);
		setNote("");
		setError(null);
		onClose();
	};

	const submit = async () => {
		if (!reason) {
			setError(t("content.reportPickReason"));
			return;
		}
		setError(null);
		setIsSending(true);
		try {
			const result = await reportContent(contentId, {
				reason,
				note: note.trim() || undefined,
			});
			track("content_reported", { reason });
			close();
			if (result.heldForReview) {
				toast.show({ variant: "success", label: t("content.reportHeld") });
				onHeld();
			} else {
				toast.show({ variant: "success", label: t("content.reportThanks") });
			}
		} catch (cause) {
			if (apiErrorCode(cause) === "CONFLICT") {
				close();
				toast.show({ variant: "success", label: t("content.reportAlready") });
			} else {
				setError(friendlyError(cause, t, language));
			}
		} finally {
			setIsSending(false);
		}
	};

	return (
		<SheetModal
			visible={visible}
			title={t("content.reportTitle")}
			onClose={close}
		>
			<Text className="mb-4 text-base text-muted">
				{t("content.reportBody")}
			</Text>
			<View className="gap-2" accessibilityRole="radiogroup">
				{REPORT_REASONS.map((option) => {
					const isSelected = reason === option.value;
					return (
						<Pressable
							key={option.value}
							onPress={() => {
								setReason(option.value);
								setError(null);
							}}
							accessibilityRole="radio"
							accessibilityState={{ selected: isSelected }}
							className={cn(
								"min-h-14 flex-row items-center gap-3 rounded-2xl border px-4",
								isSelected
									? "border-accent bg-accent-soft"
									: "border-border bg-surface",
							)}
						>
							<Ionicons
								name={isSelected ? "radio-button-on" : "radio-button-off"}
								size={22}
								color={isSelected ? accentSoftForeground : muted}
							/>
							<Text className="flex-1 text-base text-foreground">
								{t(option.label)}
							</Text>
						</Pressable>
					);
				})}
			</View>

			<TextField className="mt-5">
				<Label>{t("content.reportNoteLabel")}</Label>
				<TextArea
					value={note}
					onChangeText={setNote}
					placeholder={t("content.reportNotePlaceholder")}
					maxLength={1000}
					className="text-base"
				/>
			</TextField>

			<FieldError isInvalid={Boolean(error)} className="mt-3">
				{error}
			</FieldError>

			<ActionButton
				label={t("content.reportSend")}
				icon="send"
				onPress={() => void submit()}
				isLoading={isSending}
				className="mt-5"
			/>
		</SheetModal>
	);
}

/**
 * Asks for the person's name before Customize & Share, since the overlay cannot
 * be drawn without one (§9). Saving goes through the same full-profile PUT as
 * Profile — every field resent, because omitting one would wipe it (§3).
 * "Just share" is the guide's other allowed answer: a plain, clean share.
 */
function NamePrompt({
	visible,
	onClose,
	onSaved,
	onShareInstead,
}: {
	visible: boolean;
	onClose: () => void;
	onSaved: () => void;
	onShareInstead: () => void;
}) {
	const { t, language } = useI18n();
	const router = useRouter();
	const { userProfile, refreshProfile } = useAuth();
	const [name, setName] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const save = async () => {
		const displayName = name.trim();
		if (!displayName) {
			setError(t("content.nameRequired"));
			return;
		}
		// Region and languages are required by the PUT. An onboarded profile
		// always has them; if this one somehow does not, Profile can fix it.
		if (!userProfile?.regionCode || userProfile.languages.length === 0) {
			onClose();
			router.navigate("/(app)/(tabs)/profile");
			return;
		}
		setError(null);
		setIsSaving(true);
		try {
			await updateProfile({
				regionCode: userProfile.regionCode,
				languages: userProfile.languages,
				displayName,
				designation: userProfile.designation ?? undefined,
				contactPhone: userProfile.contactPhone ?? undefined,
			});
			track("profile_updated", {
				has_designation: Boolean(userProfile.designation),
				has_phone: Boolean(userProfile.contactPhone),
			});
			await refreshProfile();
			setName("");
			onSaved();
		} catch (cause) {
			setError(friendlyError(cause, t, language));
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<SheetModal
			visible={visible}
			title={t("content.nameTitle")}
			onClose={onClose}
		>
			<Text className="mb-4 text-base text-muted">{t("content.nameBody")}</Text>
			<TextField isInvalid={Boolean(error)}>
				<Label>{t("common.fieldName")}</Label>
				<Input
					value={name}
					onChangeText={(next) => {
						setName(next);
						setError(null);
					}}
					placeholder={t("common.fieldNamePlaceholder")}
					maxLength={80}
					autoCapitalize="words"
					autoComplete="name"
					textContentType="name"
					returnKeyType="done"
					onSubmitEditing={() => void save()}
					className="text-base"
				/>
				<FieldError>{error}</FieldError>
			</TextField>
			<View className="mt-5 gap-3">
				<ActionButton
					label={t("content.nameSave")}
					icon="checkmark"
					onPress={() => void save()}
					isLoading={isSaving}
				/>
				<ActionButton
					label={t("content.nameSkip")}
					icon="logo-whatsapp"
					variant="tertiary"
					onPress={onShareInstead}
					isDisabled={isSaving}
				/>
			</View>
		</SheetModal>
	);
}
