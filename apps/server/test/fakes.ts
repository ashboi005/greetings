/**
 * Test doubles for the ports that reach outside the process (spec §12).
 *
 * The whole suite runs hermetically: no network, no Google, no Firebase.
 */

import { unauthenticated } from "../src/lib/errors";
import type {
	TokenVerifier,
	VerifiedIdentity,
} from "../src/lib/token-verifier";

/**
 * A TokenVerifier that resolves tokens registered ahead of time.
 *
 * Deliberately rejects anything unregistered rather than accepting all input,
 * so a test that forgets to register a token fails loudly instead of silently
 * authenticating a stranger.
 */
export function fakeTokenVerifier() {
	const identities = new Map<string, VerifiedIdentity>();

	const verifier: TokenVerifier = {
		async verify(idToken: string): Promise<VerifiedIdentity> {
			const identity = identities.get(idToken);
			if (!identity) {
				throw unauthenticated("Invalid or expired Firebase ID token");
			}
			return identity;
		},
	};

	return {
		verifier,
		/** Registers a token and returns it, for use as a bearer of identity. */
		register(token: string, identity: Partial<VerifiedIdentity> = {}) {
			identities.set(token, {
				subject: identity.subject ?? `firebase-uid-${token}`,
				email: identity.email,
				emailVerified: identity.emailVerified ?? false,
				phone: identity.phone,
				name: identity.name,
				picture: identity.picture,
			});
			return token;
		},
		reset() {
			identities.clear();
		},
	};
}
