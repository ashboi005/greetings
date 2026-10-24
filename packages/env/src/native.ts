import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Everything the app reads at runtime. `EXPO_PUBLIC_` values are inlined into
 * the JS bundle at build time, so none of these may be secret — and none are:
 * a Clarity project id and AdMob unit ids are printed in every APK anyway.
 *
 * Only the server URL is required (and even that has a default). Everything
 * else is optional so that a fresh clone builds and runs: without a Clarity id
 * Clarity simply does not start, and without AdMob unit ids the app serves
 * Google's test ads. See apps/native/.env.example.
 */
export const env = createEnv({
	clientPrefix: "EXPO_PUBLIC_",
	client: {
		EXPO_PUBLIC_SERVER_URL: z
			.string()
			.url()
			.default("https://greetings-api.ashwathsoni.dev"),

		/** Microsoft Clarity project id (Clarity → Settings → Overview). */
		EXPO_PUBLIC_CLARITY_PROJECT_ID: z.string().min(1).optional(),

		/**
		 * AdMob ad unit ids. Release builds only — a dev build always uses
		 * Google's test units, whatever is set here, because tapping your own
		 * live ads is the quickest way to get an AdMob account suspended.
		 */
		EXPO_PUBLIC_ADMOB_BANNER_ANDROID: z.string().min(1).optional(),
		EXPO_PUBLIC_ADMOB_BANNER_IOS: z.string().min(1).optional(),
		EXPO_PUBLIC_ADMOB_INTERSTITIAL_ANDROID: z.string().min(1).optional(),
		EXPO_PUBLIC_ADMOB_INTERSTITIAL_IOS: z.string().min(1).optional(),

		/** Shown in Profile → About. Both stores and AdMob require one. */
		EXPO_PUBLIC_PRIVACY_POLICY_URL: z.string().url().optional(),
	},
	runtimeEnv: {
		// Spelled out rather than `process.env`: Expo only inlines
		// `process.env.EXPO_PUBLIC_X` written literally, so passing the whole
		// object would leave every value undefined in a release bundle.
		EXPO_PUBLIC_SERVER_URL: process.env.EXPO_PUBLIC_SERVER_URL,
		EXPO_PUBLIC_CLARITY_PROJECT_ID: process.env.EXPO_PUBLIC_CLARITY_PROJECT_ID,
		EXPO_PUBLIC_ADMOB_BANNER_ANDROID:
			process.env.EXPO_PUBLIC_ADMOB_BANNER_ANDROID,
		EXPO_PUBLIC_ADMOB_BANNER_IOS: process.env.EXPO_PUBLIC_ADMOB_BANNER_IOS,
		EXPO_PUBLIC_ADMOB_INTERSTITIAL_ANDROID:
			process.env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_ANDROID,
		EXPO_PUBLIC_ADMOB_INTERSTITIAL_IOS:
			process.env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_IOS,
		EXPO_PUBLIC_PRIVACY_POLICY_URL: process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL,
	},
	emptyStringAsUndefined: true,
});
