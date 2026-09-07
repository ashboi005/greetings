import React, { useState } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator } from "react-native";
import { Button, Input, Label, Surface, TextField, useToast, Spinner } from "heroui-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { getLanguages, getRegions, updateProfile } from "@/lib/services";
import { useAuth } from "@/contexts/auth-context";
import { useRouter } from "expo-router";

export default function OnboardingScreen() {
	const { userProfile, refreshProfile } = useAuth();
	const router = useRouter();
	const { toast } = useToast();

	const [selectedLanguages, setSelectedLanguages] = useState<string[]>(
		userProfile?.languages || []
	);
	const [selectedRegion, setSelectedRegion] = useState<string>(
		userProfile?.regionCode || ""
	);
	const [displayName, setDisplayName] = useState(userProfile?.displayName || "");
	const [designation, setDesignation] = useState(userProfile?.designation || "");
	const [contactPhone, setContactPhone] = useState(
		userProfile?.contactPhone || userProfile?.phone || ""
	);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const { data: languages, isLoading: isLoadingLangs } = useQuery({
		queryKey: ["languages"],
		queryFn: getLanguages,
	});

	const { data: regions, isLoading: isLoadingRegions } = useQuery({
		queryKey: ["regions"],
		queryFn: getRegions,
	});

	const toggleLanguage = (code: string) => {
		if (selectedLanguages.includes(code)) {
			if (selectedLanguages.length === 1) {
				toast.show({
					variant: "danger",
					label: "Select at least 1 language",
				});
				return;
			}
			setSelectedLanguages(selectedLanguages.filter((c) => c !== code));
		} else {
			if (selectedLanguages.length >= 10) {
				toast.show({
					variant: "danger",
					label: "Maximum 10 languages allowed",
				});
				return;
			}
			setSelectedLanguages([...selectedLanguages, code]);
		}
	};

	const handleSubmit = async () => {
		if (!selectedRegion) {
			toast.show({
				variant: "danger",
				label: "Please select your state/region",
			});
			return;
		}

		if (selectedLanguages.length === 0) {
			toast.show({
				variant: "danger",
				label: "Please select at least one language",
			});
			return;
		}

		setIsSubmitting(true);
		try {
			await updateProfile({
				regionCode: selectedRegion,
				languages: selectedLanguages,
				displayName: displayName.trim() || undefined,
				designation: designation.trim() || undefined,
				contactPhone: contactPhone.trim() || undefined,
			});
			await refreshProfile();
			toast.show({
				variant: "success",
				label: "Profile saved successfully!",
			});
			router.replace("/(drawer)/(tabs)");
		} catch (err: any) {
			const message =
				err?.response?.data?.error?.message ||
				"Failed to update profile. Please check your selections.";
			toast.show({
				variant: "danger",
				label: message,
			});
		} finally {
			setIsSubmitting(false);
		}
	};

	if (isLoadingLangs || isLoadingRegions) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center bg-background">
				<ActivityIndicator size="large" />
				<Text className="mt-4 text-muted-foreground">Loading onboarding data...</Text>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView className="flex-1 bg-background">
			<ScrollView className="flex-1 px-5 py-6">
				<View className="mb-6">
					<Text className="text-2xl font-bold text-foreground">Welcome to Greetings</Text>
					<Text className="text-sm text-muted-foreground mt-1">
						Personalise your feed by choosing your preferred languages and region.
					</Text>
				</View>

				{/* 1. Language Selection */}
				<Surface variant="secondary" className="rounded-2xl p-5 mb-6">
					<Text className="text-base font-semibold text-foreground mb-1">
						1. Choose Languages
					</Text>
					<Text className="text-xs text-muted-foreground mb-4">
						Select languages for the greetings you want to see (Multi-select)
					</Text>

					<View className="flex-row flex-wrap gap-2">
						{languages?.map((lang) => {
							const isSelected = selectedLanguages.includes(lang.code);
							return (
								<Pressable
									key={lang.code}
									onPress={() => toggleLanguage(lang.code)}
									className={`px-4 py-2.5 rounded-full border ${
										isSelected
											? "bg-primary border-primary"
											: "bg-background border-border"
									}`}
								>
									<Text
										className={`font-medium ${
											isSelected ? "text-primary-foreground font-bold" : "text-foreground"
										}`}
									>
										{lang.nativeName} ({lang.name})
									</Text>
								</Pressable>
							);
						})}
					</View>
				</Surface>

				{/* 2. Region Selection */}
				<Surface variant="secondary" className="rounded-2xl p-5 mb-6">
					<Text className="text-base font-semibold text-foreground mb-1">
						2. Select Your Region / State
					</Text>
					<Text className="text-xs text-muted-foreground mb-4">
						Used to show local regional greetings and festivals
					</Text>

					<ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-row gap-2 py-1">
						{regions?.map((reg) => {
							const isSelected = selectedRegion === reg.code;
							return (
								<Pressable
									key={reg.code}
									onPress={() => setSelectedRegion(reg.code)}
									className={`px-4 py-2.5 rounded-xl border mr-2 ${
										isSelected
											? "bg-primary border-primary"
											: "bg-background border-border"
									}`}
								>
									<Text
										className={`font-medium ${
											isSelected ? "text-primary-foreground font-bold" : "text-foreground"
										}`}
									>
										{reg.name}
									</Text>
								</Pressable>
							);
						})}
					</ScrollView>
				</Surface>

				{/* 3. Personal Overlay Info */}
				<Surface variant="secondary" className="rounded-2xl p-5 mb-8">
					<Text className="text-base font-semibold text-foreground mb-1">
						3. Profile Details (Optional)
					</Text>
					<Text className="text-xs text-muted-foreground mb-4">
						These details will be printed when you share graphics with your branding.
					</Text>

					<View className="gap-4">
						<TextField>
							<Label>Display Name</Label>
							<Input
								value={displayName}
								onChangeText={setDisplayName}
								placeholder="e.g. Ramesh Kumar"
							/>
						</TextField>

						<TextField>
							<Label>Designation / Business Name</Label>
							<Input
								value={designation}
								onChangeText={setDesignation}
								placeholder="e.g. Property Consultant"
							/>
						</TextField>

						<TextField>
							<Label>Contact Phone Number (Printed on Card)</Label>
							<Input
								value={contactPhone}
								onChangeText={setContactPhone}
								placeholder="+91 98765 43210"
								keyboardType="phone-pad"
							/>
						</TextField>
					</View>
				</Surface>

				<Button onPress={handleSubmit} isDisabled={isSubmitting} className="mb-12">
					{isSubmitting ? (
						<Spinner size="sm" color="default" />
					) : (
						<Button.Label>Complete Onboarding & Go to Feed</Button.Label>
					)}
				</Button>
			</ScrollView>
		</SafeAreaView>
	);
}
