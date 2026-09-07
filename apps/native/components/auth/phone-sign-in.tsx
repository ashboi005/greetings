import { Ionicons } from "@expo/vector-icons";
import {
	Button,
	FieldError,
	Input,
	Label,
	Spinner,
	TextField,
	useThemeColor,
} from "heroui-native";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, type TextInput, View } from "react-native";

import { useAuth } from "@/contexts/auth-context";
import { authErrorMessage } from "@/lib/auth-errors";
import {
	type PendingVerification,
	sendVerificationCode,
	toE164,
} from "@/lib/firebase";

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
	const mutedColor = useThemeColor("muted");

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
			setError("Enter a 10-digit mobile number, or a full +country number.");
			return;
		}

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
			setError(authErrorMessage(cause));
		} finally {
			setIsSending(false);
		}
	};

	const handleVerify = async () => {
		if (!pending) return;

		if (code.trim().length !== CODE_LENGTH) {
			setError(`Enter the ${CODE_LENGTH}-digit code.`);
			return;
		}

		setError(null);
		try {
			// Firebase authenticates; the context trades the ID token for our
			// session and routes onward, so there is nothing to do on success.
			const idToken = await pending.confirm(code.trim());
			await signInWithFirebaseToken(idToken);
		} catch (cause) {
			setError(authErrorMessage(cause));
			setCode("");
		}
	};

	const handleChangeNumber = () => {
		setPending(null);
		setCode("");
		setError(null);
		setCooldown(0);
	};

	return (
		<View>
			<FieldError isInvalid={!!error} className="mb-3">
				{error}
			</FieldError>

			{pending === null ? (
				<View className="gap-4">
					<TextField>
						<Label>Phone number</Label>
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
						/>
					</TextField>

					<Text className="text-muted-foreground text-xs">
						Indian numbers need no country code. For anywhere else, start with
						+.
					</Text>

					<Button onPress={handleSendCode} isDisabled={busy}>
						{isSending ? (
							<Spinner size="sm" color="default" />
						) : (
							<Button.Label>Send code</Button.Label>
						)}
					</Button>
				</View>
			) : (
				<View className="gap-4">
					<Text className="text-muted-foreground text-sm">
						Code sent to {pending.phoneNumber}
					</Text>

					<TextField>
						<Label>{CODE_LENGTH}-digit code</Label>
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
						/>
					</TextField>

					<Button onPress={handleVerify} isDisabled={busy}>
						{isSigningIn ? (
							<Spinner size="sm" color="default" />
						) : (
							<Button.Label>Verify and sign in</Button.Label>
						)}
					</Button>

					<View className="flex-row items-center justify-between">
						<Pressable onPress={handleChangeNumber} disabled={busy}>
							<View className="flex-row items-center gap-1">
								<Ionicons name="chevron-back" size={14} color={mutedColor} />
								<Text className="text-muted-foreground text-sm">
									Change number
								</Text>
							</View>
						</Pressable>

						<Pressable onPress={handleSendCode} disabled={busy || cooldown > 0}>
							<Text
								className={
									cooldown > 0
										? "text-muted-foreground text-sm"
										: "text-primary text-sm"
								}
							>
								{cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
							</Text>
						</Pressable>
					</View>
				</View>
			)}
		</View>
	);
}
