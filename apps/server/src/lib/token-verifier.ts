/**
 * Verification of third-party identity tokens (spec §11.3).
 *
 * A port, so the sign-in flow can be tested without reaching Google. The
 * Firebase adapter is the only implementation that talks to the network; tests
 * use `fakeTokenVerifier` from test/fakes.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { AppError, unauthenticated } from "./errors";

/** The identity we are willing to trust after verifying a token. */
export interface VerifiedIdentity {
	/** Stable provider-side user id — Firebase's `sub`. */
	subject: string;
	email?: string;
	emailVerified: boolean;
	phone?: string;
	name?: string;
	picture?: string;
}

export interface TokenVerifier {
	verify(idToken: string): Promise<VerifiedIdentity>;
}

/** Google's published keys for Firebase ID tokens. */
const FIREBASE_JWKS_URL = new URL(
	"https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
);

/**
 * Verifies Firebase ID tokens against Google's public keys.
 *
 * `jose` rather than `firebase-admin`: signature verification is all this
 * needs, and it avoids pulling a service-account credential into the server.
 * The JWKS is cached and refreshed by `createRemoteJWKSet`.
 */
export function createFirebaseTokenVerifier(projectId: string): TokenVerifier {
	if (!projectId) {
		throw new Error(
			"FIREBASE_PROJECT_ID is required to verify mobile sign-in tokens.",
		);
	}

	const jwks = createRemoteJWKSet(FIREBASE_JWKS_URL);

	return {
		async verify(idToken: string): Promise<VerifiedIdentity> {
			if (!idToken) {
				throw unauthenticated("Missing Firebase ID token");
			}

			let payload: Record<string, unknown>;
			try {
				// issuer and audience are asserted here rather than after the
				// fact: a token minted for a different Firebase project is
				// perfectly valid, just not for us.
				({ payload } = await jwtVerify(idToken, jwks, {
					issuer: `https://securetoken.google.com/${projectId}`,
					audience: projectId,
				}));
			} catch (cause) {
				// The underlying message names key ids and clock skew; useful in
				// the log, meaningless and noisy to a client.
				console.warn("Firebase token verification failed:", cause);
				throw unauthenticated("Invalid or expired Firebase ID token");
			}

			const subject = typeof payload.sub === "string" ? payload.sub : "";
			if (!subject) {
				throw unauthenticated("Firebase token has no subject");
			}

			return {
				subject,
				email: asOptionalString(payload.email),
				emailVerified: payload.email_verified === true,
				phone: asOptionalString(payload.phone_number),
				name: asOptionalString(payload.name),
				picture: asOptionalString(payload.picture),
			};
		},
	};
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolves the verifier for this process, failing loudly when mobile sign-in
 * is used without configuration rather than at import time — the server must
 * still boot for work that does not touch mobile auth.
 */
export function requireTokenVerifier(
	projectId: string | undefined,
	override?: TokenVerifier,
): TokenVerifier {
	if (override) return override;
	if (!projectId) {
		throw new AppError(
			"INTERNAL",
			"Mobile sign-in is not configured on this server (FIREBASE_PROJECT_ID is unset).",
		);
	}
	return createFirebaseTokenVerifier(projectId);
}
