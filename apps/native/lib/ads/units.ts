import { env } from "@greetings/env/native";
import { Platform } from "react-native";
import { TestIds } from "react-native-google-mobile-ads";

/**
 * Ad unit ids. A development build ALWAYS gets Google's test units, whatever
 * the environment says: tapping your own live ads is the fastest way to get an
 * AdMob account suspended, and a dev build is exactly where that happens.
 *
 * A release build without configured ids also falls back to test units, which
 * serve labelled test ads and earn nothing — visibly wrong, but never a policy
 * violation and never a crash.
 */
function pick(
	android: string | undefined,
	ios: string | undefined,
	test: string,
) {
	if (__DEV__) return test;
	return (Platform.OS === "ios" ? ios : android) ?? test;
}

export const AD_UNITS = {
	banner: pick(
		env.EXPO_PUBLIC_ADMOB_BANNER_ANDROID,
		env.EXPO_PUBLIC_ADMOB_BANNER_IOS,
		TestIds.ADAPTIVE_BANNER,
	),
	interstitial: pick(
		env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_ANDROID,
		env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_IOS,
		TestIds.INTERSTITIAL,
	),
};
