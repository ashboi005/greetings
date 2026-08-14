import { forbidden } from "./errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects unsafe browser requests that authenticate with a cookie unless their
 * Origin is one of the application's own origins. CORS only controls whether a
 * browser may read a response; it does not stop a cross-site form from causing
 * the mutation in the first place.
 *
 * Bearer clients do not rely on ambient browser credentials and therefore do
 * not need an Origin header.
 *
 * This covers Better Auth's own routes too. That exemption was tried and
 * removed: a cross-site POST to /api/auth/sign-out was accepted, so an attacker
 * page could log an administrator out at will. Nuisance rather than danger, but
 * the exemption was buying nothing. Sign-in and the OAuth callback are
 * unaffected — the callback is a GET, and the panel's sign-in POST carries its
 * own Origin.
 */
export function assertSafeCookieMutation(
	request: Request,
	trustedOrigins: ReadonlySet<string>,
): void {
	if (SAFE_METHODS.has(request.method)) return;

	if (!request.headers.has("cookie")) return;
	if (request.headers.get("authorization")?.startsWith("Bearer ")) return;

	const origin = request.headers.get("origin");
	let normalizedOrigin: string | null = null;
	try {
		normalizedOrigin = origin ? new URL(origin).origin : null;
	} catch {
		// A malformed Origin is untrusted, just like a missing one.
	}

	if (!normalizedOrigin || !trustedOrigins.has(normalizedOrigin)) {
		throw forbidden("Cross-site cookie-authenticated request refused.");
	}
}
