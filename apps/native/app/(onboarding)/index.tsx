import { Ionicons } from "@expo/vector-icons";
import { cn, FieldError, Spinner, useThemeColor } from "heroui-native";
import { type ReactNode, useEffect, useState } from "react";
import { BackHandler, Pressable, ScrollView, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { ActionButton } from "@/components/ui/action-button";
import {
	cleanDetails,
	DetailsFields,
	type DetailsValues,
} from "@/components/ui/details-fields";
import { LanguageSelect } from "@/components/ui/language-select";
import { useLanguages, useRegions } from "@/components/ui/reference-data";
import { RegionList } from "@/components/ui/region-list";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { ErrorState } from "@/components/ui/state-views";
import { useAuth } from "@/contexts/auth-context";
import { track } from "@/lib/analytics";
import { friendlyError } from "@/lib/errors";
import { useI18n } from "@/lib/i18n";
import { updateProfile } from "@/lib/services";

const STEPS = ["languages", "region", "details"] as const;
type Step = (typeof STEPS)[number];

/**
 * Onboarding: content languages, then state, then optional details.
 *
 * Not cosmetic — region and languages are two of the feed's three ranking
 * signals, and the region is stamped on every download for designers (§3) —
 * so the first two steps are required and only the third can be skipped.
 *
 * Nothing is saved until the end, in one `PUT /v1/me/profile` carrying every
 * field. On success the profile is re-read and the auth guard moves the person
 * on; this screen never navigates itself.
 */
export default function OnboardingScreen() {
	const { t, language } = useI18n();
	const { userProfile, refreshProfile, signOut } = useAuth();

	const languages = useLanguages();
	const regions = useRegions();

	const [stepIndex, setStepIndex] = useState(0);
	// The app's own language is a sensible first guess at the greetings they
	// want; both "en" and "hi" are content language codes too. One tap undoes it.
	const [selectedLanguages, setSelectedLanguages] = useState<string[]>(() =>
		userProfile?.languages.length ? userProfile.languages : [language],
	);
	const [regionCode, setRegionCode] = useState<string | null>(
		() => userProfile?.regionCode ?? null,
	);
	// The sign-in number is the likeliest contact number; prefilled, editable,
	// and only printed if they keep it (§3).
	const [details, setDetails] = useState<DetailsValues>(() => ({
		displayName: userProfile?.displayName ?? "",
		designation: userProfile?.designation ?? "",
		contactPhone: userProfile?.contactPhone ?? userProfile?.phone ?? "",
	}));
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const step: Step = STEPS[stepIndex] ?? "languages";

	useEffect(() => {
		track("onboarding_started");
	}, []);

	// Android's back button steps back through onboarding instead of leaving it.
	useEffect(() => {
		if (stepIndex === 0) return;
		const subscription = BackHandler.addEventListener(
			"hardwareBackPress",
			() => {
				setStepIndex((index) => index - 1);
				return true;
			},
		);
		return () => subscription.remove();
	}, [stepIndex]);

	const goBack = () => {
		setError(null);
		setStepIndex((index) => Math.max(0, index - 1));
	};

	const next = () => {
		if (step === "languages" && selectedLanguages.length === 0) {
			setError(t("onboarding.needLanguage"));
			return;
		}
		if (step === "region" && !regionCode) {
			setError(t("onboarding.needState"));
			return;
		}
		setError(null);
		track("onboarding_step_completed", { step });
		setStepIndex((index) => index + 1);
	};

	const finish = async (withDetails: boolean) => {
		if (!regionCode || isSubmitting) return;
		setError(null);
		setIsSubmitting(true);
		try {
			const cleaned = withDetails ? cleanDetails(details) : {};
			await updateProfile({
				regionCode,
				languages: selectedLanguages,
				...cleaned,
			});
			track("onboarding_step_completed", { step: "details" });
			track("onboarding_completed", {
				language_count: selectedLanguages.length,
				has_details: Object.values(cleaned).some(Boolean),
			});
			// The guard routes onward once the profile says `onboarded`. If the
			// re-read fails the save still stood, so retrying is harmless.
			if (!(await refreshProfile())) setError(t("common.offline"));
		} catch (cause) {
			setError(friendlyError(cause, t, language));
		} finally {
			setIsSubmitting(false);
		}
	};

	const stepTitle = (
		<StepHeading
			title={t(`onboarding.${step}Title`)}
			body={t(`onboarding.${step}Body`)}
		/>
	);

	let body: ReactNode;
	if (step === "languages") {
		body = languages.data ? (
			<ScrollView contentContainerClassName="px-4 pb-6">
				{stepTitle}
				<LanguageSelect
					languages={languages.data}
					selected={selectedLanguages}
					onChange={(nextLanguages) => {
						setSelectedLanguages(nextLanguages);
						setError(null);
					}}
				/>
			</ScrollView>
		) : (
			<ListStatus
				isError={languages.isError}
				onRetry={() => void languages.refetch()}
			/>
		);
	} else if (step === "region") {
		body = regions.data ? (
			<RegionList
				regions={regions.data}
				selected={regionCode}
				onSelect={(code) => {
					setRegionCode(code);
					setError(null);
				}}
				header={stepTitle}
			/>
		) : (
			<ListStatus
				isError={regions.isError}
				onRetry={() => void regions.refetch()}
			/>
		);
	} else {
		body = (
			<KeyboardAwareScrollView
				bottomOffset={24}
				keyboardShouldPersistTaps="handled"
				contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
			>
				{stepTitle}
				<DetailsFields
					values={details}
					onChange={setDetails}
					isDisabled={isSubmitting}
				/>
			</KeyboardAwareScrollView>
		);
	}

	return (
		<SafeAreaView edges={["top", "bottom"]} className="flex-1 bg-background">
			<View className="min-h-12 flex-row items-center justify-between px-2">
				{stepIndex > 0 ? (
					<TopLink
						icon="chevron-back"
						label={t("common.back")}
						onPress={goBack}
					/>
				) : (
					<TopLink
						icon="log-out-outline"
						label={t("onboarding.notYou")}
						onPress={() => void signOut()}
					/>
				)}
				<Text className="px-3 text-base text-muted">
					{t("onboarding.stepOf", { step: stepIndex + 1, total: STEPS.length })}
				</Text>
			</View>
			<View className="flex-row gap-2 px-4 pt-1 pb-2">
				{STEPS.map((name, index) => (
					<View
						key={name}
						className={cn(
							"h-1.5 flex-1 rounded-full",
							index <= stepIndex ? "bg-accent" : "bg-default",
						)}
					/>
				))}
			</View>

			<View className="flex-1">{body}</View>

			<View className="gap-3 border-border border-t px-4 pt-3 pb-2">
				<FieldError isInvalid={Boolean(error)}>{error}</FieldError>
				{step === "details" ? (
					<>
						<ActionButton
							label={t("onboarding.finish")}
							icon="checkmark"
							onPress={() => void finish(true)}
							isLoading={isSubmitting}
						/>
						<ActionButton
							label={t("onboarding.skip")}
							variant="tertiary"
							onPress={() => void finish(false)}
							isDisabled={isSubmitting}
						/>
					</>
				) : (
					<ActionButton
						label={t("common.continue")}
						icon="arrow-forward"
						onPress={next}
					/>
				)}
			</View>
		</SafeAreaView>
	);
}

function StepHeading({ title, body }: { title: string; body: string }) {
	return (
		<View className="gap-2 pt-4 pb-6">
			<Text
				className="font-heading text-2xl text-foreground"
				accessibilityRole="header"
			>
				{title}
			</Text>
			<Text className="text-base text-muted">{body}</Text>
		</View>
	);
}

function TopLink({
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
			className="min-h-12 flex-row items-center gap-1 px-3"
		>
			<Ionicons name={icon} size={20} color={foreground} />
			<Text className="text-base text-foreground">{label}</Text>
		</Pressable>
	);
}

function ListStatus({
	isError,
	onRetry,
}: {
	isError: boolean;
	onRetry: () => void;
}) {
	const { t } = useI18n();
	const accent = useThemeColor("accent");
	if (isError) {
		return <ErrorState message={t("common.offline")} onRetry={onRetry} />;
	}
	return (
		<View className="flex-1 items-center justify-center">
			<Spinner color={accent} />
		</View>
	);
}
