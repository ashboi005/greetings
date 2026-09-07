import { Ionicons } from "@expo/vector-icons";
import { Button, FieldError, Spinner, useThemeColor } from "heroui-native";
import { useState } from "react";
import { Text, View } from "react-native";

import { useAuth } from "@/contexts/auth-context";
import { authErrorMessage } from "@/lib/auth-errors";
import { isGoogleSignInAvailable, signInWithGoogle } from "@/lib/firebase";

/**
 * "Continue with Google".
 *
 * Renders nothing when the build has no web client ID — a button that can only
 * fail is worse than no button. See `isGoogleSignInAvailable`.
 */
export function GoogleSignIn() {
	const { signInWithFirebaseToken, isSigningIn } = useAuth();
	const foreground = useThemeColor("foreground");

	const [isWorking, setIsWorking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!isGoogleSignInAvailable()) return null;

	const busy = isWorking || isSigningIn;

	const handlePress = async () => {
		setError(null);
		setIsWorking(true);
		try {
			const idToken = await signInWithGoogle();

			// Null means the account picker was dismissed. That is how this ends
			// most of the time and is not something to report.
			if (!idToken) return;

			await signInWithFirebaseToken(idToken);
		} catch (cause) {
			setError(authErrorMessage(cause));
		} finally {
			setIsWorking(false);
		}
	};

	return (
		<View>
			<FieldError isInvalid={!!error} className="mb-3">
				{error}
			</FieldError>

			<Button variant="secondary" onPress={handlePress} isDisabled={busy}>
				{isWorking ? (
					<Spinner size="sm" color="default" />
				) : (
					<View className="flex-row items-center justify-center gap-2">
						<Ionicons name="logo-google" size={16} color={foreground} />
						<Text className="font-medium text-foreground">
							Continue with Google
						</Text>
					</View>
				)}
			</Button>
		</View>
	);
}
