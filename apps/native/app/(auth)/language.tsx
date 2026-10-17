import { Ionicons } from "@expo/vector-icons";
import { useThemeColor } from "heroui-native";
import { Pressable, ScrollView, Text, View } from "react-native";

import { SafeAreaView } from "@/components/ui/safe-area-view";

import { track } from "@/lib/analytics";
import { type AppLanguage, translate, useI18n } from "@/lib/i18n";

/**
 * Screen 1: which language the *app* speaks.
 *
 * Shown before sign-in so that sign-in is already readable. Nothing has been
 * chosen yet, so the heading is written in both languages rather than guessing
 * — someone who reads only Hindi must be able to understand this screen.
 *
 * One tap chooses; the auth guard notices and moves on to sign-in. This is the
 * app's UI language only, never the content languages picked in onboarding.
 */
const OPTIONS: { value: AppLanguage; sample: string }[] = [
	{ value: "hi", sample: "नमस्ते" },
	{ value: "en", sample: "Hello" },
];

export default function LanguageScreen() {
	const { setLanguage } = useI18n();
	const [accentSoftForeground, accent] = useThemeColor([
		"accent-soft-foreground",
		"accent",
	]);

	const choose = (language: AppLanguage) => {
		track("app_language_selected", { language });
		setLanguage(language);
	};

	return (
		<SafeAreaView className="flex-1 bg-background">
			<ScrollView
				contentContainerClassName="grow justify-center px-6 py-10"
				bounces={false}
			>
				<View className="mb-10 items-center">
					<View className="mb-5 size-20 items-center justify-center rounded-full bg-accent-soft">
						<Ionicons name="language" size={40} color={accentSoftForeground} />
					</View>
					<Text
						className="text-center font-heading text-3xl text-foreground"
						accessibilityRole="header"
					>
						{translate("hi", "common.chooseLanguageTitle")}
					</Text>
					<Text className="mt-1 text-center font-heading-semibold text-muted text-xl">
						{translate("en", "common.chooseLanguageTitle")}
					</Text>
				</View>

				<View className="gap-4">
					{OPTIONS.map((option) => (
						<Pressable
							key={option.value}
							onPress={() => choose(option.value)}
							accessibilityRole="button"
							accessibilityLanguage={option.value}
							className="min-h-24 flex-row items-center gap-4 rounded-2xl border-2 border-border bg-surface px-5 py-4 active:border-accent active:bg-accent-soft"
						>
							<View className="flex-1">
								<Text className="font-heading text-2xl text-foreground">
									{translate(
										option.value,
										option.value === "hi" ? "common.hindi" : "common.english",
									)}
								</Text>
								<Text className="text-base text-muted">{option.sample}</Text>
							</View>
							<Ionicons name="arrow-forward-circle" size={36} color={accent} />
						</Pressable>
					))}
				</View>

				<Text className="mt-8 text-center text-base text-muted">
					{translate("hi", "common.chooseLanguageBody")}
					{"\n"}
					{translate("en", "common.chooseLanguageBody")}
				</Text>
			</ScrollView>
		</SafeAreaView>
	);
}
