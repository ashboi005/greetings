import { Ionicons } from "@expo/vector-icons";
import { env } from "@greetings/env/native";
import { useQuery } from "@tanstack/react-query";
import Constants from "expo-constants";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import * as WebBrowser from "expo-web-browser";
import { FieldError, Spinner, useThemeColor, useToast } from "heroui-native";
import { type ReactNode, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { ActionButton } from "@/components/ui/action-button";
import { Chip } from "@/components/ui/chip";
import {
	cleanDetails,
	DetailsFields,
	type DetailsValues,
} from "@/components/ui/details-fields";
import { LanguageSelect } from "@/components/ui/language-select";
import { useLanguages, useRegions } from "@/components/ui/reference-data";
import { RegionPickerModal } from "@/components/ui/region-list";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { ScreenHeader } from "@/components/ui/screen-header";
import { ErrorState } from "@/components/ui/state-views";
import {
	type ThemePreference,
	useAppTheme,
} from "@/contexts/app-theme-context";
import { useAuth } from "@/contexts/auth-context";
import { showPrivacyOptions, useAdsState } from "@/lib/ads/consent";
import { track } from "@/lib/analytics";
import { apiErrorCode, getThumbnailUrl } from "@/lib/api";
import { friendlyError } from "@/lib/errors";
import { type AppLanguage, type StringKey, useI18n } from "@/lib/i18n";
import {
	deleteAvatar,
	getMe,
	type UploadMimeType,
	updateProfile,
	uploadAvatar,
} from "@/lib/services";
import type { UserProfile } from "@/lib/types";

/** The server's logo limit (§3); checked here so nobody waits on a doomed upload. */
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

/** How phone-only accounts' emails look. Real values, never to be shown (§2). */
const PLACEHOLDER_EMAIL_DOMAIN = "@firebase.placeholder";

const THEMES: {
	value: ThemePreference;
	label: StringKey;
	icon: keyof typeof Ionicons.glyphMap;
}[] = [
	{
		value: "system",
		label: "profile.themeSystem",
		icon: "phone-portrait-outline",
	},
	{ value: "light", label: "profile.themeLight", icon: "sunny-outline" },
	{ value: "dark", label: "profile.themeDark", icon: "moon-outline" },
];

/**
 * Profile: the person's details, logo, feed preferences and app settings.
 *
 * Waits for the profile read rather than rendering an empty form. The form
 * submits through a PUT that *replaces* the profile (§3), so a form that had
 * started blank and was saved would wipe whatever the server held.
 */
export default function ProfileScreen() {
	const { userProfile, refreshProfile } = useAuth();
	const { t } = useI18n();
	const accent = useThemeColor("accent");
	const [isRetrying, setIsRetrying] = useState(false);

	if (!userProfile) {
		return (
			<SafeAreaView
				edges={["top"]}
				className="flex-1 justify-center bg-background"
			>
				{isRetrying ? (
					<Spinner color={accent} className="self-center" />
				) : (
					<ErrorState
						message={t("common.offline")}
						onRetry={async () => {
							setIsRetrying(true);
							await refreshProfile();
							setIsRetrying(false);
						}}
					/>
				)}
			</SafeAreaView>
		);
	}

	// Keyed on the saved, PUT-able fields so the form re-seeds whenever they
	// change elsewhere — the name prompt on the detail screen saves a name while
	// this tab stays mounted. A stale form here would show that name as blank,
	// and saving it would clear it, since the PUT replaces the whole profile.
	// A logo change does not touch these, so half-typed edits survive it.
	const formKey = [
		userProfile.displayName,
		userProfile.designation,
		userProfile.contactPhone,
		userProfile.regionCode,
		userProfile.languages.join(","),
	].join("|");

	return <ProfileContent key={formKey} profile={userProfile} />;
}

function detailsOf(profile: UserProfile): DetailsValues {
	return {
		displayName: profile.displayName ?? "",
		designation: profile.designation ?? "",
		contactPhone: profile.contactPhone ?? "",
	};
}

function sameSet(a: string[], b: string[]) {
	return a.length === b.length && a.every((code) => b.includes(code));
}

function ProfileContent({ profile }: { profile: UserProfile }) {
	const { t, language, setLanguage } = useI18n();
	const { toast } = useToast();
	const { refreshProfile, signOut } = useAuth();
	const { preference, setPreference } = useAppTheme();
	const { privacyOptionsRequired } = useAdsState();
	const muted = useThemeColor("muted");

	const languages = useLanguages();
	const regions = useRegions();
	const me = useQuery({ queryKey: ["me"], queryFn: getMe });

	// Seeded once from the profile. Nothing resets it afterwards: a save makes
	// the profile catch up with the form, so `isDirty` settles on its own, and a
	// logo upload refreshing the profile must not throw away half-typed edits.
	const [details, setDetails] = useState(() => detailsOf(profile));
	const [selectedLanguages, setSelectedLanguages] = useState(
		() => profile.languages,
	);
	const [regionCode, setRegionCode] = useState(() => profile.regionCode);
	const [regionPickerOpen, setRegionPickerOpen] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [logoBusy, setLogoBusy] = useState(false);

	const saved = detailsOf(profile);
	const isDirty =
		details.displayName.trim() !== saved.displayName ||
		details.designation.trim() !== saved.designation ||
		details.contactPhone.trim() !== saved.contactPhone ||
		!sameSet(selectedLanguages, profile.languages) ||
		regionCode !== profile.regionCode;

	const email = me.data?.email;
	const visibleEmail =
		email && !email.endsWith(PLACEHOLDER_EMAIL_DOMAIN) ? email : null;
	const heading = profile.displayName || profile.phone || visibleEmail;
	const regionName =
		regions.data?.find((r) => r.code === regionCode)?.name ?? regionCode;

	const save = async () => {
		if (selectedLanguages.length === 0) {
			setFormError(t("profile.needLanguage"));
			return;
		}
		if (!regionCode) {
			setFormError(t("profile.needState"));
			return;
		}
		setFormError(null);
		setIsSaving(true);
		try {
			// Every field, every time: this PUT replaces the whole profile (§3).
			const cleaned = cleanDetails(details);
			await updateProfile({
				regionCode,
				languages: selectedLanguages,
				...cleaned,
			});
			track("profile_updated", {
				has_designation: Boolean(cleaned.designation),
				has_phone: Boolean(cleaned.contactPhone),
			});
			await refreshProfile();
			setDetails((current) => ({
				displayName: current.displayName.trim(),
				designation: current.designation.trim(),
				contactPhone: current.contactPhone.trim(),
			}));
			toast.show({ variant: "success", label: t("profile.savedToast") });
		} catch (cause) {
			setFormError(friendlyError(cause, t, language));
		} finally {
			setIsSaving(false);
		}
	};

	const pickLogo = async () => {
		let result: ImagePicker.ImagePickerResult;
		try {
			result = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ["images"],
				allowsEditing: true,
				aspect: [1, 1],
				quality: 0.85,
			});
		} catch {
			// The picker itself failed to open (no photo app, OEM quirk).
			toast.show({ variant: "danger", label: t("common.somethingWrong") });
			return;
		}
		const asset = result.canceled ? null : result.assets[0];
		if (!asset) return;

		const mimeType = uploadMimeType(asset);
		if (!mimeType) {
			toast.show({ variant: "danger", label: t("profile.logoWrongType") });
			return;
		}
		const bytes = asset.fileSize ?? new File(asset.uri).size ?? 0;
		if (bytes > MAX_LOGO_BYTES) {
			toast.show({ variant: "danger", label: t("profile.logoTooBig") });
			return;
		}

		setLogoBusy(true);
		try {
			await uploadAvatar({ uri: asset.uri, mimeType, bytes });
			track("logo_uploaded");
			await refreshProfile();
			toast.show({ variant: "success", label: t("profile.logoSaved") });
		} catch (cause) {
			toast.show({
				variant: "danger",
				label: friendlyError(cause, t, language),
			});
		} finally {
			setLogoBusy(false);
		}
	};

	const removeLogo = () => {
		Alert.alert(t("profile.logoRemoveTitle"), t("profile.logoRemoveBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("profile.logoRemove"),
				style: "destructive",
				onPress: async () => {
					setLogoBusy(true);
					try {
						await deleteAvatar();
					} catch (cause) {
						// 404 means there was nothing to remove — the goal is met.
						if (apiErrorCode(cause) !== "NOT_FOUND") {
							toast.show({
								variant: "danger",
								label: friendlyError(cause, t, language),
							});
						}
					}
					await refreshProfile();
					setLogoBusy(false);
				},
			},
		]);
	};

	const confirmSignOut = () => {
		Alert.alert(t("profile.signOutTitle"), t("profile.signOutBody"), [
			{ text: t("common.cancel"), style: "cancel" },
			{
				text: t("profile.signOut"),
				style: "destructive",
				onPress: () => void signOut(),
			},
		]);
	};

	const chooseAppLanguage = (next: AppLanguage) => {
		setLanguage(next);
		track("app_language_selected", { language: next });
	};

	const avatarThumb = getThumbnailUrl(profile.avatarUrl, 96);

	return (
		<SafeAreaView edges={["top"]} className="flex-1 bg-background">
			<KeyboardAwareScrollView
				bottomOffset={24}
				keyboardShouldPersistTaps="handled"
				contentContainerStyle={{
					gap: 20,
					paddingHorizontal: 16,
					paddingBottom: 32,
				}}
			>
				<ScreenHeader title={t("profile.title")} />

				{/* Who they are, and the logo printed on customised greetings. */}
				<Section>
					<View className="flex-row items-center gap-4">
						<View className="size-24 items-center justify-center overflow-hidden rounded-2xl bg-accent-soft">
							{avatarThumb ? (
								<Image
									source={{ uri: avatarThumb }}
									// Keyed by object key: a replaced logo gets a new key, so the
									// old one can never be shown from cache (§3).
									recyclingKey={profile.avatarKey ?? undefined}
									cachePolicy="memory-disk"
									contentFit="cover"
									transition={150}
									style={{ width: "100%", height: "100%" }}
									accessibilityLabel={t("profile.logo")}
								/>
							) : (
								<Ionicons name="person" size={44} color={muted} />
							)}
						</View>
						<View className="flex-1">
							<Text
								numberOfLines={2}
								className="font-heading-semibold text-foreground text-xl"
							>
								{heading ?? t("profile.noName")}
							</Text>
							{profile.displayName && profile.phone ? (
								<Text className="text-base text-muted">{profile.phone}</Text>
							) : null}
							{visibleEmail && heading !== visibleEmail ? (
								<Text numberOfLines={1} className="text-base text-muted">
									{visibleEmail}
								</Text>
							) : null}
						</View>
					</View>
					<Text className="text-base text-muted">{t("profile.logoHint")}</Text>
					<View className="flex-row gap-3">
						<ActionButton
							label={
								profile.avatarUrl
									? t("profile.logoChange")
									: t("profile.logoAdd")
							}
							icon="image-outline"
							variant="secondary"
							size="md"
							onPress={() => void pickLogo()}
							isLoading={logoBusy}
							className="flex-1"
						/>
						{profile.avatarUrl ? (
							<ActionButton
								label={t("profile.logoRemove")}
								icon="trash-outline"
								variant="tertiary"
								size="md"
								onPress={removeLogo}
								isDisabled={logoBusy}
							/>
						) : null}
					</View>
				</Section>

				<Section
					title={t("profile.detailsTitle")}
					description={t("profile.detailsBody")}
				>
					<DetailsFields values={details} onChange={setDetails} />
				</Section>

				<Section
					title={t("profile.languagesTitle")}
					description={t("profile.languagesBody")}
				>
					{languages.data ? (
						<LanguageSelect
							languages={languages.data}
							selected={selectedLanguages}
							onChange={setSelectedLanguages}
						/>
					) : (
						<ReferenceStatus
							isError={languages.isError}
							onRetry={() => void languages.refetch()}
						/>
					)}
				</Section>

				<Section
					title={t("profile.stateTitle")}
					description={t("profile.stateBody")}
				>
					{regions.data ? (
						<SettingsRow
							icon="location-outline"
							label={regionName ?? t("profile.stateNone")}
							action={t("profile.change")}
							onPress={() => setRegionPickerOpen(true)}
						/>
					) : (
						<ReferenceStatus
							isError={regions.isError}
							onRetry={() => void regions.refetch()}
						/>
					)}
				</Section>

				{isDirty || formError ? (
					<View className="gap-3">
						<FieldError isInvalid={Boolean(formError)}>{formError}</FieldError>
						<ActionButton
							label={t("profile.saveChanges")}
							icon="checkmark"
							onPress={() => void save()}
							isLoading={isSaving}
						/>
					</View>
				) : null}

				<Section title={t("profile.appLanguageTitle")}>
					<View className="flex-row flex-wrap gap-3">
						<Chip
							label={t("common.english")}
							selected={language === "en"}
							onPress={() => chooseAppLanguage("en")}
						/>
						<Chip
							label={t("common.hindi")}
							selected={language === "hi"}
							onPress={() => chooseAppLanguage("hi")}
						/>
					</View>
				</Section>

				<Section title={t("profile.themeTitle")}>
					<View className="flex-row flex-wrap gap-3">
						{THEMES.map((theme) => (
							<Chip
								key={theme.value}
								label={t(theme.label)}
								icon={theme.icon}
								selected={preference === theme.value}
								onPress={() => setPreference(theme.value)}
							/>
						))}
					</View>
				</Section>

				<Section title={t("profile.aboutTitle")}>
					{privacyOptionsRequired ? (
						<SettingsRow
							icon="shield-checkmark-outline"
							label={t("profile.privacyChoices")}
							onPress={() => void showPrivacyOptions()}
						/>
					) : null}
					{env.EXPO_PUBLIC_PRIVACY_POLICY_URL ? (
						<SettingsRow
							icon="document-text-outline"
							label={t("profile.privacyPolicy")}
							onPress={() => {
								if (env.EXPO_PUBLIC_PRIVACY_POLICY_URL) {
									void WebBrowser.openBrowserAsync(
										env.EXPO_PUBLIC_PRIVACY_POLICY_URL,
									);
								}
							}}
						/>
					) : null}
					<SettingsRow
						icon="information-circle-outline"
						label={t("profile.version", {
							version: Constants.expoConfig?.version ?? "—",
						})}
					/>
				</Section>

				<ActionButton
					label={t("profile.signOut")}
					icon="log-out-outline"
					variant="danger-soft"
					onPress={confirmSignOut}
				/>
			</KeyboardAwareScrollView>

			<RegionPickerModal
				visible={regionPickerOpen}
				regions={regions.data ?? []}
				selected={regionCode}
				onSelect={setRegionCode}
				onClose={() => setRegionPickerOpen(false)}
			/>
		</SafeAreaView>
	);
}

/**
 * The picker's declared type, or one inferred from the file name.
 *
 * The upload is signed for an exact content type and R2 rejects a mismatch, so
 * a guess here has to be right or absent. HEIC and the like are refused rather
 * than mislabelled; with `quality` set, both platforms hand back a JPEG anyway.
 */
function uploadMimeType(
	asset: ImagePicker.ImagePickerAsset,
): UploadMimeType | null {
	const declared = asset.mimeType?.toLowerCase();
	if (declared === "image/jpeg" || declared === "image/jpg")
		return "image/jpeg";
	if (declared === "image/png" || declared === "image/webp") return declared;
	if (declared) return null;

	const extension = asset.uri.split(".").pop()?.toLowerCase();
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
	if (extension === "png") return "image/png";
	if (extension === "webp") return "image/webp";
	return null;
}

function Section({
	title,
	description,
	children,
}: {
	title?: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<View className="gap-4 rounded-2xl bg-surface p-4">
			{title ? (
				<View className="gap-1">
					<Text
						className="font-heading-semibold text-foreground text-lg"
						accessibilityRole="header"
					>
						{title}
					</Text>
					{description ? (
						<Text className="text-base text-muted">{description}</Text>
					) : null}
				</View>
			) : null}
			{children}
		</View>
	);
}

/** A full-width row: icon, label, and — when tappable — what tapping does. */
function SettingsRow({
	icon,
	label,
	action,
	onPress,
}: {
	icon: keyof typeof Ionicons.glyphMap;
	label: string;
	action?: string;
	onPress?: () => void;
}) {
	const [foreground, muted, accent] = useThemeColor([
		"foreground",
		"muted",
		"accent",
	]);
	return (
		<Pressable
			onPress={onPress}
			disabled={!onPress}
			accessibilityRole={onPress ? "button" : "text"}
			className="min-h-12 flex-row items-center gap-3"
		>
			<Ionicons name={icon} size={22} color={foreground} />
			<Text className="flex-1 text-base text-foreground">{label}</Text>
			{action ? (
				<Text className="font-semibold text-accent text-base">{action}</Text>
			) : null}
			{onPress ? (
				<Ionicons
					name="chevron-forward"
					size={20}
					color={action ? accent : muted}
				/>
			) : null}
		</Pressable>
	);
}

/** Loading or failed state for a picker list inside a section. */
function ReferenceStatus({
	isError,
	onRetry,
}: {
	isError: boolean;
	onRetry: () => void;
}) {
	const t = useI18n().t;
	const accent = useThemeColor("accent");
	if (!isError) return <Spinner color={accent} className="self-center" />;
	return (
		<View className="gap-3">
			<Text className="text-base text-muted">{t("common.offline")}</Text>
			<ActionButton
				label={t("common.retry")}
				icon="refresh"
				variant="secondary"
				size="md"
				onPress={onRetry}
			/>
		</View>
	);
}
