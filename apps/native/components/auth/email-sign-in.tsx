import {
	Button,
	FieldError,
	Input,
	Label,
	Spinner,
	TextField,
} from "heroui-native";
import { useRef, useState } from "react";
import { Pressable, Text, type TextInput, View } from "react-native";

import { useAuth } from "@/contexts/auth-context";
import { authErrorMessage } from "@/lib/auth-errors";
import {
	EmailNotVerifiedError,
	resendEmailVerification,
	sendPasswordReset,
	signInWithEmail,
	signUpWithEmail,
} from "@/lib/firebase";

/**
 * Email and password sign-in, with the confirmation step it requires.
 *
 * Three states, because creating an account here does not sign you in:
 *
 *   signIn      → email + password
 *   signUp      → email + password + confirm, then Firebase mails a link
 *   awaitVerify → "check your inbox", with resend
 *
 * `awaitVerify` is not a nicety. The server keeps a placeholder address for any
 * identity whose email it cannot trust and only links accounts on a verified
 * one, so an unconfirmed account would be unfindable by the address its owner
 * typed. `lib/firebase.ts` has the full reasoning.
 */

const MIN_PASSWORD_LENGTH = 8;

type Mode = "signIn" | "signUp" | "awaitVerify";

export function EmailSignIn() {
	const { signInWithFirebaseToken, isSigningIn } = useAuth();

	const [mode, setMode] = useState<Mode>("signIn");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [isWorking, setIsWorking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const passwordRef = useRef<TextInput>(null);
	const confirmRef = useRef<TextInput>(null);

	const busy = isWorking || isSigningIn;

	const clearMessages = () => {
		setError(null);
		setNotice(null);
	};

	const validate = (): string | null => {
		if (!email.trim()) return "Enter your email address.";
		if (!password) return "Enter your password.";
		if (mode === "signUp") {
			if (password.length < MIN_PASSWORD_LENGTH) {
				return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
			}
			if (password !== confirmPassword) return "Those passwords do not match.";
		}
		return null;
	};

	const handleSubmit = async () => {
		const invalid = validate();
		if (invalid) {
			setError(invalid);
			return;
		}

		clearMessages();
		setIsWorking(true);
		try {
			if (mode === "signUp") {
				await signUpWithEmail(email, password);
				setMode("awaitVerify");
				setNotice(
					`We sent a confirmation link to ${email.trim()}. Follow it, then sign in.`,
				);
				return;
			}

			const idToken = await signInWithEmail(email, password);
			await signInWithFirebaseToken(idToken);
		} catch (cause) {
			// Not a correction to make but a step to take, so it gets its own state
			// rather than a red line under the password field.
			if (cause instanceof EmailNotVerifiedError) {
				setMode("awaitVerify");
				setNotice(cause.message);
				return;
			}
			setError(authErrorMessage(cause));
		} finally {
			setIsWorking(false);
		}
	};

	const handleResend = async () => {
		clearMessages();
		setIsWorking(true);
		try {
			await resendEmailVerification(email, password);
			setNotice(`Sent again to ${email.trim()}.`);
		} catch (cause) {
			setError(authErrorMessage(cause));
		} finally {
			setIsWorking(false);
		}
	};

	const handleForgotPassword = async () => {
		if (!email.trim()) {
			setError("Enter your email address first.");
			return;
		}

		clearMessages();
		setIsWorking(true);
		try {
			await sendPasswordReset(email);
			setNotice("If that address has an account, a reset link is on its way.");
		} catch (cause) {
			setError(authErrorMessage(cause));
		} finally {
			setIsWorking(false);
		}
	};

	const switchMode = (next: Mode) => {
		setMode(next);
		clearMessages();
		setConfirmPassword("");
	};

	if (mode === "awaitVerify") {
		return (
			<View className="gap-4">
				<FieldError isInvalid={!!error}>{error}</FieldError>

				{notice ? (
					<Text className="text-foreground text-sm">{notice}</Text>
				) : null}

				<Text className="text-muted-foreground text-xs">
					The link opens in your browser and confirms the address. Come back
					here afterwards — nothing else to do.
				</Text>

				<Button onPress={handleSubmit} isDisabled={busy}>
					{busy ? (
						<Spinner size="sm" color="default" />
					) : (
						<Button.Label>I have confirmed it — sign me in</Button.Label>
					)}
				</Button>

				<View className="flex-row items-center justify-between">
					<Pressable onPress={() => switchMode("signIn")} disabled={busy}>
						<Text className="text-muted-foreground text-sm">Back</Text>
					</Pressable>
					<Pressable onPress={handleResend} disabled={busy}>
						<Text className="text-primary text-sm">Send it again</Text>
					</Pressable>
				</View>
			</View>
		);
	}

	return (
		<View className="gap-4">
			<FieldError isInvalid={!!error}>{error}</FieldError>

			{notice ? (
				<Text className="text-foreground text-sm">{notice}</Text>
			) : null}

			<TextField>
				<Label>Email</Label>
				<Input
					value={email}
					onChangeText={(next) => {
						setEmail(next);
						clearMessages();
					}}
					placeholder="you@example.com"
					keyboardType="email-address"
					autoCapitalize="none"
					autoCorrect={false}
					autoComplete="email"
					textContentType="emailAddress"
					returnKeyType="next"
					blurOnSubmit={false}
					onSubmitEditing={() => passwordRef.current?.focus()}
					editable={!busy}
				/>
			</TextField>

			<TextField>
				<Label>Password</Label>
				<Input
					ref={passwordRef}
					value={password}
					onChangeText={(next) => {
						setPassword(next);
						clearMessages();
					}}
					placeholder="••••••••"
					secureTextEntry
					autoCapitalize="none"
					autoComplete={mode === "signUp" ? "new-password" : "password"}
					textContentType={mode === "signUp" ? "newPassword" : "password"}
					returnKeyType={mode === "signUp" ? "next" : "go"}
					blurOnSubmit={mode !== "signUp"}
					onSubmitEditing={() =>
						mode === "signUp" ? confirmRef.current?.focus() : handleSubmit()
					}
					editable={!busy}
				/>
			</TextField>

			{mode === "signUp" ? (
				<TextField>
					<Label>Confirm password</Label>
					<Input
						ref={confirmRef}
						value={confirmPassword}
						onChangeText={(next) => {
							setConfirmPassword(next);
							clearMessages();
						}}
						placeholder="••••••••"
						secureTextEntry
						autoCapitalize="none"
						autoComplete="new-password"
						textContentType="newPassword"
						returnKeyType="go"
						onSubmitEditing={handleSubmit}
						editable={!busy}
					/>
				</TextField>
			) : null}

			<Button onPress={handleSubmit} isDisabled={busy}>
				{busy ? (
					<Spinner size="sm" color="default" />
				) : (
					<Button.Label>
						{mode === "signUp" ? "Create account" : "Sign in"}
					</Button.Label>
				)}
			</Button>

			<View className="flex-row items-center justify-between">
				<Pressable
					onPress={() => switchMode(mode === "signUp" ? "signIn" : "signUp")}
					disabled={busy}
				>
					<Text className="text-primary text-sm">
						{mode === "signUp"
							? "I already have an account"
							: "Create an account"}
					</Text>
				</Pressable>

				{mode === "signIn" ? (
					<Pressable onPress={handleForgotPassword} disabled={busy}>
						<Text className="text-muted-foreground text-sm">
							Forgot password?
						</Text>
					</Pressable>
				) : null}
			</View>
		</View>
	);
}
