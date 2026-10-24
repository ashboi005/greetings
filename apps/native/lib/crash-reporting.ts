/**
 * Crash reporting: Firebase Crashlytics.
 *
 * Crashes that kill the app (native, and unhandled JS errors in a release
 * build) are reported by the SDK on its own. This module covers the rest:
 * errors something caught — the root error boundary — which would otherwise
 * vanish silently.
 *
 * Same PII rule as lib/analytics.ts: the only identifier is the opaque user id,
 * and nothing a user typed goes into a log line. Collection settings live in
 * firebase.json; development builds do not report.
 */

import {
	getCrashlytics,
	recordError,
	setUserId,
} from "@react-native-firebase/crashlytics";

/** Reports an error that was caught, so it still reaches the dashboard. */
export function reportError(error: unknown, where: string) {
	try {
		const asError = error instanceof Error ? error : new Error(String(error));
		recordError(getCrashlytics(), asError, where);
	} catch {
		// Reporting must never be the thing that fails.
	}
}

/** Ties crash reports to the opaque server user id. Never an email or phone. */
export function setCrashUser(userId: string | null) {
	try {
		// Crashlytics has no "unset"; an empty id is its sign-out.
		void setUserId(getCrashlytics(), userId ?? "").catch(() => {});
	} catch {
		// As above.
	}
}
