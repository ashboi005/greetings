import { apiErrorMessage } from "./api";
import { FirebaseAuthError } from "./firebase";

/**
 * One sentence for any sign-in failure, whichever half of the flow it came from.
 *
 * A sign-in crosses two systems — Firebase on the device, then our exchange
 * endpoint — and each reports failure in its own shape. Every auth screen needs
 * exactly this, so it lives here once instead of in each of them.
 */
export function authErrorMessage(cause: unknown): string {
	if (cause instanceof FirebaseAuthError) return cause.message;
	return apiErrorMessage(cause, "Could not sign you in. Try again.");
}
