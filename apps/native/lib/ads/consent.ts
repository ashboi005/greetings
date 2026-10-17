/**
 * Consent, then ads and analytics — in that order, once per launch.
 *
 *   1. Google UMP: shows the consent form where the law requires one (EEA,
 *      UK, and wherever Google adds next) and is a silent no-op elsewhere —
 *      which is most of this app's audience in India.
 *   2. iOS App Tracking Transparency, after UMP, as Google recommends. Without
 *      it iOS serves untargeted ads that earn very little.
 *   3. Start the Mobile Ads SDK, and analytics with the consent just gathered.
 *
 * Nothing waits on this. The app renders immediately; the banner reserves its
 * space and fills when `canRequestAds` flips, and the interstitial is simply
 * not ready yet. Every failure path ends with ads off and the app working.
 */

import {
	getTrackingPermissionsAsync,
	requestTrackingPermissionsAsync,
} from "expo-tracking-transparency";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import mobileAds, {
	AdsConsent,
	AdsConsentPrivacyOptionsRequirementStatus,
} from "react-native-google-mobile-ads";

import { startAnalytics } from "@/lib/analytics";

interface AdsState {
	/** Whether the consent flow has finished (either way). */
	settled: boolean;
	/** Whether ads may be requested at all. */
	canRequestAds: boolean;
	/** Whether to show a "Privacy choices" entry (UMP says the law needs one). */
	privacyOptionsRequired: boolean;
}

let state: AdsState = {
	settled: false,
	canRequestAds: false,
	privacyOptionsRequired: false,
};
const listeners = new Set<() => void>();

function setState(next: Partial<AdsState>) {
	state = { ...state, ...next };
	for (const listener of listeners) listener();
}

export function useAdsState(): AdsState {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => state,
	);
}

export function getAdsState(): AdsState {
	return state;
}

let started = false;

/** Runs the consent → ATT → SDK sequence. Safe to call more than once. */
export async function initAdsAndConsent(): Promise<void> {
	if (started) return;
	started = true;

	let canRequestAds = false;
	let privacyOptionsRequired = false;

	try {
		const info = await AdsConsent.gatherConsent();
		canRequestAds = info.canRequestAds;
		privacyOptionsRequired =
			info.privacyOptionsRequirementStatus ===
			AdsConsentPrivacyOptionsRequirementStatus.REQUIRED;
	} catch (cause) {
		// UMP itself failed (offline at first launch, usually). Google's guidance
		// is that a previous session's consent still stands, so ask it directly.
		try {
			const info = await AdsConsent.getConsentInfo();
			canRequestAds = info.canRequestAds;
		} catch {
			canRequestAds = false;
		}
		if (__DEV__) console.warn("[ads] consent", cause);
	}

	// Analytics consent follows the same answer. Outside UMP regions this is
	// `true`; inside them it is what the person chose.
	startAnalytics({
		analyticsAllowed: canRequestAds,
		adsAllowed: canRequestAds,
	});

	if (canRequestAds && Platform.OS === "ios") {
		try {
			const { status } = await getTrackingPermissionsAsync();
			if (status === "undetermined") await requestTrackingPermissionsAsync();
		} catch {
			// ATT unavailable (simulator, old iOS) — ads still serve, untargeted.
		}
	}

	if (canRequestAds) {
		try {
			await mobileAds().initialize();
		} catch (cause) {
			canRequestAds = false;
			if (__DEV__) console.warn("[ads] initialize", cause);
		}
	}

	setState({ settled: true, canRequestAds, privacyOptionsRequired });
}

/** Re-opens the consent choices. Shown in Profile only when UMP requires it. */
export async function showPrivacyOptions(): Promise<void> {
	try {
		const info = await AdsConsent.showPrivacyOptionsForm();
		setState({ canRequestAds: info.canRequestAds });
	} catch (cause) {
		if (__DEV__) console.warn("[ads] privacy options", cause);
	}
}
