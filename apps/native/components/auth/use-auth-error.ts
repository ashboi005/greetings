import axios from "axios";

import { apiErrorCode } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import { FirebaseAuthError } from "@/lib/firebase";
import { type StringKey, useI18n } from "@/lib/i18n";

/**
 * Firebase failure codes → a sentence in the person's UI language.
 *
 * lib/firebase.ts already maps these to English; this is the same table for
 * the screen, so a Hindi reader is not handed an English error at the one
 * moment they are most likely to give up.
 */
const CODE_KEYS: Record<string, StringKey> = {
	"auth/invalid-phone-number": "auth.errInvalidPhone",
	"auth/missing-phone-number": "auth.errInvalidPhone",
	"auth/quota-exceeded": "auth.errTooMany",
	"auth/too-many-requests": "auth.errTooMany",
	"auth/invalid-verification-code": "auth.errWrongCode",
	"auth/code-expired": "auth.errCodeExpired",
	"auth/session-expired": "auth.errCodeExpired",
	"auth/captcha-check-failed": "auth.errDeviceCheck",
	"auth/app-not-authorized": "auth.errDeviceCheck",
	"auth/invalid-email": "auth.errInvalidEmail",
	"auth/email-already-in-use": "auth.errEmailInUse",
	"auth/weak-password": "auth.errWeakPassword",
	"auth/missing-password": "auth.errEnterPassword",
	"auth/invalid-credential": "auth.errWrongCredentials",
	"auth/wrong-password": "auth.errWrongCredentials",
	"auth/user-not-found": "auth.errWrongCredentials",
	"auth/user-disabled": "auth.errDisabled",
	"auth/operation-not-allowed": "auth.errMethodOff",
	"auth/account-exists-with-different-credential": "auth.errOtherMethod",
	"auth/network-request-failed": "common.offline",
	"auth/email-not-verified": "auth.errEmailNotVerified",
};

/** Returns a function that turns any sign-in failure into one sentence. */
export function useAuthError() {
	const { t, language } = useI18n();

	return (cause: unknown): string => {
		if (cause instanceof FirebaseAuthError) {
			const key = CODE_KEYS[cause.code];
			if (key) return t(key);
			return language === "en" ? cause.message : t("auth.errGeneric");
		}
		// The exchange with our own API failed rather than Firebase.
		if (axios.isAxiosError(cause) && !cause.response)
			return t("common.offline");
		if (apiErrorCode(cause) === "RATE_LIMITED") {
			return t("common.tooManyRequests");
		}
		return language === "en" ? authErrorMessage(cause) : t("auth.errGeneric");
	};
}
