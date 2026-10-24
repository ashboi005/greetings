import { Ionicons } from "@expo/vector-icons";
import { cn, useThemeColor } from "heroui-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";

import { DevTokenSignIn } from "@/components/auth/dev-token-sign-in";
import { EmailSignIn } from "@/components/auth/email-sign-in";
import { GoogleSignIn } from "@/components/auth/google-sign-in";
import { PhoneSignIn } from "@/components/auth/phone-sign-in";
import { SafeAreaView } from "@/components/ui/safe-area-view";
import { isGoogleSignInAvailable } from "@/lib/firebase";
import { type StringKey, useT } from "@/lib/i18n";

/**
 * The only way into the app.
 *
 * A shell: it picks between the two form-based methods and stacks Google
 * underneath. Each method owns its own state and errors — they share nothing
 * but the ID token they produce, and merging them into one component produced a
 * screen nobody could follow.
 *
 * Phone comes first and is the default: it is how this audience already
 * identifies itself everywhere else, and most have no email they check.
 */

type Method = "phone" | "email";

const METHODS: {
	key: Method;
	label: StringKey;
	icon: keyof typeof Ionicons.glyphMap;
}[] = [
	{ key: "phone", label: "auth.tabPhone", icon: "call-outline" },
	{ key: "email", label: "auth.tabEmail", icon: "mail-outline" },
];

export default function SignInScreen() {
	const t = useT();
	const [method, setMethod] = useState<Method>("phone");
	const [accentSoftForeground, accentForeground, foreground] = useThemeColor([
		"accent-soft-foreground",
		"accent-foreground",
		"foreground",
	]);

	return (
		<SafeAreaView className="flex-1 bg-background">
			<KeyboardAwareScrollView
				bottomOffset={24}
				keyboardShouldPersistTaps="handled"
				contentContainerStyle={{
					flexGrow: 1,
					justifyContent: "center",
					paddingHorizontal: 20,
					paddingVertical: 40,
				}}
			>
				<View className="mb-8 items-center">
					<View className="mb-4 size-20 items-center justify-center rounded-full bg-accent-soft">
						<Ionicons name="gift" size={40} color={accentSoftForeground} />
					</View>
					<Text
						className="font-heading text-3xl text-foreground"
						accessibilityRole="header"
					>
						{t("common.appName")}
					</Text>
					<Text className="mt-2 text-center text-base text-muted">
						{t("auth.tagline")}
					</Text>
				</View>

				<View className="rounded-3xl bg-surface p-5">
					<View
						className="mb-6 flex-row gap-1 rounded-2xl bg-default p-1"
						accessibilityRole="tablist"
					>
						{METHODS.map(({ key, label, icon }) => {
							const isActive = method === key;
							return (
								<Pressable
									key={key}
									onPress={() => setMethod(key)}
									accessibilityRole="tab"
									accessibilityState={{ selected: isActive }}
									className={cn(
										"min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-xl",
										isActive && "bg-accent",
									)}
								>
									<Ionicons
										name={icon}
										size={20}
										color={isActive ? accentForeground : foreground}
									/>
									<Text
										className={cn(
											"text-base",
											isActive
												? "font-semibold text-accent-foreground"
												: "text-foreground",
										)}
									>
										{t(label)}
									</Text>
								</Pressable>
							);
						})}
					</View>

					{method === "phone" ? <PhoneSignIn /> : <EmailSignIn />}

					{isGoogleSignInAvailable() ? (
						<>
							<View className="my-6 flex-row items-center gap-3">
								<View className="h-px flex-1 bg-separator" />
								<Text className="text-base text-muted">{t("auth.or")}</Text>
								<View className="h-px flex-1 bg-separator" />
							</View>
							<GoogleSignIn />
						</>
					) : null}
				</View>

				<DevTokenSignIn />
			</KeyboardAwareScrollView>
		</SafeAreaView>
	);
}
