import {
	Button,
	FieldError,
	Input,
	Label,
	Spinner,
	Surface,
	TextField,
} from "heroui-native";
import { useState } from "react";
import { Text, View } from "react-native";

import { useAuth } from "@/contexts/auth-context";
import { authErrorMessage } from "@/lib/auth-errors";

/**
 * Pastes a Firebase ID token straight into the exchange, for development.
 *
 * Isolates our half of sign-in from Firebase's: if this works and phone sign-in
 * does not, the problem is on the device side, not in the exchange.
 *
 * Compiled out of release builds — `__DEV__` is statically false there, so the
 * component and its imports are dropped rather than merely hidden behind a flag.
 */
export function DevTokenSignIn() {
	const { signInWithFirebaseToken, isSigningIn } = useAuth();
	const [idToken, setIdToken] = useState("");
	const [error, setError] = useState<string | null>(null);

	if (!__DEV__) return null;

	const handleSubmit = async () => {
		if (!idToken.trim()) {
			setError("Paste a Firebase ID token first.");
			return;
		}
		setError(null);
		try {
			await signInWithFirebaseToken(idToken.trim());
		} catch (cause) {
			setError(authErrorMessage(cause));
		}
	};

	return (
		<Surface variant="secondary" className="mt-6 rounded-2xl p-6 opacity-80">
			<Text className="mb-3 font-semibold text-muted-foreground text-sm">
				Development only — paste a Firebase ID token
			</Text>

			<FieldError isInvalid={!!error} className="mb-3">
				{error}
			</FieldError>

			<View className="gap-4">
				<TextField>
					<Label>Firebase ID token</Label>
					<Input
						value={idToken}
						onChangeText={setIdToken}
						placeholder="eyJhbGciOi…"
						multiline
						numberOfLines={3}
						autoCapitalize="none"
						autoCorrect={false}
					/>
				</TextField>
				<Button
					onPress={handleSubmit}
					isDisabled={isSigningIn}
					variant="secondary"
				>
					{isSigningIn ? (
						<Spinner size="sm" color="default" />
					) : (
						<Button.Label>Exchange token</Button.Label>
					)}
				</Button>
			</View>
		</Surface>
	);
}
