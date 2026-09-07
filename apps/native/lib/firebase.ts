/**
 * Firebase — the app's only identity provider.
 *
 * Three ways in, all of them Firebase, all of them ending in the same place: an
 * ID token that `contexts/auth-context.tsx` trades once at
 * `POST /v1/auth/firebase` for the session token the rest of the app carries.
 *
 *   phone  → OTP
 *   email  → password
 *   Google → native account picker
 *
 * Nothing here talks to our API, and there is no Better Auth client in this app
 * — the panels have one, we do not.
 *
 * `@react-native-firebase/auth` rather than the `firebase` JS SDK: the JS phone
 * flow is built on reCAPTCHA in a WebView. The native module uses silent APNs on
 * iOS and Play Integrity on Android instead. It does mean the app cannot run in
 * Expo Go — see docs/firebase-setup.md.
 */

import auth, { type FirebaseAuthTypes } from "@react-native-firebase/auth";
import {
	GoogleSignin,
	isCancelledResponse,
	isSuccessResponse,
	statusCodes,
} from "@react-native-google-signin/google-signin";
import Constants from "expo-constants";

/**
 * A sign-in failure with a message already fit to show someone.
 *
 * Firebase reports failures as codes like `auth/invalid-phone-number`. Those
 * belong in a log, not on a screen, so mapping happens here — once — rather
 * than in whichever component happened to make the call.
 */
export class FirebaseAuthError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "FirebaseAuthError";
		this.code = code;
	}
}

/**
 * Raised when an email account exists but its address has never been confirmed.
 *
 * Its own type because it is the one failure with a *next step* rather than a
 * correction: the screen offers to resend the mail instead of asking the person
 * to fix their input. See `signInWithEmail`.
 */
export class EmailNotVerifiedError extends FirebaseAuthError {
	constructor() {
		super(
			"auth/email-not-verified",
			"Confirm your email address first — check your inbox for the link.",
		);
		this.name = "EmailNotVerifiedError";
	}
}

const MESSAGES: Record<string, string> = {
	// Phone
	"auth/invalid-phone-number": "That does not look like a valid phone number.",
	"auth/missing-phone-number": "Enter your phone number.",
	"auth/quota-exceeded": "Too many codes requested. Try again later.",
	"auth/invalid-verification-code":
		"That code is not right. Check it and try again.",
	"auth/code-expired": "That code has expired. Request a new one.",
	"auth/session-expired": "That code has expired. Request a new one.",
	"auth/captcha-check-failed":
		"This device could not be verified. Try again, or use another device.",

	// Email and password
	"auth/invalid-email": "That does not look like a valid email address.",
	"auth/email-already-in-use":
		"An account already exists for that email. Sign in instead.",
	"auth/weak-password": "Use a longer password — at least eight characters.",
	"auth/missing-password": "Enter your password.",
	// Firebase returns invalid-credential for both a wrong password and an
	// unknown address when email enumeration protection is on, which is the
	// default. Saying which one it was would defeat the protection.
	"auth/invalid-credential": "That email or password is not right.",
	"auth/wrong-password": "That email or password is not right.",
	"auth/user-not-found": "That email or password is not right.",
	"auth/user-disabled": "That account has been disabled.",
	"auth/operation-not-allowed":
		"That sign-in method is not enabled for this app.",

	// Google
	"auth/account-exists-with-different-credential":
		"You already have an account with that email. Sign in the way you did before.",

	// Shared
	"auth/too-many-requests":
		"Too many attempts from this device. Wait a few minutes and try again.",
	"auth/network-request-failed":
		"Could not reach the network. Check your connection.",
	"auth/app-not-authorized":
		"This build is not registered with Firebase. Tell the developer.",
};

const FALLBACK = "Could not sign you in. Try again.";

/**
 * Google's own failure codes, which are not `auth/*` strings.
 *
 * Looked up here rather than folded into `MESSAGES` because their values come
 * from the native module at runtime — they are platform-specific numbers on
 * Android and different strings on iOS — so they cannot be map keys written by
 * hand, and a computed key would silently collide if the module returned
 * nothing.
 */
function googleStatusMessage(code: string): string | null {
	switch (code) {
		case statusCodes.PLAY_SERVICES_NOT_AVAILABLE:
			return "Google Play Services is unavailable or out of date on this device.";
		case statusCodes.IN_PROGRESS:
			return "A sign-in is already in progress.";
		default:
			return null;
	}
}

function toAuthError(cause: unknown): FirebaseAuthError {
	if (cause instanceof FirebaseAuthError) return cause;

	const code =
		typeof cause === "object" && cause !== null && "code" in cause
			? String((cause as { code: unknown }).code)
			: "auth/unknown";

	const message = MESSAGES[code] ?? googleStatusMessage(code) ?? FALLBACK;

	return new FirebaseAuthError(code, message);
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/**
 * TODO(phone-native-setup): phone OTP works on a dev build against Firebase's
 * test numbers, and nothing more, until the per-platform verification is set up.
 *
 * Firebase has to prove the *app* is genuine before it will send an SMS, and
 * that proof is platform-specific and outside this codebase:
 *
 *   Android — register the signing certificate's SHA-1 and SHA-256 on the
 *     Firebase Android app, then re-download google-services.json. Needed once
 *     for the debug keystore, again for the release/upload key, and again for
 *     Play App Signing's key once the app is on Play. Without it, Play Integrity
 *     fails and sign-in returns `auth/app-not-authorized`.
 *
 *   iOS — upload an APNs auth key (.p8) to Firebase → Cloud Messaging, and
 *     enable the Push Notifications capability on the App ID. Firebase verifies
 *     by silent push. Without it, iOS falls back to a reCAPTCHA web challenge,
 *     which works but looks wrong.
 *
 * Until then: **develop against Firebase's test phone numbers** (Authentication
 * → Sign-in method → Phone → "Phone numbers for testing"). A fixed code, no SMS
 * sent, works in the simulator and on an emulator, needs neither of the above,
 * and costs no quota.
 *
 * Email and Google sign-in need none of this and work on a dev build today.
 *
 * Steps are written out in docs/firebase-setup.md §2.5 and §2.6.
 */

/** A code has been sent and is waiting to be confirmed. */
export interface PendingVerification {
	/** E.164 number the code went to, for display on the confirm screen. */
	phoneNumber: string;
	confirm(code: string): Promise<string>;
}

/**
 * Normalises a typed number to E.164, assuming India when no country is given.
 *
 * Firebase rejects anything that is not E.164, and people type their number the
 * way they say it: `98765 43210`, `098765 43210`, `+91 98765-43210`. Defaulting
 * to +91 is a product decision, not a technical one — this is an India-first
 * app — and an explicit `+` always wins, so someone abroad is never rewritten.
 *
 * Returns null when the result cannot be a phone number, so the caller can say
 * so before spending a Firebase quota unit on it.
 */
export function toE164(
	input: string,
	defaultCallingCode = "91",
): string | null {
	const trimmed = input.trim();
	if (trimmed.length === 0) return null;

	if (trimmed.startsWith("+")) {
		const digits = trimmed.slice(1).replace(/\D/g, "");
		// E.164 allows at most 15 digits, and a country code plus a subscriber
		// number is never shorter than about eight.
		return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
	}

	let digits = trimmed.replace(/\D/g, "");

	// A leading trunk zero is how the number is dialled domestically and is not
	// part of the international form.
	if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");

	// Already carries the calling code, e.g. someone typed 919876543210.
	if (digits.startsWith(defaultCallingCode) && digits.length > 10) {
		digits = digits.slice(defaultCallingCode.length);
	}

	if (digits.length !== 10) return null;

	return `+${defaultCallingCode}${digits}`;
}

/**
 * Sends a verification code and returns the handle that confirms it.
 *
 * `phoneNumber` must already be E.164 — run it through `toE164` first.
 */
export async function sendVerificationCode(
	phoneNumber: string,
): Promise<PendingVerification> {
	let confirmation: FirebaseAuthTypes.ConfirmationResult;

	try {
		confirmation = await auth().signInWithPhoneNumber(phoneNumber);
	} catch (cause) {
		throw toAuthError(cause);
	}

	return {
		phoneNumber,
		async confirm(code: string): Promise<string> {
			try {
				const credential = await confirmation.confirm(code);

				// Firebase resolves with null when the code was wrong rather than
				// rejecting, so this is a failure path and not a defensive check.
				if (!credential?.user) {
					throw new FirebaseAuthError(
						"auth/invalid-verification-code",
						MESSAGES["auth/invalid-verification-code"] as string,
					);
				}

				// Freshly minted by the confirm above, so no force-refresh.
				return await credential.user.getIdToken();
			} catch (cause) {
				throw toAuthError(cause);
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Email and password
// ---------------------------------------------------------------------------

/**
 * Signs in with an email and password, requiring a confirmed address.
 *
 * **The verification check is not optional politeness.** The server stores a
 * placeholder address, `<uid>@firebase.placeholder`, for any identity whose
 * email it cannot trust, and it will only link accounts on a *verified* one.
 * That rule exists so nobody can claim someone else's account by signing up
 * with their address — but it also means an unverified email account would land
 * with a placeholder for an email and be unfindable by the address its owner
 * typed. Confirming first is what makes email sign-in work properly at all.
 *
 * Firebase sends the mail, so this costs us no email infrastructure — which is
 * the reason the *panels* have no verification step and this does.
 */
export async function signInWithEmail(
	email: string,
	password: string,
): Promise<string> {
	try {
		const credential = await auth().signInWithEmailAndPassword(
			email.trim(),
			password,
		);

		if (!credential.user.emailVerified) {
			throw new EmailNotVerifiedError();
		}

		return await credential.user.getIdToken();
	} catch (cause) {
		throw toAuthError(cause);
	}
}

/**
 * Creates an email account and sends its confirmation link.
 *
 * Deliberately returns nothing rather than a token: the account exists but is
 * not usable until the link is followed, so there is no session to hand back.
 * The caller shows "check your inbox" and waits.
 */
export async function signUpWithEmail(
	email: string,
	password: string,
): Promise<void> {
	try {
		const credential = await auth().createUserWithEmailAndPassword(
			email.trim(),
			password,
		);
		await credential.user.sendEmailVerification();

		// Signed out again on purpose. Firebase leaves the new account signed in,
		// and leaving it that way means an unverified `currentUser` sitting there
		// able to mint ID tokens — exactly what the verification gate is for.
		await auth().signOut();
	} catch (cause) {
		throw toAuthError(cause);
	}
}

/**
 * Re-sends the confirmation link for an email and password just given.
 *
 * Firebase will only send it for the *signed-in* user, and the sign-in above
 * deliberately leaves nobody signed in. So this signs in, sends, and signs out
 * again — which also means a wrong password reports itself here rather than
 * silently doing nothing.
 */
export async function resendEmailVerification(
	email: string,
	password: string,
): Promise<void> {
	try {
		const credential = await auth().signInWithEmailAndPassword(
			email.trim(),
			password,
		);

		if (credential.user.emailVerified) return;

		await credential.user.sendEmailVerification();
	} catch (cause) {
		throw toAuthError(cause);
	} finally {
		await auth().signOut();
	}
}

/** Sends a password reset link. Firebase owns the mail and the reset page. */
export async function sendPasswordReset(email: string): Promise<void> {
	try {
		await auth().sendPasswordResetEmail(email.trim());
	} catch (cause) {
		throw toAuthError(cause);
	}
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

let googleConfigured = false;

/**
 * The web OAuth client ID, read straight out of `google-services.json`.
 *
 * `app.config.ts` pulls it from that file at build time and puts it here, so
 * there is nothing to paste into an `.env` and nothing that can drift from the
 * config files Firebase actually gave us. Undefined until Google sign-in is
 * enabled in the console, since enabling it is what creates the OAuth clients.
 */
const GOOGLE_WEB_CLIENT_ID = Constants.expoConfig?.extra?.googleWebClientId as
	| string
	| undefined;

/**
 * Whether Google sign-in can be offered at all on this build.
 *
 * The web client ID is what makes the Google account picker's token usable as a
 * Firebase credential, and `configure()` has to be given it from JS — the
 * native config files are not readable at runtime. Unset, the button is hidden
 * rather than shown and then failing.
 */
export function isGoogleSignInAvailable(): boolean {
	return Boolean(GOOGLE_WEB_CLIENT_ID);
}

function configureGoogle(): void {
	if (googleConfigured) return;

	GoogleSignin.configure({
		webClientId: GOOGLE_WEB_CLIENT_ID,
		// email and profile are the defaults and all the server reads.
		// `offlineAccess` is off: it exists to get a refresh token for calling
		// Google's APIs as the user later, and nothing here does that.
		offlineAccess: false,
	});

	googleConfigured = true;
}

/**
 * Signs in with a Google account.
 *
 * Resolves to null when the person dismissed the picker. That is not an error
 * and must not be shown as one — it is the most common way this ends.
 */
export async function signInWithGoogle(): Promise<string | null> {
	if (!isGoogleSignInAvailable()) {
		throw new FirebaseAuthError(
			"auth/google-not-configured",
			"Google sign-in is not set up in this build.",
		);
	}

	try {
		configureGoogle();
		await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

		const response = await GoogleSignin.signIn();

		if (isCancelledResponse(response)) return null;
		if (!isSuccessResponse(response)) return null;

		const googleIdToken = response.data.idToken;
		if (!googleIdToken) {
			throw new FirebaseAuthError(
				"auth/missing-google-id-token",
				"Google did not return an identity token. Check the web client ID.",
			);
		}

		// Two different tokens, and mixing them up is the classic bug here. The
		// one Google just returned proves who they are to *Google*; exchanging it
		// for a Firebase credential is what produces a token our server will
		// accept, because the server only trusts Firebase's issuer.
		const credential = auth.GoogleAuthProvider.credential(googleIdToken);
		const result = await auth().signInWithCredential(credential);

		return await result.user.getIdToken();
	} catch (cause) {
		throw toAuthError(cause);
	}
}

// ---------------------------------------------------------------------------
// Sign-out
// ---------------------------------------------------------------------------

/**
 * Drops the Firebase session, and Google's if there is one.
 *
 * Called alongside clearing our own token: leaving Firebase signed in would
 * keep a `currentUser` around whose ID token still mints a fresh session at the
 * exchange endpoint, so a "signed out" app could silently sign itself back in.
 *
 * Google is signed out too, or the next sign-in silently reuses the same account
 * without showing the picker — which reads as "I can't switch accounts".
 */
export async function signOutOfFirebase(): Promise<void> {
	try {
		if (auth().currentUser) await auth().signOut();
	} catch {
		// Best-effort. Our own token is already gone, which is what actually ends
		// the session; failing here must not block the UI.
	}

	try {
		if (isGoogleSignInAvailable()) {
			configureGoogle();
			await GoogleSignin.signOut();
		}
	} catch {
		// Same reasoning. Also throws when nobody was signed in with Google.
	}
}
