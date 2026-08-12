import { forbidden } from "./errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects unsafe browser requests that authenticate with a cookie unless their
 * Origin is one of the application's own origins. CORS only controls whether a
 * browser may read a response; it does not stop a cross-site form from causing
 * the mutation in the first place.
 *
 * Bearer clients do not rely on ambient browser credentials and therefore do
 * not need an Origin header. Better Auth is excluded because it owns the CSRF
 * contract for its own routes.
 */
export function assertSafeCookieMutation(
	request: Request,
	trustedOrigins: ReadonlySet<string>,
): void {
	if (SAFE_METHODS.has(request.method)) return;

	const pathname = new URL(request.url).pathname;
	if (pathname.startsWith("/api/auth/")) return;

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
