import { Ionicons } from "@expo/vector-icons";
import {
	Description,
	FieldError,
	Input,
	Label,
	TextField,
	useThemeColor,
} from "heroui-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, type TextInput, View } from "react-native";

import { ActionButton } from "@/components/ui/action-button";
import { useAuth } from "@/contexts/auth-context";
import { track } from "@/lib/analytics";
import {
	type PendingVerification,
	sendVerificationCode,
	toE164,
} from "@/lib/firebase";
import { useT } from "@/lib/i18n";
import { useAuthError } from "./use-auth-error";

/**
 * Phone sign-in: number, then the code.
 *
 * Both steps in one component rather than two routes — the number and the code
 * are one thought, and a back gesture between them would strand a Firebase
 * confirmation handle that only lives in memory.
 *
 * Note this needs per-platform setup before it sends a real SMS; see the
 * TODO(phone-native-setup) block in lib/firebase.ts. Firebase's test numbers
 * work today.
 */

const CODE_LENGTH = 6;

/** Seconds before a new code may be requested. */
const RESEND_COOLDOWN_SECONDS = 30;

export function PhoneSignIn() {
	const { signInWithFirebaseToken, isSigningIn } = useAuth();
	const t = useT();
	const authError = useAuthError();
	const [foreground, accent, muted] = useThemeColor([
		"foreground",
		"accent",
		"muted",
	]);

	const [phoneInput, setPhoneInput] = useState("");
	const [code, setCode] = useState("");
	const [pending, setPending] = useState<PendingVerification | null>(null);
	const [isSending, setIsSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [cooldown, setCooldown] = useState(0);

	const codeInputRef = useRef<TextInput>(null);

	useEffect(() => {
		if (cooldown <= 0) return;
		const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
		return () => clearTimeout(timer);
	}, [cooldown]);

	const busy = isSending || isSigningIn;

	const handleSendCode = async () => {
		const e164 = toE164(phoneInput);
		if (!e164) {
			setError(t("auth.phoneInvalid"));
			return;
		}

		track("sign_in_method_selected", { method: "phone" });
		setError(null);
		setIsSending(true);
		try {
			const verification = await sendVerificationCode(e164);
			setPending(verification);
			setCode("");
			setCooldown(RESEND_COOLDOWN_SECONDS);
			// The code field is not mounted until `pending` is set, so focusing it
			// has to wait for that render to commit.
			requestAnimationFrame(() => codeInputRef.current?.focus());
		} catch (cause) {
			track("sign_in_failed", { method: "phone" });
			setError(authError(cause));
		} finally {
			setIsSending(false);
		}
	};

	const handleVerify = async () => {
		if (!pending) return;

		if (code.trim().length !== CODE_LENGTH) {
			setError(t("auth.codeIncomplete", { length: CODE_LENGTH }));
			return;
		}

		setError(null);
		try {
			// Firebase authenticates; the context trades the ID token for our
			// session and routes onward, so there is nothing to do on success.
			const idToken = await pending.confirm(code.trim());
			await signInWithFirebaseToken(idToken, "phone");
		} catch (cause) {
			track("sign_in_failed", { method: "phone" });
			setError(authError(cause));
			setCode("");
		}
	};

	const handleChangeNumber = () => {
		setPending(null);
		setCode("");
		setError(null);
		setCooldown(0);
	};

	if (pending === null) {
		return (
			<View className="gap-5">
				<TextField isInvalid={Boolean(error)}>
					<Label>{t("auth.phoneLabel")}</Label>
					<Input
						value={phoneInput}
						onChangeText={(next) => {
							setPhoneInput(next);
							setError(null);
						}}
						placeholder="98765 43210"
						keyboardType="phone-pad"
						autoComplete="tel"
						textContentType="telephoneNumber"
						returnKeyType="go"
						onSubmitEditing={handleSendCode}
						editable={!busy}
						className="text-lg"
					/>
					<Description className="text-sm">{t("auth.phoneHint")}</Description>
					<FieldError>{error}</FieldError>
				</TextField>

				<ActionButton
					label={t("auth.sendCode")}
					icon="chatbubble-ellipses-outline"
					onPress={handleSendCode}
					isLoading={isSending}
					isDisabled={busy}
				/>
			</View>
		);
	}

	return (
		<View className="gap-5">
			<Text className="text-base text-muted">
				{t("auth.codeSentTo", { phone: pending.phoneNumber })}
			</Text>

			<TextField isInvalid={Boolean(error)}>
				<Label>{t("auth.codeLabel", { length: CODE_LENGTH })}</Label>
				<Input
					ref={codeInputRef}
					value={code}
					onChangeText={(next) => {
						setCode(next.replace(/\D/g, "").slice(0, CODE_LENGTH));
						setError(null);
					}}
					placeholder="123456"
					keyboardType="number-pad"
					autoComplete="sms-otp"
					textContentType="oneTimeCode"
					maxLength={CODE_LENGTH}
					editable={!busy}
					className="text-center text-2xl tracking-[8px]"
				/>
				<FieldError>{error}</FieldError>
			</TextField>

			<ActionButton
				label={t("auth.verify")}
				icon="checkmark-circle-outline"
				onPress={handleVerify}
				isLoading={isSigningIn}
				isDisabled={busy}
			/>

			<View className="flex-row items-center justify-between">
				<Pressable
					onPress={handleChangeNumber}
					disabled={busy}
					accessibilityRole="button"
					className="min-h-12 flex-row items-center gap-1"
				>
					<Ionicons name="chevron-back" size={18} color={foreground} />
					<Text className="text-base text-foreground">
						{t("auth.changeNumber")}
					</Text>
				</Pressable>

				<Pressable
					onPress={handleSendCode}
					disabled={busy || cooldown > 0}
					accessibilityRole="button"
					className="min-h-12 flex-row items-center gap-1"
				>
					<Ionicons
						name="refresh"
						size={18}
						color={cooldown > 0 ? muted : accent}
					/>
					<Text
						className={
							cooldown > 0
								? "text-base text-muted"
								: "font-semibold text-accent text-base"
						}
					>
						{cooldown > 0
							? t("auth.resendIn", { seconds: cooldown })
							: t("auth.resend")}
					</Text>
				</Pressable>
			</View>
		</View>
	);
}
