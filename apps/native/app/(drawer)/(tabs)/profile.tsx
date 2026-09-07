import React, { useState, useEffect } from "react";
import {
	View,
	Text,
	ScrollView,
	Image,
	Pressable,
	ActivityIndicator,
	Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/contexts/auth-context";
import { useQuery } from "@tanstack/react-query";
import { getLanguages, getRegions, updateProfile } from "@/lib/services";
import { Button, Surface, TextField, Label, Input, useToast, Spinner } from "heroui-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

export default function ProfileScreen() {
	const { userProfile, signOut, refreshProfile } = useAuth();
	const router = useRouter();
	const { toast } = useToast();

	const [displayName, setDisplayName] = useState(userProfile?.displayName || "");
	const [designation, setDesignation] = useState(userProfile?.designation || "");
	const [contactPhone, setContactPhone] = useState(userProfile?.contactPhone || "");
	const [selectedRegion, setSelectedRegion] = useState(userProfile?.regionCode || "");
	const [selectedLanguages, setSelectedLanguages] = useState<string[]>(userProfile?.languages || []);
	const [isSubmitting, setIsSubmitting] = useState(false);

	useEffect(() => {
		if (userProfile) {
			setDisplayName(userProfile.displayName || "");
			setDesignation(userProfile.designation || "");
			setContactPhone(userProfile.contactPhone || "");
			setSelectedRegion(userProfile.regionCode || "");
			setSelectedLanguages(userProfile.languages || []);
		}
	}, [userProfile]);

	const { data: languages } = useQuery({
		queryKey: ["languages"],
		queryFn: () => getLanguages(),
	});

	const { data: regions } = useQuery({
		queryKey: ["regions"],
		queryFn: () => getRegions(),
	});

	const toggleLanguage = (code: string) => {
		if (selectedLanguages.includes(code)) {
			if (selectedLanguages.length === 1) {
				toast.show({
					variant: "danger",
					label: "Must keep at least 1 language",
				});
				return;
			}
			setSelectedLanguages(selectedLanguages.filter((c) => c !== code));
		} else {
			setSelectedLanguages([...selectedLanguages, code]);
		}
	};

	const handleSaveProfile = async () => {
		if (!selectedRegion) {
			toast.show({
				variant: "danger",
				label: "Region is required",
			});
			return;
		}

		setIsSubmitting(true);
		try {
			// PUT is a full replacement! Always submit all fields
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
				label: "Profile updated successfully!",
			});
		} catch (err: any) {
			toast.show({
				variant: "danger",
				label: err?.response?.data?.error?.message || "Failed to update profile",
			});
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<SafeAreaView className="flex-1 bg-background" edges={["top"]}>
			<View className="px-4 py-3 border-b border-border/30 flex-row items-center justify-between">
				<Text className="text-xl font-bold text-foreground">Profile & Settings</Text>
				<Pressable
					onPress={async () => {
						await signOut();
						router.replace("/(auth)/sign-in");
					}}
				>
					<Ionicons name="log-out-outline" size={22} color="#EF4444" />
				</Pressable>
			</View>

			<ScrollView className="flex-1 px-4 py-5">
				{/* Avatar & Header */}
				<Surface variant="secondary" className="rounded-2xl p-5 mb-6 items-center">
					<View className="w-20 h-20 rounded-full bg-primary/10 items-center justify-center mb-3">
						{userProfile?.avatarUrl ? (
							<Image source={{ uri: userProfile.avatarUrl }} className="w-20 h-20 rounded-full" />
						) : (
							<Ionicons name="person-outline" size={36} color="#6366F1" />
						)}
					</View>
					<Text className="text-lg font-bold text-foreground">
						{userProfile?.displayName || "User"}
					</Text>
					<Text className="text-xs text-muted-foreground mt-0.5">
						{userProfile?.phone || "Phone User"}
					</Text>
				</Surface>

				{/* Profile Editing Form */}
				<Surface variant="secondary" className="rounded-2xl p-5 mb-6">
					<Text className="text-base font-semibold text-foreground mb-4">Edit Profile Info</Text>

					<View className="gap-4">
						<TextField>
							<Label>Display Name</Label>
							<Input value={displayName} onChangeText={setDisplayName} placeholder="Your Name" />
						</TextField>

						<TextField>
							<Label>Designation / Business Title</Label>
							<Input
								value={designation}
								onChangeText={setDesignation}
								placeholder="e.g. Property Consultant"
							/>
						</TextField>

						<TextField>
							<Label>Contact Phone Number (Printed)</Label>
							<Input
								value={contactPhone}
								onChangeText={setContactPhone}
								placeholder="+91 98765 43210"
								keyboardType="phone-pad"
							/>
						</TextField>
					</View>
				</Surface>

				{/* Region Selection */}
				<Surface variant="secondary" className="rounded-2xl p-5 mb-6">
					<Text className="text-base font-semibold text-foreground mb-3">Region / State</Text>
					<ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-row gap-2 py-1">
						{regions?.map((reg) => {
							const isSelected = selectedRegion === reg.code;
							return (
								<Pressable
									key={reg.code}
									onPress={() => setSelectedRegion(reg.code)}
									className={`px-4 py-2.5 rounded-xl border mr-2 ${
										isSelected ? "bg-primary border-primary" : "bg-background border-border"
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

				{/* Languages */}
				<Surface variant="secondary" className="rounded-2xl p-5 mb-8">
					<Text className="text-base font-semibold text-foreground mb-3">Languages</Text>
					<View className="flex-row flex-wrap gap-2">
						{languages?.map((lang) => {
							const isSelected = selectedLanguages.includes(lang.code);
							return (
								<Pressable
									key={lang.code}
									onPress={() => toggleLanguage(lang.code)}
									className={`px-3 py-2 rounded-full border ${
										isSelected ? "bg-primary border-primary" : "bg-background border-border"
									}`}
								>
									<Text className={`text-xs ${isSelected ? "text-primary-foreground font-bold" : "text-foreground"}`}>
										{lang.nativeName} ({lang.name})
									</Text>
								</Pressable>
							);
						})}
					</View>
				</Surface>

				<Button onPress={handleSaveProfile} isDisabled={isSubmitting} className="mb-12">
					{isSubmitting ? <Spinner size="sm" color="default" /> : <Button.Label>Save Changes</Button.Label>}
				</Button>
			</ScrollView>
		</SafeAreaView>
	);
}
