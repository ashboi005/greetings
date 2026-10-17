import { FieldError } from "heroui-native";
import { useState } from "react";
import { View } from "react-native";

import { ActionButton } from "@/components/ui/action-button";
import { useAuth } from "@/contexts/auth-context";
import { track } from "@/lib/analytics";
import { isGoogleSignInAvailable, signInWithGoogle } from "@/lib/firebase";
import { useT } from "@/lib/i18n";
import { useAuthError } from "./use-auth-error";

/**
 * "Continue with Google".
 *
 * Renders nothing when the build has no web client ID — a button that can only
 * fail is worse than no button. See `isGoogleSignInAvailable`.
 */
export function GoogleSignIn() {
	const { signInWithFirebaseToken, isSigningIn } = useAuth();
	const t = useT();
	const authError = useAuthError();

	const [isWorking, setIsWorking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!isGoogleSignInAvailable()) return null;

	const handlePress = async () => {
		track("sign_in_method_selected", { method: "google" });
		setError(null);
		setIsWorking(true);
		try {
			const idToken = await signInWithGoogle();

			// Null means the account picker was dismissed. That is how this ends
			// most of the time and is not something to report.
			if (!idToken) return;

			await signInWithFirebaseToken(idToken, "google");
		} catch (cause) {
			track("sign_in_failed", { method: "google" });
			setError(authError(cause));
		} finally {
			setIsWorking(false);
		}
	};

	return (
		<View className="gap-3">
			<FieldError isInvalid={Boolean(error)}>{error}</FieldError>
			<ActionButton
				label={t("auth.google")}
				icon="logo-google"
				variant="tertiary"
				onPress={handlePress}
				isLoading={isWorking}
				isDisabled={isSigningIn}
			/>
		</View>
	);
}
