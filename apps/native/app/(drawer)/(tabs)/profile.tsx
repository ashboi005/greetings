import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import {
	Button,
	Input,
	Label,
	Spinner,
	Surface,
	TextField,
	useToast,
} from "heroui-native";
import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/contexts/auth-context";
import { apiErrorMessage } from "@/lib/api";
import { getLanguages, getRegions, updateProfile } from "@/lib/services";

export default function ProfileScreen() {
	const { userProfile, signOut, refreshProfile } = useAuth();
	const { toast } = useToast();

	const [displayName, setDisplayName] = useState(
		userProfile?.displayName || "",
	);
	const [designation, setDesignation] = useState(
		userProfile?.designation || "",
	);
	const [contactPhone, setContactPhone] = useState(
		userProfile?.contactPhone || "",
	);
	const [selectedRegion, setSelectedRegion] = useState(
		userProfile?.regionCode || "",
	);
	const [selectedLanguages, setSelectedLanguages] = useState<string[]>(
		userProfile?.languages || [],
	);
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
		} catch (cause) {
			toast.show({
				variant: "danger",
				label: apiErrorMessage(cause, "Failed to update profile"),
			});
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<SafeAreaView className="flex-1 bg-background" edges={["top"]}>
			<View className="flex-row items-center justify-between border-border/30 border-b px-4 py-3">
				<Text className="font-bold text-foreground text-xl">
					Profile & Settings
				</Text>
				{/* No navigation here: clearing the session moves the guard in
				    auth-context to the sign-in screen on its own. */}
				<Pressable onPress={() => void signOut()}>
					<Ionicons name="log-out-outline" size={22} color="#EF4444" />
				</Pressable>
			</View>

			<ScrollView className="flex-1 px-4 py-5">
				{/* Avatar & Header */}
				<Surface
					variant="secondary"
					className="mb-6 items-center rounded-2xl p-5"
				>
					<View className="mb-3 h-20 w-20 items-center justify-center rounded-full bg-primary/10">
						{userProfile?.avatarUrl ? (
							<Image
								source={{ uri: userProfile.avatarUrl }}
								className="h-20 w-20 rounded-full"
							/>
						) : (
							<Ionicons name="person-outline" size={36} color="#6366F1" />
						)}
					</View>
					<Text className="font-bold text-foreground text-lg">
						{userProfile?.displayName || "User"}
					</Text>
					<Text className="mt-0.5 text-muted-foreground text-xs">
						{userProfile?.phone || "Phone User"}
					</Text>
				</Surface>

				{/* Profile Editing Form */}
				<Surface variant="secondary" className="mb-6 rounded-2xl p-5">
					<Text className="mb-4 font-semibold text-base text-foreground">
						Edit Profile Info
					</Text>

					<View className="gap-4">
						<TextField>
							<Label>Display Name</Label>
							<Input
								value={displayName}
								onChangeText={setDisplayName}
								placeholder="Your Name"
							/>
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
				<Surface variant="secondary" className="mb-6 rounded-2xl p-5">
					<Text className="mb-3 font-semibold text-base text-foreground">
						Region / State
					</Text>
					<ScrollView
						horizontal
						showsHorizontalScrollIndicator={false}
						className="flex-row gap-2 py-1"
					>
						{regions?.map((reg) => {
							const isSelected = selectedRegion === reg.code;
							return (
								<Pressable
									key={reg.code}
									onPress={() => setSelectedRegion(reg.code)}
									className={`mr-2 rounded-xl border px-4 py-2.5 ${
										isSelected
											? "border-primary bg-primary"
											: "border-border bg-background"
									}`}
								>
									<Text
										className={`font-medium ${
											isSelected
												? "font-bold text-primary-foreground"
												: "text-foreground"
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
				<Surface variant="secondary" className="mb-8 rounded-2xl p-5">
					<Text className="mb-3 font-semibold text-base text-foreground">
						Languages
					</Text>
					<View className="flex-row flex-wrap gap-2">
						{languages?.map((lang) => {
							const isSelected = selectedLanguages.includes(lang.code);
							return (
								<Pressable
									key={lang.code}
									onPress={() => toggleLanguage(lang.code)}
									className={`rounded-full border px-3 py-2 ${
										isSelected
											? "border-primary bg-primary"
											: "border-border bg-background"
									}`}
								>
									<Text
										className={`text-xs ${isSelected ? "font-bold text-primary-foreground" : "text-foreground"}`}
									>
										{lang.nativeName} ({lang.name})
									</Text>
								</Pressable>
							);
						})}
					</View>
				</Surface>

				<Button
					onPress={handleSaveProfile}
					isDisabled={isSubmitting}
					className="mb-12"
				>
					{isSubmitting ? (
						<Spinner size="sm" color="default" />
					) : (
						<Button.Label>Save Changes</Button.Label>
					)}
				</Button>
			</ScrollView>
		</SafeAreaView>
	);
}
