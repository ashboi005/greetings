import { expoClient } from "@better-auth/expo/client";
import { env } from "@greetings/env/native";
import { createAuthClient } from "better-auth/react";
import Constants from "expo-constants";
import { tokenStorage } from "./storage";

export const authClient = createAuthClient({
	baseURL: env.EXPO_PUBLIC_SERVER_URL,
	plugins: [
		expoClient({
			scheme: Constants.expoConfig?.scheme as string,
			storagePrefix: Constants.expoConfig?.scheme as string,
			// biome-ignore lint/suspicious/noExplicitAny: Expo storage type cast
			storage: tokenStorage as any,
			// biome-ignore lint/suspicious/noExplicitAny: Expo client plugin type cast for better-auth
		}) as any,
	],
});
