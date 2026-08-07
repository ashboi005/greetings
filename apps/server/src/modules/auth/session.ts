/**
 * Session resolution and role enforcement (spec §11.3).
 *
 * Every non-public endpoint carries an explicit role requirement. There is no
 * default-allow path: a route either declares `requireRole` or is public by
 * deliberate choice.
 */

import { auth } from "@greetings/auth";
import { USER_ROLES, type UserRole } from "@greetings/db/schema";
import { Elysia } from "elysia";
import { forbidden, unauthenticated } from "../../lib/errors";

export interface CurrentUser {
	id: string;
	email: string;
	name: string;
	role: UserRole;
}

/**
 * Resolves the caller from the request, or null when unauthenticated.
 *
 * Better Auth reads either the session cookie (web) or the bearer token
 * (mobile), so both front doors converge here.
 *
 * The role comes from the session payload, which already carries it as a
 * Better Auth additional field — no second query. With `session.cookieCache`
 * enabled (packages/auth) a web request resolves entirely from the signed
 * cookie and touches no database at all.
 *
 * The cost is that a role change is not visible to sessions issued before it.
 * `revokeUserSessions` closes that gap: every role change deletes the target's
 * sessions, so the next request has to re-authenticate and picks up the new
 * role. Staleness is therefore bounded by the cookie cache TTL, not by the
 * session lifetime.
 */
type BetterAuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * Resolves the Better Auth session at most once per request.
 *
 * Each `getSession` is two queries (the session row, then the user row), and
 * several things want the session on a single request: the authorisation
 * guard, mounted by every route module, and the request logger. Without this
 * they each pay for their own lookup. Keyed on the Request object, so entries
 * are collected with it.
 */
const perRequest = new WeakMap<Request, Promise<BetterAuthSession>>();

export function getSessionOnce(request: Request): Promise<BetterAuthSession> {
	const cached = perRequest.get(request);
	if (cached) return cached;

	const pending = auth.api.getSession({ headers: request.headers });
	perRequest.set(request, pending);
	return pending;
}

export async function resolveCurrentUserOnce(
	request: Request,
): Promise<CurrentUser | null> {
	return toCurrentUser(await getSessionOnce(request));
}

export async function resolveCurrentUser(
	headers: Headers,
): Promise<CurrentUser | null> {
	return toCurrentUser(await auth.api.getSession({ headers }));
}

function toCurrentUser(session: BetterAuthSession): CurrentUser | null {
	if (!session?.user?.id) return null;

	const { id, email, name, role } = session.user;

	return {
		id,
		email,
		name,
		// Defensive: the column is an enum and the field is `input: false`, so
		// an unknown value should be impossible. Failing closed to the least
		// privileged role beats trusting an unrecognised string.
		role: isUserRole(role) ? role : "user",
	};
}

function isUserRole(value: unknown): value is UserRole {
	return (
		typeof value === "string" &&
		(USER_ROLES as readonly string[]).includes(value)
	);
}

/**
 * Elysia plugin exposing `requireRole` as a route-level guard.
 *
 * Usage:
 *   .get("/designer/thing", handler, { requireRole: ["designer"] })
 *
 * Passing an empty array means "any signed-in user", which is different from
 * omitting the guard entirely (public).
 */
export const authGuard = new Elysia({ name: "auth-guard" })
	.derive({ as: "global" }, async ({ request }) => ({
		currentUser: await resolveCurrentUserOnce(request),
	}))
	.macro({
		requireRole(allowed: UserRole[] | true) {
			return {
				beforeHandle({ currentUser }: { currentUser: CurrentUser | null }) {
					if (!currentUser) {
						throw unauthenticated();
					}
					// `true` means any authenticated user.
					if (allowed === true) return;
					if (!allowed.includes(currentUser.role)) {
						throw forbidden(
							`This endpoint requires one of: ${allowed.join(", ")}.`,
						);
					}
				},
			};
		},
	});

/**
 * Narrows `currentUser` to non-null inside a handler.
 *
 * `requireRole` has already rejected anonymous callers, so this never fires in
 * practice — but it means a route that forgets its guard returns 401 rather
 * than dereferencing null, and it keeps handlers free of `!` assertions.
 */
export function requireUser(currentUser: CurrentUser | null): CurrentUser {
	if (!currentUser) throw unauthenticated();
	return currentUser;
}

/** Roles permitted to use the web panels at all (spec §1.1). */
export const WEB_ROLES: UserRole[] = ["designer", "admin", "super_admin"];
