import axios from "axios";

import { apiErrorCode, apiErrorMessage } from "./api";
import type { StringKey } from "./i18n";
import { MediaPermissionError } from "./media";

/**
 * What to tell a person when an action failed, in their UI language.
 *
 * Branches on the API's error `code`, never its message (§1). The server's
 * messages are English-only, so they are used only for the codes that mean
 * "your input was wrong" and only when the UI is in English; everything else
 * gets one of our own translated sentences.
 */
export function friendlyError(
	cause: unknown,
	t: (key: StringKey) => string,
	language: "en" | "hi",
): string {
	if (cause instanceof MediaPermissionError)
		return t("content.permissionDenied");

	if (axios.isAxiosError(cause) && !cause.response) return t("common.offline");

	switch (apiErrorCode(cause)) {
		case "CONFLICT":
		case "NOT_FOUND":
			return t("common.noLongerAvailable");
		case "RATE_LIMITED":
			return t("common.tooManyRequests");
		case "BAD_REQUEST":
		case "UNPROCESSABLE":
			return language === "en"
				? apiErrorMessage(cause, t("common.somethingWrong"))
				: t("common.somethingWrong");
		default:
			return t("common.somethingWrong");
	}
}

/** True when the item can no longer be saved — held or removed (§7). */
export function isGone(cause: unknown): boolean {
	const code = apiErrorCode(cause);
	return code === "CONFLICT" || code === "NOT_FOUND";
}
