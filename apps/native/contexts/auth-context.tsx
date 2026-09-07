import { setUnauthenticatedHandler, TOKEN_STORAGE_KEY } from "@/lib/api";
import { tokenStorage } from "@/lib/storage";
import { authWithFirebase, getProfile } from "@/lib/services";
import type { UserProfile } from "@/lib/types";
import { useRouter, useSegments } from "expo-router";
import React, { createContext, useContext, useEffect, useState } from "react";

interface AuthContextType {
	token: string | null;
	userProfile: UserProfile | null;
	isLoading: boolean;
	signInWithFirebaseToken: (idToken: string) => Promise<void>;
	signOut: () => Promise<void>;
	refreshProfile: () => Promise<UserProfile | null>;
}

const AuthContext = createContext<AuthContextType>({
	token: null,
	userProfile: null,
	isLoading: true,
	signInWithFirebaseToken: async () => {},
	signOut: async () => {},
	refreshProfile: async () => null,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
	const [token, setToken] = useState<string | null>(null);
	const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const router = useRouter();
	const segments = useSegments();

	const handleSignOut = async () => {
		await tokenStorage.deleteItem(TOKEN_STORAGE_KEY);
		setToken(null);
		setUserProfile(null);
	};

	useEffect(() => {
		setUnauthenticatedHandler(() => {
			handleSignOut();
		});
	}, []);

	const refreshProfile = async (): Promise<UserProfile | null> => {
		try {
			const profile = await getProfile();
			setUserProfile(profile);
			return profile;
		} catch {
			return null;
		}
	};

	const signInWithFirebaseToken = async (idToken: string) => {
		setIsLoading(true);
		try {
			const authRes = await authWithFirebase(idToken);
			await tokenStorage.setItem(TOKEN_STORAGE_KEY, authRes.token);
			setToken(authRes.token);
			const profile = await refreshProfile();
			if (profile && !profile.onboarded) {
				router.replace("/(onboarding)");
			} else {
				router.replace("/(drawer)/(tabs)");
			}
		} finally {
			setIsLoading(false);
		}
	};

	useEffect(() => {
		async function initAuth() {
			try {
				const storedToken = await tokenStorage.getItem(TOKEN_STORAGE_KEY);
				if (storedToken) {
					setToken(storedToken);
					const profile = await refreshProfile();
					if (profile) {
						if (!profile.onboarded) {
							router.replace("/(onboarding)");
						}
					} else {
						await handleSignOut();
					}
				}
			} catch {
				await handleSignOut();
			} finally {
				setIsLoading(false);
			}
		}
		initAuth();
	}, []);

	return (
		<AuthContext.Provider
			value={{
				token,
				userProfile,
				isLoading,
				signInWithFirebaseToken,
				signOut: handleSignOut,
				refreshProfile,
			}}
		>
			{children}
		</AuthContext.Provider>
	);
}

export const useAuth = () => useContext(AuthContext);
