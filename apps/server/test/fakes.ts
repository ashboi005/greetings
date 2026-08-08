/**
 * Test doubles for the ports that reach outside the process (spec §12).
 *
 * The whole suite runs hermetically: no network, no Google, no Firebase.
 */

import { unauthenticated } from "../src/lib/errors";
import type { ObjectStorage, StoredObject } from "../src/lib/storage";
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

/**
 * In-memory ObjectStorage.
 *
 * Presigned URLs are fake but structurally honest — distinct per key, and
 * carrying the method — so tests can assert a URL was handed out without a
 * network call. `putObject` simulates the client's direct PUT to R2, which is
 * the step the server never sees.
 */
export function fakeObjectStorage() {
	const objects = new Map<string, StoredObject>();
	const deleted: string[] = [];
	let failDeletes = false;

	const storage: ObjectStorage = {
		presignUpload({ key, contentType, expiresInSeconds }) {
			return `https://fake-r2.test/${key}?method=PUT&type=${encodeURIComponent(contentType)}&expires=${expiresInSeconds}`;
		},

		presignDownload({ key, expiresInSeconds }) {
			return `https://fake-r2.test/${key}?method=GET&expires=${expiresInSeconds}`;
		},

		async stat(key) {
			return objects.get(key) ?? null;
		},

		async list(prefix) {
			return [...objects.keys()].filter((key) => key.startsWith(prefix));
		},

		async delete(key) {
			if (failDeletes) throw new Error("simulated storage failure");
			objects.delete(key);
			deleted.push(key);
		},
	};

	return {
		storage,
		/** Stands in for the client PUTting the file straight to R2. */
		putObject(key: string, object: Partial<StoredObject> = {}) {
			objects.set(key, {
				size: object.size ?? 2048,
				contentType: object.contentType ?? "image/jpeg",
			});
			return key;
		},
		has: (key: string) => objects.has(key),
		deletedKeys: () => [...deleted],
		/** Forces deletes to throw, to exercise the cleanup job's failure path. */
		breakDeletes(broken = true) {
			failDeletes = broken;
		},
		reset() {
			objects.clear();
			deleted.length = 0;
			failDeletes = false;
		},
	};
}
