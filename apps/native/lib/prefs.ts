import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Small device-local preferences: UI language, theme, ad pacing counters.
 *
 * Synchronous on purpose. These are read during the first render — the UI
 * language and theme in particular — and an async read would paint one frame
 * in the wrong language before correcting itself. SecureStore's sync API is
 * fine for a handful of short strings; nothing here is large or hot.
 *
 * Never put anything here that should follow the user to another device —
 * that belongs on the server. And never the session token: that has its own
 * home in lib/storage.ts.
 */

const PREFIX = "greetings_pref_";

type PrefKey =
	| "appLanguage"
	| "theme"
	| "adActionCount"
	| "adLastInterstitialAt";

export function getPref(key: PrefKey): string | null {
	try {
		if (Platform.OS === "web") {
			return globalThis.localStorage?.getItem(PREFIX + key) ?? null;
		}
		return SecureStore.getItem(PREFIX + key);
	} catch {
		return null;
	}
}

export function setPref(key: PrefKey, value: string | null): void {
	try {
		if (Platform.OS === "web") {
			if (value === null) globalThis.localStorage?.removeItem(PREFIX + key);
			else globalThis.localStorage?.setItem(PREFIX + key, value);
			return;
		}
		if (value === null) void SecureStore.deleteItemAsync(PREFIX + key);
		else SecureStore.setItem(PREFIX + key, value);
	} catch {
		// A preference that fails to persist costs one re-ask next launch.
	}
}
