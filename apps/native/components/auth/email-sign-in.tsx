import { FieldError, Input, Label, TextField } from "heroui-native";
import { useRef, useState } from "react";
import { Pressable, Text, type TextInput, View } from "react-native";

import { ActionButton } from "@/components/ui/action-button";
import { useAuth } from "@/contexts/auth-context";
import { track } from "@/lib/analytics";
import {
	EmailNotVerifiedError,
	resendEmailVerification,
	sendPasswordReset,
	signInWithEmail,
	signUpWithEmail,
} from "@/lib/firebase";
import { useT } from "@/lib/i18n";
import { useAuthError } from "./use-auth-error";

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
	const t = useT();
	const authError = useAuthError();

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
		if (!email.trim()) return t("auth.enterEmail");
		if (!password) return t("auth.errEnterPassword");
		if (mode === "signUp") {
			if (password.length < MIN_PASSWORD_LENGTH) {
				return t("auth.passwordTooShort", { length: MIN_PASSWORD_LENGTH });
			}
			if (password !== confirmPassword) return t("auth.passwordMismatch");
		}
		return null;
	};

	const handleSubmit = async () => {
		const invalid = validate();
		if (invalid) {
			setError(invalid);
			return;
		}

		track("sign_in_method_selected", { method: "email" });
		clearMessages();
		setIsWorking(true);
		try {
			if (mode === "signUp") {
				await signUpWithEmail(email, password);
				setMode("awaitVerify");
				setNotice(t("auth.verifySent", { email: email.trim() }));
				return;
			}

			const idToken = await signInWithEmail(email, password);
			await signInWithFirebaseToken(idToken, "email");
		} catch (cause) {
			// Not a correction to make but a step to take, so it gets its own state
			// rather than a red line under the password field.
			if (cause instanceof EmailNotVerifiedError) {
				setMode("awaitVerify");
				setNotice(authError(cause));
				return;
			}
			track("sign_in_failed", { method: "email" });
			setError(authError(cause));
		} finally {
			setIsWorking(false);
		}
	};

	const handleResend = async () => {
		clearMessages();
		setIsWorking(true);
		try {
			await resendEmailVerification(email, password);
			setNotice(t("auth.verifyResent", { email: email.trim() }));
		} catch (cause) {
			setError(authError(cause));
		} finally {
			setIsWorking(false);
		}
	};

	const handleForgotPassword = async () => {
		if (!email.trim()) {
			setError(t("auth.enterEmailFirst"));
			return;
		}

		clearMessages();
		setIsWorking(true);
		try {
			await sendPasswordReset(email);
			setNotice(t("auth.resetSent"));
		} catch (cause) {
			setError(authError(cause));
		} finally {
			setIsWorking(false);
		}
	};

	const switchMode = (next: Mode) => {
		setMode(next);
		clearMessages();
		setConfirmPassword("");
	};

	const noticeView = notice ? (
		<View className="rounded-2xl bg-accent-soft p-4">
			<Text className="text-accent-soft-foreground text-base">{notice}</Text>
		</View>
	) : null;

	if (mode === "awaitVerify") {
		return (
			<View className="gap-5">
				{noticeView}
				<Text className="text-base text-muted">{t("auth.verifyHelp")}</Text>
				<FieldError isInvalid={Boolean(error)}>{error}</FieldError>

				<ActionButton
					label={t("auth.verifyDone")}
					icon="checkmark-circle-outline"
					onPress={handleSubmit}
					isLoading={busy}
				/>

				<View className="flex-row items-center justify-between">
					<TextLink
						label={t("common.back")}
						onPress={() => switchMode("signIn")}
						disabled={busy}
					/>
					<TextLink
						label={t("auth.verifyResend")}
						onPress={handleResend}
						disabled={busy}
						accent
					/>
				</View>
			</View>
		);
	}

	return (
		<View className="gap-5">
			{noticeView}

			<TextField>
				<Label>{t("auth.emailLabel")}</Label>
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
					submitBehavior="submit"
					onSubmitEditing={() => passwordRef.current?.focus()}
					editable={!busy}
					className="text-base"
				/>
			</TextField>

			<TextField>
				<Label>{t("auth.passwordLabel")}</Label>
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
					submitBehavior={mode === "signUp" ? "submit" : "blurAndSubmit"}
					onSubmitEditing={() =>
						mode === "signUp" ? confirmRef.current?.focus() : handleSubmit()
					}
					editable={!busy}
					className="text-base"
				/>
			</TextField>

			{mode === "signUp" ? (
				<TextField>
					<Label>{t("auth.confirmPasswordLabel")}</Label>
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
						className="text-base"
					/>
				</TextField>
			) : null}

			<FieldError isInvalid={Boolean(error)}>{error}</FieldError>

			<ActionButton
				label={mode === "signUp" ? t("auth.createAccount") : t("auth.signIn")}
				icon={mode === "signUp" ? "person-add-outline" : "log-in-outline"}
				onPress={handleSubmit}
				isLoading={busy}
			/>

			<View className="flex-row flex-wrap items-center justify-between gap-2">
				<TextLink
					label={
						mode === "signUp" ? t("auth.haveAccount") : t("auth.newAccount")
					}
					onPress={() => switchMode(mode === "signUp" ? "signIn" : "signUp")}
					disabled={busy}
					accent
				/>
				{mode === "signIn" ? (
					<TextLink
						label={t("auth.forgotPassword")}
						onPress={handleForgotPassword}
						disabled={busy}
					/>
				) : null}
			</View>
		</View>
	);
}

function TextLink({
	label,
	onPress,
	disabled,
	accent,
}: {
	label: string;
	onPress: () => void;
	disabled: boolean;
	accent?: boolean;
}) {
	return (
		<Pressable
			onPress={onPress}
			disabled={disabled}
			accessibilityRole="button"
			className="min-h-12 justify-center"
		>
			<Text
				className={
					accent
						? "font-semibold text-accent text-base"
						: "text-base text-foreground"
				}
			>
				{label}
			</Text>
		</Pressable>
	);
}
