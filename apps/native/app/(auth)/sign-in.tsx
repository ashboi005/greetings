import React, { useState } from "react";
import { View, Text, Pressable, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { Button, Input, Label, Surface, TextField, Spinner, useToast } from "heroui-native";
import { useAuth } from "@/contexts/auth-context";
import { SafeAreaView } from "react-native-safe-area-context";

export default function SignInScreen() {
	const [idToken, setIdToken] = useState("");
	const [phoneNumber, setPhoneNumber] = useState("");
	const [otpCode, setOtpCode] = useState("");
	const [otpSent, setOtpSent] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const { signInWithFirebaseToken } = useAuth();
	const { toast } = useToast();

	const handleTokenSubmit = async () => {
		if (!idToken.trim()) {
			toast.show({
				variant: "danger",
				label: "Please enter a Firebase ID token",
			});
			return;
		}

		setIsSubmitting(true);
		try {
			await signInWithFirebaseToken(idToken.trim());
			toast.show({
				variant: "success",
				label: "Signed in successfully",
			});
		} catch (err: any) {
			const message = err?.response?.data?.error?.message || err.message || "Failed to verify token";
			toast.show({
				variant: "danger",
				label: message,
			});
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleSendOtp = () => {
		if (!phoneNumber.trim()) {
			toast.show({
				variant: "danger",
				label: "Enter phone number",
			});
			return;
		}
		// In production this triggers @react-native-firebase/auth signInWithPhoneNumber
		setOtpSent(true);
		toast.show({
			variant: "success",
			label: "OTP sent to " + phoneNumber,
		});
	};

	const handleVerifyOtp = async () => {
		if (!otpCode.trim()) {
			toast.show({
				variant: "danger",
				label: "Enter 6-digit OTP code",
			});
			return;
		}
		setIsSubmitting(true);
		try {
			// In production, confirm OTP with Firebase auth to get idToken
			// For dev/test, use the code as token if provided
			await signInWithFirebaseToken(otpCode.trim());
		} catch (err: any) {
			toast.show({
				variant: "danger",
				label: err?.response?.data?.error?.message || "Invalid OTP code",
			});
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<SafeAreaView style={{ flex: 1 }} className="bg-background">
			<KeyboardAvoidingView
				behavior={Platform.OS === "ios" ? "padding" : "height"}
				style={{ flex: 1 }}
			>
				<ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }} className="px-6 py-12">
					<View className="mb-8 items-center">
						<Text className="text-3xl font-bold text-foreground mb-2">Greetings</Text>
						<Text className="text-muted-foreground text-center">
							Sign in with your phone number to access personalised cards and designs
						</Text>
					</View>

					<Surface variant="secondary" className="rounded-2xl p-6 shadow-sm mb-6">
						<Text className="text-lg font-semibold text-foreground mb-4">
							Phone Sign In
						</Text>

						{!otpSent ? (
							<View className="gap-4">
								<TextField>
									<Label>Phone Number</Label>
									<Input
										value={phoneNumber}
										onChangeText={setPhoneNumber}
										placeholder="+91 98765 43210"
										keyboardType="phone-pad"
										autoComplete="tel"
									/>
								</TextField>
								<Button onPress={handleSendOtp} isDisabled={isSubmitting}>
									<Button.Label>Send OTP</Button.Label>
								</Button>
							</View>
						) : (
							<View className="gap-4">
								<TextField>
									<Label>Enter 6-digit OTP</Label>
									<Input
										value={otpCode}
										onChangeText={setOtpCode}
										placeholder="123456"
										keyboardType="number-pad"
										maxLength={6}
									/>
								</TextField>
								<Button onPress={handleVerifyOtp} isDisabled={isSubmitting}>
									{isSubmitting ? (
										<Spinner size="sm" color="default" />
									) : (
										<Button.Label>Verify OTP & Sign In</Button.Label>
									)}
								</Button>
								<Pressable onPress={() => setOtpSent(false)}>
									<Text className="text-center text-sm text-primary">
										Change phone number
									</Text>
								</Pressable>
							</View>
						)}
					</Surface>

					<Surface variant="secondary" className="rounded-2xl p-6 shadow-sm">
						<Text className="text-sm font-semibold text-muted-foreground mb-3">
							Developer Token Sign In (Firebase ID Token)
						</Text>
						<View className="gap-4">
							<TextField>
								<Label>Firebase ID Token</Label>
								<Input
									value={idToken}
									onChangeText={setIdToken}
									placeholder="Paste Firebase ID Token..."
									multiline
									numberOfLines={3}
									autoCapitalize="none"
								/>
							</TextField>
							<Button onPress={handleTokenSubmit} isDisabled={isSubmitting} variant="secondary">
								{isSubmitting ? (
									<Spinner size="sm" color="default" />
								) : (
									<Button.Label>Verify & Authenticate</Button.Label>
								)}
							</Button>
						</View>
					</Surface>
				</ScrollView>
			</KeyboardAvoidingView>
		</SafeAreaView>
	);
}
