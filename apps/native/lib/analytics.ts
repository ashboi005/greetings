/**
 * Product analytics: Google Analytics (via Firebase) and Microsoft Clarity.
 *
 * One door for both, so a screen calls `track("share", {...})` once and never
 * imports either SDK. Both are client-side only — nothing here talks to our
 * API — and both answer *product* questions (where people drop off, what they
 * never find). Designer download counts come from the server's
 * `download_events`, never from here; if the two disagree, the server is right.
 * docs/mobile-integration.md §14.
 *
 * HARD RULE: no PII. No name, phone, email, contactPhone or logo URL — not as
 * an event param, not as a user property, not inside a screen name. The only
 * identifier ever sent is the opaque user id from `/v1/auth/me`. The event
 * types below are closed unions of booleans and enums for exactly this reason:
 * there is no string field a name could be dropped into by accident.
 *
 * Every call is best-effort and swallows its own failure. Analytics must never
 * be the reason an action fails.
 */

import { env } from "@greetings/env/native";
import * as Clarity from "@microsoft/react-native-clarity";
import {
	getAnalytics,
	logEvent,
	setAnalyticsCollectionEnabled,
	setConsent,
	setUserId,
} from "@react-native-firebase/analytics";

type SignInMethod = "phone" | "email" | "google";
type ShareSource = "feed" | "search" | "detail" | "history";

/** Every event the app sends, with its parameters. Add new ones here. */
export interface AnalyticsEvents {
	// Sign-in
	sign_in_method_selected: { method: SignInMethod };
	sign_in_succeeded: { method: SignInMethod; new_user: boolean };
	sign_in_failed: { method: SignInMethod };

	// App language (UI) — first screen
	app_language_selected: { language: "en" | "hi" };

	// Onboarding funnel. Abandonment is "started without completed".
	onboarding_started: Record<string, never>;
	onboarding_step_completed: { step: "languages" | "region" | "details" };
	onboarding_completed: { language_count: number; has_details: boolean };

	// Browsing
	/** A Categories tile; the category, never the tag's name or id. */
	category_opened: { category: "occasion" | "festival" | "theme" | "other" };
	search_performed: {
		has_query: boolean;
		has_tag: boolean;
		has_language: boolean;
	};
	content_opened: { source: ShareSource };

	// Saving and sharing
	image_saved: { customized: boolean; source: ShareSource };
	image_shared: { customized: boolean; source: ShareSource };
	customize_opened: { source: ShareSource };
	customize_exported: {
		action: "save" | "share";
		kept_designation: boolean;
		kept_phone: boolean;
		kept_logo: boolean;
		moved_text: boolean;
		changed_color: boolean;
		font: string;
	};
	content_reported: { reason: string };

	// My Designs
	design_created: Record<string, never>;
	design_saved: { has_image: boolean; element_count: number };
	design_image_added: Record<string, never>;
	design_exported: { action: "save" | "share" };

	// Profile
	profile_updated: { has_designation: boolean; has_phone: boolean };
	logo_uploaded: Record<string, never>;

	// Ads — without these an ad-revenue problem looks exactly like a loading bug.
	ad_interstitial_shown: { trigger: string };
	ad_interstitial_dismissed: { trigger: string };
	ad_interstitial_failed: {
		trigger: string;
		reason: "not_loaded" | "error" | "capped";
	};
	ad_banner_failed: { code: string };
}

let clarityStarted = false;

/** Called once at launch, after consent has been gathered (lib/ads/consent.ts). */
export function startAnalytics(options: {
	analyticsAllowed: boolean;
	adsAllowed: boolean;
}) {
	const { analyticsAllowed, adsAllowed } = options;

	void safely(async () => {
		const analytics = getAnalytics();
		await setConsent(analytics, {
			analytics_storage: analyticsAllowed,
			ad_storage: adsAllowed,
			ad_user_data: adsAllowed,
			ad_personalization: adsAllowed,
		});
		await setAnalyticsCollectionEnabled(analytics, analyticsAllowed);
	});

	const projectId = env.EXPO_PUBLIC_CLARITY_PROJECT_ID;
	if (projectId && analyticsAllowed && !clarityStarted) {
		safelySync(() => {
			// Masking is configured in the Clarity dashboard (Settings → Masking).
			// Keep it on "Strict": the profile and overlay screens show the user's
			// phone number, and relaxing it to debug a layout records real ones.
			Clarity.initialize(projectId, {
				logLevel: __DEV__ ? Clarity.LogLevel.Info : Clarity.LogLevel.None,
			});
			clarityStarted = true;
		});
		void safely(() => Clarity.consent(adsAllowed, analyticsAllowed));
	}
}

export function track<E extends keyof AnalyticsEvents>(
	event: E,
	...params: AnalyticsEvents[E] extends Record<string, never>
		? []
		: [AnalyticsEvents[E]]
) {
	void safely(() => logEvent(getAnalytics(), event, params[0] ?? {}));
	if (clarityStarted) void safely(() => Clarity.sendCustomEvent(event));
}

/**
 * A screen view. `name` must be a route *pattern* ("content_detail"), never a
 * route with ids or user values in it — see `screenNameFor` in app/_layout.tsx.
 */
export function trackScreen(name: string) {
	// `screen_view` through logEvent: RNFB deprecates logScreenView itself.
	void safely(() =>
		logEvent(getAnalytics(), "screen_view", {
			screen_name: name,
			screen_class: name,
		}),
	);
	if (clarityStarted) void safely(() => Clarity.setCurrentScreenName(name));
}

/** The opaque server user id, or null on sign-out. Never an email or phone. */
export function identify(userId: string | null) {
	void safely(() => setUserId(getAnalytics(), userId));
	if (clarityStarted && userId)
		void safely(() => Clarity.setCustomUserId(userId));
}

async function safely(fn: () => Promise<unknown>) {
	try {
		await fn();
	} catch (cause) {
		if (__DEV__) console.warn("[analytics]", cause);
	}
}

function safelySync(fn: () => void) {
	try {
		fn();
	} catch (cause) {
		if (__DEV__) console.warn("[analytics]", cause);
	}
}
