import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const TOKEN_STORAGE_KEY = "greetings_session_token";

const memoryStore = new Map<string, string>();

export const tokenStorage = {
	async getItem(key: string): Promise<string | null> {
		if (Platform.OS === "web") {
			try {
				return typeof window !== "undefined"
					? localStorage.getItem(key)
					: memoryStore.get(key) || null;
			} catch {
				return memoryStore.get(key) || null;
			}
		}
		try {
			const isAvailable = await SecureStore.isAvailableAsync();
			if (isAvailable) {
				return await SecureStore.getItemAsync(key);
			}
		} catch {
			// Fallback
		}
		return memoryStore.get(key) || null;
	},

	async setItem(key: string, value: string): Promise<void> {
		memoryStore.set(key, value);
		if (Platform.OS === "web") {
			try {
				if (typeof window !== "undefined") {
					localStorage.setItem(key, value);
				}
			} catch {
				// Ignore quota or web restriction errors
			}
			return;
		}
		try {
			const isAvailable = await SecureStore.isAvailableAsync();
			if (isAvailable) {
				await SecureStore.setItemAsync(key, value);
			}
		} catch {
			// Fallback
		}
	},

	async deleteItem(key: string): Promise<void> {
		memoryStore.delete(key);
		if (Platform.OS === "web") {
			try {
				if (typeof window !== "undefined") {
					localStorage.removeItem(key);
				}
			} catch {
				// Ignore error
			}
			return;
		}
		try {
			const isAvailable = await SecureStore.isAvailableAsync();
			if (isAvailable) {
				await SecureStore.deleteItemAsync(key);
			}
		} catch {
			// Fallback
		}
	},
};
