import { Surface } from "heroui-native";
import { useState } from "react";
import {
	KeyboardAvoidingView,
	Platform,
	Pressable,
	ScrollView,
	Text,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { DevTokenSignIn } from "@/components/auth/dev-token-sign-in";
import { EmailSignIn } from "@/components/auth/email-sign-in";
import { GoogleSignIn } from "@/components/auth/google-sign-in";
import { PhoneSignIn } from "@/components/auth/phone-sign-in";
import { isGoogleSignInAvailable } from "@/lib/firebase";

/**
 * The only way into the app.
 *
 * A shell: it picks between the two form-based methods and stacks Google
 * underneath. Each method owns its own state and errors — they share nothing
 * but the ID token they produce, and merging them into one component produced a
 * screen nobody could follow.
 */

type Method = "phone" | "email";

const METHODS: { key: Method; label: string }[] = [
	{ key: "phone", label: "Phone" },
	{ key: "email", label: "Email" },
];

export default function SignInScreen() {
	const [method, setMethod] = useState<Method>("phone");

	return (
		<SafeAreaView style={{ flex: 1 }} className="bg-background">
			<KeyboardAvoidingView
				behavior={Platform.OS === "ios" ? "padding" : "height"}
				style={{ flex: 1 }}
			>
				<ScrollView
					contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}
					className="px-6 py-12"
					keyboardShouldPersistTaps="handled"
				>
					<View className="mb-8 items-center">
						<Text className="mb-2 font-bold text-3xl text-foreground">
							Greetings
						</Text>
						<Text className="text-center text-muted-foreground">
							Sign in to get personalised cards and designs
						</Text>
					</View>

					<Surface variant="secondary" className="rounded-2xl p-6">
						<View className="mb-5 flex-row rounded-xl bg-background p-1">
							{METHODS.map(({ key, label }) => {
								const isActive = method === key;
								return (
									<Pressable
										key={key}
										onPress={() => setMethod(key)}
										className={`flex-1 items-center rounded-lg py-2.5 ${
											isActive ? "bg-primary" : ""
										}`}
									>
										<Text
											className={`font-medium text-sm ${
												isActive
													? "text-primary-foreground"
													: "text-muted-foreground"
											}`}
										>
											{label}
										</Text>
									</Pressable>
								);
							})}
						</View>

						{method === "phone" ? <PhoneSignIn /> : <EmailSignIn />}

						{isGoogleSignInAvailable() ? (
							<>
								<View className="my-5 flex-row items-center gap-3">
									<View className="h-px flex-1 bg-border" />
									<Text className="text-muted-foreground text-xs">or</Text>
									<View className="h-px flex-1 bg-border" />
								</View>

								<GoogleSignIn />
							</>
						) : null}
					</Surface>

					<DevTokenSignIn />
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
