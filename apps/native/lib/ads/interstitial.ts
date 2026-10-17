/**
 * The interstitial shown before a save, share or customise.
 *
 * Four rules, and they protect the AdMob account rather than express taste
 * (docs/mobile-integration.md §15):
 *
 *   1. Paced. Never on the first actions after install, and never more often
 *      than once per MIN_INTERVAL. An ad before every download punishes the
 *      older users this app is for, and reads as abuse to AdMob.
 *   2. Never blocks the action. Not loaded, failed, capped, consent missing —
 *      all of them resolve immediately and the save goes ahead.
 *   3. Preloaded. Requesting at tap time means the user stares at nothing; one
 *      ad is always loading in the background once consent allows it.
 *   4. Never near the canvas. Callers show it *before* entering an editor or
 *      after leaving one, never while it is open.
 */

import { AdEventType, InterstitialAd } from "react-native-google-mobile-ads";

import { track } from "@/lib/analytics";
import { getPref, setPref } from "@/lib/prefs";
import { getAdsState } from "./consent";
import { AD_UNITS } from "./units";

/** Actions after install that never see an interstitial. */
const AD_FREE_ACTIONS = 3;
/** Minimum gap between two interstitials. */
const MIN_INTERVAL_MS = 4 * 60 * 1000;
/** If the ad never reports closing, stop waiting and carry on. */
const SHOW_TIMEOUT_MS = 90 * 1000;

let ad: InterstitialAd | null = null;
let loaded = false;
let loading = false;

function ensureLoading() {
	if (!getAdsState().canRequestAds || loaded || loading) return;

	if (!ad) {
		ad = InterstitialAd.createForAdRequest(AD_UNITS.interstitial);
		ad.addAdEventListener(AdEventType.LOADED, () => {
			loaded = true;
			loading = false;
		});
		ad.addAdEventListener(AdEventType.ERROR, () => {
			loaded = false;
			loading = false;
		});
	}

	loading = true;
	try {
		ad.load();
	} catch {
		loading = false;
	}
}

/** Starts the first load. Called once consent allows ads. */
export function preloadInterstitial() {
	ensureLoading();
}

/**
 * Shows an interstitial if this action is due one, and resolves when the
 * person may continue. Always resolves; never rejects.
 *
 * `trigger` names the action for analytics ("save", "share", "customize").
 */
export async function maybeShowInterstitial(trigger: string): Promise<void> {
	const actions = Number(getPref("adActionCount") ?? "0") + 1;
	setPref("adActionCount", String(actions));

	if (!getAdsState().canRequestAds) return;

	const lastShown = Number(getPref("adLastInterstitialAt") ?? "0");
	const due =
		actions > AD_FREE_ACTIONS && Date.now() - lastShown >= MIN_INTERVAL_MS;

	if (!due) {
		ensureLoading();
		return;
	}

	if (!ad || !loaded) {
		track("ad_interstitial_failed", { trigger, reason: "not_loaded" });
		ensureLoading();
		return;
	}

	const current = ad;
	loaded = false;

	await new Promise<void>((resolve) => {
		let finished = false;
		const unsubscribers: (() => void)[] = [];
		const finish = () => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			for (const off of unsubscribers) off();
			resolve();
		};
		const timer = setTimeout(finish, SHOW_TIMEOUT_MS);

		unsubscribers.push(
			current.addAdEventListener(AdEventType.CLOSED, () => {
				track("ad_interstitial_dismissed", { trigger });
				finish();
			}),
			current.addAdEventListener(AdEventType.ERROR, () => {
				track("ad_interstitial_failed", { trigger, reason: "error" });
				finish();
			}),
		);

		current
			.show()
			.then(() => {
				setPref("adLastInterstitialAt", String(Date.now()));
				track("ad_interstitial_shown", { trigger });
			})
			.catch(() => {
				track("ad_interstitial_failed", { trigger, reason: "error" });
				finish();
			});
	});

	// The next one starts loading as soon as this one is gone.
	ensureLoading();
}
